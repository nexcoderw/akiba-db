import { randomBytes, randomUUID } from 'node:crypto';

import { jest } from '@jest/globals';
import { Test, type TestingModule } from '@nestjs/testing';

import { DatabaseModule } from '../../src/database/database.module.js';
import { PrismaService } from '../../src/database/prisma.service.js';
import { UserStatus } from '../../src/generated/prisma/client.js';
import { PlatformAdminTestFixtures } from './platform-admin-test-fixtures.js';
import {
	assertDevelopmentDatabaseWasVerified,
	loadDevelopmentDatabaseConfig,
	verifyDevelopmentDatabaseSafety,
	type VerifiedDevelopmentDatabase,
} from './development-database-safety.js';

const config = loadDevelopmentDatabaseConfig();
const OPTIONS = { maxWait: 10_000, timeout: 15_000 } as const;
const HASH = 'synthetic-credential-not-used-for-authentication';
jest.setTimeout(30_000);

describe('identity and credential PostgreSQL integrity (guarded development)', () => {
	let module: TestingModule;
	let prisma: PrismaService;
	let verified: VerifiedDevelopmentDatabase | undefined;
	let fixtures: PlatformAdminTestFixtures;
	const sessionIds = new Set<string>();
	const membershipIds = new Set<string>();
	const organizationIds = new Set<string>();
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
		sessionIds.clear();
		membershipIds.clear();
		organizationIds.clear();
	});
	afterEach(async () => {
		if (verified === undefined) return;
		if (sessionIds.size > 0)
			await prisma.ownerSession.deleteMany({ where: { id: { in: [...sessionIds] } } });
		if (membershipIds.size > 0)
			await prisma.organizationMembership.deleteMany({ where: { id: { in: [...membershipIds] } } });
		if (organizationIds.size > 0)
			await prisma.organization.deleteMany({ where: { id: { in: [...organizationIds] } } });
		await fixtures.cleanup(prisma, verified);
	});
	afterAll(async () => {
		await module.close();
	});

	async function user() {
		return prisma.user.create({
			data: {
				id: fixtures.reserveUserId(),
				email: `identity.${randomUUID()}@example.com`,
				displayName: 'Fictional Owner',
			},
		});
	}

	it('enforces case-insensitive uniqueness during simultaneous identity creation', async () => {
		const address = `race.${randomUUID()}@example.com`;
		const results = await Promise.allSettled(
			[address, address.toUpperCase()].map((email) =>
				prisma.user.create({
					data: { id: fixtures.reserveUserId(), email, displayName: 'Fictional Owner' },
				}),
			),
		);
		expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
		expect(results.find((result) => result.status === 'rejected')).toMatchObject({
			reason: { code: 'P2002' },
		});
	});

	it.each(['unicode.álîce@example.com', 'alice..stock@example.com', 'alice@example.com '])(
		'rejects noncanonical stored identity syntax: %s',
		async (email) => {
			await expect(
				prisma.user.create({
					data: { id: fixtures.reserveUserId(), email, displayName: 'Fictional Owner' },
				}),
			).rejects.toThrow(/users_email_identity_check/u);
		},
	);

	it('preserves raw credentials by default and rejects invalid versions and orphan references', async () => {
		const identity = await user();
		const credential = await prisma.passwordCredential.create({
			data: { id: fixtures.reservePasswordCredentialId(), userId: identity.id, passwordHash: HASH },
		});
		expect(credential).toMatchObject({ version: 1, normalization: 'raw', disabledAt: null });
		await expect(
			prisma.passwordCredential.update({ where: { id: credential.id }, data: { version: 0 } }),
		).rejects.toThrow(/password_credentials_version_check/u);
		await expect(
			prisma.passwordCredential.update({
				where: { id: credential.id },
				data: { normalization: 'invalid' },
			}),
		).rejects.toThrow(/password_credentials_normalization_check/u);
		await expect(
			prisma.passwordCredential.create({
				data: {
					id: fixtures.reservePasswordCredentialId(),
					userId: randomUUID(),
					passwordHash: HASH,
				},
			}),
		).rejects.toMatchObject({ code: 'P2003' });
	});

	it('permits one versioned credential replacement and rejects stale contenders', async () => {
		const identity = await user();
		await prisma.passwordCredential.create({
			data: { id: fixtures.reservePasswordCredentialId(), userId: identity.id, passwordHash: HASH },
		});
		const results = await Promise.all(
			['replacement-a', 'replacement-b'].map((passwordHash) =>
				prisma.passwordCredential.updateMany({
					where: { userId: identity.id, version: 1 },
					data: { passwordHash, version: { increment: 1 } },
				}),
			),
		);
		expect(results.map((row) => row.count).sort()).toEqual([0, 1]);
	});

	it('clears stale mailbox verification and advances identity version on a direct email change', async () => {
		const identity = await user();
		await prisma.user.update({
			where: { id: identity.id },
			data: { status: UserStatus.ACTIVE, emailVerifiedAt: new Date() },
		});
		const changed = await prisma.user.update({
			where: { id: identity.id },
			data: { email: `changed.${randomUUID()}@example.com`, emailVerifiedAt: new Date() },
		});
		expect(changed.emailVerifiedAt).toBeNull();
		expect(changed.identityVersion).toBe(2);
	});

	it('rolls back identity, credential and session changes when their audit transaction fails', async () => {
		const identity = await user();
		await prisma.passwordCredential.create({
			data: { id: fixtures.reservePasswordCredentialId(), userId: identity.id, passwordHash: HASH },
		});
		await prisma.user.update({
			where: { id: identity.id },
			data: { status: UserStatus.ACTIVE, emailVerifiedAt: new Date() },
		});
		const tokenDigest = randomBytes(32).toString('hex');
		const sessionId = randomUUID();
		const organizationId = randomUUID();
		const membershipId = randomUUID();
		organizationIds.add(organizationId);
		membershipIds.add(membershipId);
		await prisma.organization.create({
			data: {
				id: organizationId,
				slug: `session-${organizationId}`,
				name: 'Fictional Session Organization',
			},
		});
		await prisma.organizationMembership.create({
			data: { id: membershipId, organizationId, userId: identity.id },
		});
		sessionIds.add(sessionId);
		const [clock] = await prisma.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
		if (clock === undefined) throw new Error('Database clock is unavailable.');
		const now = clock.now;
		await prisma.ownerSession.create({
			data: {
				id: sessionId,
				userId: identity.id,
				organizationId,
				membershipId,
				tokenDigest,
				authenticatedAt: now,
				createdAt: now,
				lastActivityAt: now,
				idleExpiresAt: new Date(now.getTime() + 60_000),
				absoluteExpiresAt: new Date(now.getTime() + 120_000),
			},
		});
		await expect(
			prisma.ownerSession.create({
				data: {
					id: randomUUID(),
					userId: identity.id,
					organizationId: randomUUID(),
					membershipId,
					tokenDigest: randomBytes(32).toString('hex'),
					authenticatedAt: now,
					createdAt: now,
					lastActivityAt: now,
					idleExpiresAt: new Date(now.getTime() + 60_000),
					absoluteExpiresAt: new Date(now.getTime() + 120_000),
				},
			}),
		).rejects.toMatchObject({ code: 'P2003' });
		await expect(
			prisma.$transaction(async (transaction) => {
				await transaction.user.update({
					where: { id: identity.id },
					data: { identityVersion: { increment: 1 } },
				});
				await transaction.passwordCredential.update({
					where: { userId: identity.id },
					data: { passwordHash: 'replacement', version: { increment: 1 } },
				});
				const [current] = await transaction.$queryRaw<
					{ now: Date }[]
				>`SELECT clock_timestamp() AS now`;
				if (current === undefined) throw new Error('Database clock is unavailable.');
				await transaction.ownerSession.updateMany({
					where: { userId: identity.id },
					data: { revokedAt: current.now },
				});
				await transaction.identitySecurityAuditEvent.create({
					data: {
						userId: identity.id,
						actorKind: 'email_verification',
						actorUserId: identity.id,
						action: 'invalid-event',
						identityVersion: 2,
						requestId: `req_${randomUUID()}`,
					},
				});
			}, OPTIONS),
		).rejects.toThrow(/identity_security_audit_events_action_check/u);
		expect(await prisma.user.findUnique({ where: { id: identity.id } })).toMatchObject({
			identityVersion: 1,
		});
		expect(
			await prisma.passwordCredential.findUnique({ where: { userId: identity.id } }),
		).toMatchObject({ version: 1, passwordHash: HASH });
		expect(await prisma.ownerSession.findUnique({ where: { tokenDigest } })).toMatchObject({
			revokedAt: null,
		});
	});

	it('rejects audit mutation and leaves no committed audit fixture', async () => {
		const identity = await user();
		await expect(
			prisma.$transaction(async (transaction) => {
				const event = await transaction.identitySecurityAuditEvent.create({
					data: {
						userId: identity.id,
						actorKind: 'email_verification',
						actorUserId: identity.id,
						action: 'email_verified',
						identityVersion: 1,
						requestId: `req_${randomUUID()}`,
					},
				});
				await transaction.identitySecurityAuditEvent.delete({ where: { id: event.id } });
			}, OPTIONS),
		).rejects.toThrow(/Identity security audit events are immutable/u);
		expect(await prisma.identitySecurityAuditEvent.count({ where: { userId: identity.id } })).toBe(
			0,
		);
	});

	it.each([
		'platform_primary_authenticated',
		'platform_mfa_rejected',
		'platform_session_issued',
		'platform_session_revoked',
		'platform_challenge_revoked',
	])(
		'accepts an identity-bound authentication audit and retains immutability: %s',
		async (action) => {
			const identity = await user();
			await expect(
				prisma.$transaction(async (transaction) => {
					const event = await transaction.identitySecurityAuditEvent.create({
						data: {
							userId: identity.id,
							actorUserId: identity.id,
							actorKind: 'authentication',
							action,
							identityVersion: identity.identityVersion,
							requestId: `req_${randomUUID()}`,
						},
					});
					await transaction.identitySecurityAuditEvent.delete({ where: { id: event.id } });
				}, OPTIONS),
			).rejects.toThrow(/Identity security audit events are immutable/u);
			expect(
				await prisma.identitySecurityAuditEvent.count({ where: { userId: identity.id } }),
			).toBe(0);
		},
	);

	it('rejects authentication events attributed to an enrollment actor', async () => {
		const identity = await user();
		await expect(
			prisma.identitySecurityAuditEvent.create({
				data: {
					userId: identity.id,
					actorUserId: identity.id,
					actorKind: 'enrollment',
					action: 'platform_session_issued',
					identityVersion: identity.identityVersion,
					requestId: `req_${randomUUID()}`,
				},
			}),
		).rejects.toThrow(/identity_security_audit_events_authentication_check/u);
	});
});
