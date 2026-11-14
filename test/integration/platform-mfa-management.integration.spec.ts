import { randomBytes, randomUUID } from 'node:crypto';

import { jest } from '@jest/globals';
import { Test, type TestingModule } from '@nestjs/testing';

import { DatabaseModule } from '../../src/database/database.module.js';
import { PrismaService } from '../../src/database/prisma.service.js';
import { PlatformStaffStatus, UserStatus } from '../../src/generated/prisma/client.js';
import { PlatformAdminTestFixtures } from './platform-admin-test-fixtures.js';
import {
	assertDevelopmentDatabaseWasVerified,
	loadDevelopmentDatabaseConfig,
	verifyDevelopmentDatabaseSafety,
	type VerifiedDevelopmentDatabase,
} from './development-database-safety.js';

const config = loadDevelopmentDatabaseConfig();
const OPTIONS = { maxWait: 10_000, timeout: 15_000 } as const;
jest.setTimeout(60_000);

describe('platform MFA management PostgreSQL integrity (guarded development)', () => {
	let module: TestingModule;
	let prisma: PrismaService;
	let verified: VerifiedDevelopmentDatabase | undefined;
	let fixtures: PlatformAdminTestFixtures;
	beforeAll(async () => {
		module = await Test.createTestingModule({
			imports: [
				DatabaseModule.forRoot({
					databaseUrl: config.databaseUrl,
					poolMax: 2,
					connectionTimeoutMilliseconds: 10_000,
				}),
			],
		}).compile();
		await module.init();
		prisma = module.get(PrismaService);
		verified = await verifyDevelopmentDatabaseSafety(prisma, config);
	});
	beforeEach(() => {
		assertDevelopmentDatabaseWasVerified(verified);
		fixtures = new PlatformAdminTestFixtures();
	});
	afterEach(async () => {
		if (verified !== undefined) await fixtures.cleanup(prisma, verified);
	});
	afterAll(async () => {
		await module.close();
	});

	async function account() {
		const now = new Date();
		const staffId = fixtures.reservePlatformStaffId();
		const user = await prisma.user.create({
			data: {
				id: fixtures.reserveUserId(),
				email: `mfa.${randomUUID()}@example.com`,
				displayName: 'Fictional Platform Owner',
				status: UserStatus.ACTIVE,
				emailVerifiedAt: now,
				platformStaff: { create: { id: staffId, status: PlatformStaffStatus.ACTIVE } },
			},
		});
		const factor = await prisma.platformTotpCredential.create({
			data: {
				id: fixtures.reservePlatformTotpCredentialId(),
				platformStaffId: staffId,
				label: 'Work',
				encryptedSecret: Buffer.alloc(32, 1),
				encryptionKeyId: 'synthetic-key-v1',
				initializationVector: Buffer.alloc(12, 2),
				authenticationTag: Buffer.alloc(16, 3),
				verifiedAt: now,
				lastAcceptedTimeStep: 100n,
			},
		});
		const staff = await prisma.platformStaff.findUniqueOrThrow({ where: { id: staffId } });
		const session = await prisma.platformAdminSession.create({
			data: {
				id: fixtures.reservePlatformAdminSessionId(),
				platformStaffId: staffId,
				authenticationMethod: 'totp',
				mfaVersion: staff.mfaVersion,
				tokenDigest: randomBytes(32).toString('hex'),
				createdAt: now,
				lastSeenAt: now,
				mfaVerifiedAt: now,
				expiresAt: new Date(now.getTime() + 300_000),
				idleExpiresAt: new Date(now.getTime() + 120_000),
			},
		});
		const code = await prisma.platformRecoveryCode.create({
			data: {
				id: fixtures.reservePlatformRecoveryCodeId(),
				platformStaffId: staffId,
				generation: staff.recoveryGeneration,
				digestVersion: 2,
				codeDigest: randomBytes(32).toString('hex'),
			},
		});
		return { user, staff, factor, session, code, now };
	}

	it('denies both disabling and deleting the final authenticator', async () => {
		const { factor } = await account();
		await expect(
			prisma.platformTotpCredential.update({
				where: { id: factor.id },
				data: { disabledAt: new Date() },
			}),
		).rejects.toThrow(/final platform authenticator cannot be removed/u);
		await expect(
			prisma.platformTotpCredential.delete({ where: { id: factor.id } }),
		).rejects.toThrow(/final platform authenticator cannot be removed/u);
		expect(
			await prisma.platformTotpCredential.findUnique({ where: { id: factor.id } }),
		).toMatchObject({ version: 1, disabledAt: null });
	});

	it('changes only the label during a rename and preserves assurance and replay state', async () => {
		const { factor, session } = await account();
		await prisma.platformTotpCredential.update({
			where: { id: factor.id },
			data: { label: 'Personal' },
		});
		expect(
			await prisma.platformTotpCredential.findUnique({ where: { id: factor.id } }),
		).toMatchObject({ label: 'Personal', version: 1, lastAcceptedTimeStep: 100n });
		expect(
			await prisma.platformAdminSession.findUnique({ where: { id: session.id } }),
		).toMatchObject({ revokedAt: null });
	});

	it('lets only one concurrent replacement win and invalidates the old session and code set', async () => {
		const { staff, factor, session, code } = await account();
		const replace = (value: number) =>
			prisma.platformTotpCredential.updateMany({
				where: { id: factor.id, version: 1 },
				data: {
					encryptedSecret: Buffer.alloc(32, value),
					lastAcceptedTimeStep: 101n,
					verifiedAt: new Date(),
				},
			});
		const results = await Promise.all([replace(4), replace(5)]);
		expect(results.map(({ count }) => count).sort()).toEqual([0, 1]);
		expect(
			await prisma.platformTotpCredential.findUnique({ where: { id: factor.id } }),
		).toMatchObject({ version: 2 });
		expect(await prisma.platformStaff.findUnique({ where: { id: staff.id } })).toMatchObject({
			mfaVersion: staff.mfaVersion + 1,
			recoveryGeneration: staff.recoveryGeneration + 1,
		});
		expect(
			await prisma.platformAdminSession.findUnique({ where: { id: session.id } }),
		).toMatchObject({ revocationReason: 'mfa_changed' });
		expect(
			(await prisma.platformRecoveryCode.findUniqueOrThrow({ where: { id: code.id } })).usedAt,
		).not.toBeNull();
	});

	it('rejects management challenges attached to another staff identity’s session', async () => {
		const first = await account();
		const second = await account();
		await expect(
			prisma.platformMfaChallenge.create({
				data: {
					id: fixtures.reservePlatformMfaChallengeId(),
					platformStaffId: first.staff.id,
					platformSessionId: second.session.id,
					purpose: 'step_up',
					operation: 'totp_replace',
					tokenDigest: randomBytes(32).toString('hex'),
					createdAt: first.now,
					expiresAt: new Date(first.now.getTime() + 300_000),
					mfaVersion: first.staff.mfaVersion,
					identityVersion: 1,
					credentialVersion: 1,
					factorVersion: first.factor.version,
					factorId: first.factor.id,
				},
			}),
		).rejects.toMatchObject({ code: 'P2003' });
	});

	it('rejects actionless management proofs and unencrypted enrollment rows', async () => {
		const { staff, factor, session, now } = await account();
		const data = {
			platformStaffId: staff.id,
			platformSessionId: session.id,
			createdAt: now,
			expiresAt: new Date(now.getTime() + 300_000),
			mfaVersion: staff.mfaVersion,
			identityVersion: 1,
			credentialVersion: 1,
			factorVersion: factor.version,
			factorId: factor.id,
		};
		await expect(
			prisma.platformMfaChallenge.create({
				data: {
					...data,
					id: fixtures.reservePlatformMfaChallengeId(),
					purpose: 'step_up',
					operation: null,
					tokenDigest: randomBytes(32).toString('hex'),
				},
			}),
		).rejects.toThrow(/platform_mfa_management_scope_check/u);
		await expect(
			prisma.platformMfaChallenge.create({
				data: {
					...data,
					id: fixtures.reservePlatformMfaChallengeId(),
					purpose: 'enrollment',
					operation: 'totp_replace',
					tokenDigest: randomBytes(32).toString('hex'),
					label: 'Work',
					encryptedSecret: Buffer.alloc(32),
					encryptionKeyId: 'synthetic-key-v1',
					encryptionVersion: 1,
				},
			}),
		).rejects.toThrow(/platform_mfa_pending_secret_check/u);
	});

	it('allows one concurrent recovery consumer and rejects a verifier from the wrong generation', async () => {
		const { staff, code } = await account();
		const consume = (generation: number) =>
			prisma.platformRecoveryCode.updateMany({
				where: { platformStaffId: staff.id, codeDigest: code.codeDigest, generation, usedAt: null },
				data: { usedAt: new Date() },
			});
		expect((await consume(staff.recoveryGeneration + 1)).count).toBe(0);
		const results = await Promise.all([
			consume(staff.recoveryGeneration),
			consume(staff.recoveryGeneration),
		]);
		expect(results.map(({ count }) => count).sort()).toEqual([0, 1]);
	});

	it('allows one concurrent TOTP acceptance while preserving the factor generation', async () => {
		const { staff, factor } = await account();
		const consume = () =>
			prisma.platformTotpCredential.updateMany({
				where: {
					id: factor.id,
					platformStaffId: staff.id,
					version: factor.version,
					disabledAt: null,
					verifiedAt: { not: null },
					lastAcceptedTimeStep: { lt: 101n },
				},
				data: { lastAcceptedTimeStep: 101n, lastUsedAt: new Date() },
			});
		const results = await Promise.all([consume(), consume()]);
		expect(results.map(({ count }) => count).sort()).toEqual([0, 1]);
		expect(
			await prisma.platformTotpCredential.findUnique({ where: { id: factor.id } }),
		).toMatchObject({ version: factor.version, lastAcceptedTimeStep: 101n });
	});

	it('rolls back the factor change, session invalidation and notification if required audit fails', async () => {
		const { user, staff, factor, session, code } = await account();
		await expect(
			prisma.$transaction(async (transaction) => {
				await transaction.platformTotpCredential.update({
					where: { id: factor.id },
					data: { encryptedSecret: Buffer.alloc(32, 9), verifiedAt: new Date() },
				});
				await transaction.platformSecurityNotification.create({
					data: {
						platformStaffId: staff.id,
						recipient: user.email,
						event: 'mfa_factor_replaced',
						requestId: `req_${randomUUID()}`,
					},
				});
				await transaction.identitySecurityAuditEvent.create({
					data: {
						userId: user.id,
						actorUserId: user.id,
						actorKind: 'authentication',
						action: 'mfa_factor_replaced',
						identityVersion: 1,
						requestId: 'invalid',
					},
				});
			}, OPTIONS),
		).rejects.toThrow(/identity_security_audit_events_request_check/u);
		expect(
			await prisma.platformTotpCredential.findUnique({ where: { id: factor.id } }),
		).toMatchObject({ version: 1 });
		expect(
			await prisma.platformAdminSession.findUnique({ where: { id: session.id } }),
		).toMatchObject({ revokedAt: null });
		expect(await prisma.platformRecoveryCode.findUnique({ where: { id: code.id } })).toMatchObject({
			usedAt: null,
		});
		expect(
			await prisma.platformSecurityNotification.count({ where: { platformStaffId: staff.id } }),
		).toBe(0);
	});
});
