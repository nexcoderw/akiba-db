import { createHash, randomUUID } from 'node:crypto';

import { jest } from '@jest/globals';
import { Test, type TestingModule } from '@nestjs/testing';

import { DatabaseModule } from '../../src/database/database.module.js';
import { PrismaService } from '../../src/database/prisma.service.js';
import { PlatformStaffStatus } from '../../src/generated/prisma/client.js';
import { PlatformAdminTestFixtures } from './platform-admin-test-fixtures.js';
import {
	loadDevelopmentDatabaseConfig,
	verifyDevelopmentDatabaseSafety,
	type VerifiedDevelopmentDatabase,
} from './development-database-safety.js';

const UNKNOWN_STAFF_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TRANSACTION_MAX_WAIT_MILLISECONDS = 10_000;
const TRANSACTION_TIMEOUT_MILLISECONDS = 15_000;
const TEST_RUN_ID = randomUUID().replaceAll('-', '');
const REFERENCE_TIME = new Date('2030-01-01T00:00:00.000Z');

jest.setTimeout(30_000);

function fixtureEmail(localPart: string): string {
	return `${localPart}.${TEST_RUN_ID}@example.com`;
}

function fixtureDigest(label: string): string {
	return createHash('sha256').update(`${label}.${TEST_RUN_ID}`).digest('hex');
}

async function expectConstraintViolation(
	operation: Promise<unknown>,
	code: 'P2002' | 'P2003',
): Promise<void> {
	await expect(operation).rejects.toMatchObject({ code });
}

const developmentDatabase = loadDevelopmentDatabaseConfig();

describe('platform authentication persistence', () => {
	let module: TestingModule;
	let prisma: PrismaService;
	let verifiedDatabase: VerifiedDevelopmentDatabase | undefined;
	let fixtures = new PlatformAdminTestFixtures();
	const additionalFixtures: PlatformAdminTestFixtures[] = [];

	beforeAll(async () => {
		module = await Test.createTestingModule({
			imports: [
				DatabaseModule.forRoot({
					databaseUrl: developmentDatabase.databaseUrl,
					poolMax: 2,
					connectionTimeoutMilliseconds: 10_000,
				}),
			],
		}).compile();
		await module.init();
		prisma = module.get(PrismaService);
		verifiedDatabase = await verifyDevelopmentDatabaseSafety(prisma, developmentDatabase);
	});

	beforeEach(() => {
		fixtures = new PlatformAdminTestFixtures();
		additionalFixtures.length = 0;
	});

	afterEach(async () => {
		if (verifiedDatabase === undefined) {
			return;
		}

		for (const fixtureSet of [fixtures, ...additionalFixtures].reverse()) {
			await fixtureSet.cleanup(prisma, verifiedDatabase);
		}
	});

	afterAll(async () => {
		await module.close();
	});

	async function createActiveStaff(
		fixtureSet: PlatformAdminTestFixtures,
		localPart: string,
	): Promise<{ readonly id: string }> {
		const user = await prisma.user.create({
			data: {
				id: fixtureSet.reserveUserId(),
				email: fixtureEmail(localPart),
				displayName: 'Fictional Platform Administrator',
			},
		});

		return prisma.platformStaff.create({
			data: {
				id: fixtureSet.reservePlatformStaffId(),
				userId: user.id,
				status: PlatformStaffStatus.ACTIVE,
			},
			select: { id: true },
		});
	}

	function requireVerifiedDatabase(): VerifiedDevelopmentDatabase {
		if (verifiedDatabase === undefined) {
			throw new Error('The integration-test database safety check has not completed.');
		}

		return verifiedDatabase;
	}

	it('creates an MFA-verified session for an existing platform staff member', async () => {
		const staff = await createActiveStaff(fixtures, 'session.owner');
		const mfaVerifiedAt = new Date('2030-01-01T00:01:00.000Z');
		const session = await prisma.platformAdminSession.create({
			data: {
				id: fixtures.reservePlatformAdminSessionId(),
				platformStaffId: staff.id,
				tokenDigest: fixtureDigest('session.create'),
				expiresAt: new Date('2030-01-02T00:00:00.000Z'),
				idleExpiresAt: new Date('2030-01-01T00:30:00.000Z'),
				lastSeenAt: REFERENCE_TIME,
				mfaVerifiedAt,
			},
		});

		expect(session.platformStaffId).toBe(staff.id);
		expect(session.mfaVerifiedAt).toEqual(mfaVerifiedAt);
		expect(session.revokedAt).toBeNull();
	});

	it('rejects an unknown staff reference and duplicate session token digest', async () => {
		const tokenDigest = fixtureDigest('session.unique');
		await expectConstraintViolation(
			prisma.platformAdminSession.create({
				data: {
					id: fixtures.reservePlatformAdminSessionId(),
					platformStaffId: UNKNOWN_STAFF_ID,
					tokenDigest: fixtureDigest('session.unknown-staff'),
					expiresAt: new Date('2030-01-02T00:00:00.000Z'),
					idleExpiresAt: new Date('2030-01-01T00:30:00.000Z'),
					mfaVerifiedAt: REFERENCE_TIME,
				},
			}),
			'P2003',
		);

		const staff = await createActiveStaff(fixtures, 'session.unique');
		await prisma.platformAdminSession.create({
			data: {
				id: fixtures.reservePlatformAdminSessionId(),
				platformStaffId: staff.id,
				tokenDigest,
				expiresAt: new Date('2030-01-02T00:00:00.000Z'),
				idleExpiresAt: new Date('2030-01-01T00:30:00.000Z'),
				mfaVerifiedAt: REFERENCE_TIME,
			},
		});

		await expectConstraintViolation(
			prisma.platformAdminSession.create({
				data: {
					id: fixtures.reservePlatformAdminSessionId(),
					platformStaffId: staff.id,
					tokenDigest,
					expiresAt: new Date('2030-01-03T00:00:00.000Z'),
					idleExpiresAt: new Date('2030-01-01T01:00:00.000Z'),
					mfaVerifiedAt: REFERENCE_TIME,
				},
			}),
			'P2002',
		);
	});

	it('supports multiple sessions while excluding expired and revoked sessions', async () => {
		const staff = await createActiveStaff(fixtures, 'session.states');
		const sessions = [
			{
				id: fixtures.reservePlatformAdminSessionId(),
				platformStaffId: staff.id,
				tokenDigest: fixtureDigest('session.active'),
				expiresAt: new Date('2030-01-02T00:00:00.000Z'),
				idleExpiresAt: new Date('2030-01-01T00:30:00.000Z'),
				mfaVerifiedAt: REFERENCE_TIME,
			},
			{
				id: fixtures.reservePlatformAdminSessionId(),
				platformStaffId: staff.id,
				tokenDigest: fixtureDigest('session.expired'),
				expiresAt: new Date('2029-12-31T23:59:59.000Z'),
				idleExpiresAt: new Date('2030-01-01T00:30:00.000Z'),
				mfaVerifiedAt: REFERENCE_TIME,
			},
			{
				id: fixtures.reservePlatformAdminSessionId(),
				platformStaffId: staff.id,
				tokenDigest: fixtureDigest('session.revoked'),
				expiresAt: new Date('2030-01-02T00:00:00.000Z'),
				idleExpiresAt: new Date('2030-01-01T00:30:00.000Z'),
				mfaVerifiedAt: REFERENCE_TIME,
				revokedAt: REFERENCE_TIME,
			},
		];
		await prisma.platformAdminSession.createMany({ data: sessions });

		expect(await prisma.platformAdminSession.count({ where: { platformStaffId: staff.id } })).toBe(
			3,
		);
		expect(
			await prisma.platformAdminSession.count({
				where: {
					platformStaffId: staff.id,
					revokedAt: null,
					expiresAt: { gt: REFERENCE_TIME },
					idleExpiresAt: { gt: REFERENCE_TIME },
				},
			}),
		).toBe(1);

		const revocation = await prisma.platformAdminSession.updateMany({
			where: { platformStaffId: staff.id, revokedAt: null },
			data: { revokedAt: REFERENCE_TIME },
		});
		expect(revocation.count).toBe(2);
		expect(
			await prisma.platformAdminSession.count({
				where: { platformStaffId: staff.id, revokedAt: null },
			}),
		).toBe(0);
	});

	it('enforces one TOTP credential and persists verification and replay state', async () => {
		const staff = await createActiveStaff(fixtures, 'totp.owner');
		const credential = await prisma.platformTotpCredential.create({
			data: {
				id: fixtures.reservePlatformTotpCredentialId(),
				platformStaffId: staff.id,
				encryptedSecret: Buffer.from('fictional-encrypted-secret'),
				encryptionKeyId: 'test-key-v1',
				encryptionVersion: 1,
				initializationVector: Buffer.from('fictional-iv'),
				authenticationTag: Buffer.from('fictional-auth-tag'),
			},
		});

		expect(credential.verifiedAt).toBeNull();
		expect(credential.lastAcceptedTimeStep).toBeNull();

		await expectConstraintViolation(
			prisma.platformTotpCredential.create({
				data: {
					id: fixtures.reservePlatformTotpCredentialId(),
					platformStaffId: staff.id,
					encryptedSecret: Buffer.from('replacement-ciphertext'),
					encryptionKeyId: 'test-key-v2',
					encryptionVersion: 1,
					initializationVector: Buffer.from('replacement-iv'),
					authenticationTag: Buffer.from('replacement-auth-tag'),
				},
			}),
			'P2002',
		);

		const verifiedAt = new Date('2030-01-01T00:02:00.000Z');
		await prisma.platformTotpCredential.update({
			where: { id: credential.id },
			data: { verifiedAt },
		});
		const acceptedTimeStep = 31_556_952n;
		const firstAcceptance = await prisma.platformTotpCredential.updateMany({
			where: {
				id: credential.id,
				verifiedAt: { not: null },
				disabledAt: null,
				OR: [{ lastAcceptedTimeStep: null }, { lastAcceptedTimeStep: { lt: acceptedTimeStep } }],
			},
			data: { lastAcceptedTimeStep: acceptedTimeStep, lastUsedAt: verifiedAt },
		});
		const replay = await prisma.platformTotpCredential.updateMany({
			where: {
				id: credential.id,
				verifiedAt: { not: null },
				disabledAt: null,
				OR: [{ lastAcceptedTimeStep: null }, { lastAcceptedTimeStep: { lt: acceptedTimeStep } }],
			},
			data: { lastAcceptedTimeStep: acceptedTimeStep, lastUsedAt: verifiedAt },
		});

		expect(firstAcceptance.count).toBe(1);
		expect(replay.count).toBe(0);
		await expect(
			prisma.platformTotpCredential.findUnique({ where: { id: credential.id } }),
		).resolves.toMatchObject({ verifiedAt, lastAcceptedTimeStep: acceptedTimeStep });
	});

	it('enforces recovery-code digest uniqueness and single-use consumption', async () => {
		const staff = await createActiveStaff(fixtures, 'recovery.owner');
		const codeDigest = fixtureDigest('recovery.single-use');
		const recoveryCode = await prisma.platformRecoveryCode.create({
			data: {
				id: fixtures.reservePlatformRecoveryCodeId(),
				platformStaffId: staff.id,
				codeDigest,
			},
		});

		await expectConstraintViolation(
			prisma.platformRecoveryCode.create({
				data: {
					id: fixtures.reservePlatformRecoveryCodeId(),
					platformStaffId: staff.id,
					codeDigest,
				},
			}),
			'P2002',
		);

		const usedAt = new Date('2030-01-01T00:03:00.000Z');
		const consume = () =>
			prisma.platformRecoveryCode.updateMany({
				where: { id: recoveryCode.id, usedAt: null },
				data: { usedAt },
			});
		const attempts = await Promise.all([consume(), consume()]);

		expect(attempts.reduce((total, result) => total + result.count, 0)).toBe(1);
		await expect(
			prisma.platformRecoveryCode.findUnique({ where: { id: recoveryCode.id } }),
		).resolves.toMatchObject({ usedAt });
	});

	it('rejects expired, consumed, exhausted, and invalid MFA challenges', async () => {
		const staff = await createActiveStaff(fixtures, 'challenge.owner');
		const activeDigest = fixtureDigest('challenge.active');
		await prisma.platformMfaChallenge.createMany({
			data: [
				{
					id: fixtures.reservePlatformMfaChallengeId(),
					platformStaffId: staff.id,
					tokenDigest: activeDigest,
					expiresAt: new Date('2030-01-01T00:05:00.000Z'),
				},
				{
					id: fixtures.reservePlatformMfaChallengeId(),
					platformStaffId: staff.id,
					tokenDigest: fixtureDigest('challenge.expired'),
					expiresAt: new Date('2029-12-31T23:59:59.000Z'),
				},
				{
					id: fixtures.reservePlatformMfaChallengeId(),
					platformStaffId: staff.id,
					tokenDigest: fixtureDigest('challenge.consumed'),
					expiresAt: new Date('2030-01-01T00:05:00.000Z'),
					consumedAt: REFERENCE_TIME,
				},
				{
					id: fixtures.reservePlatformMfaChallengeId(),
					platformStaffId: staff.id,
					tokenDigest: fixtureDigest('challenge.exhausted'),
					expiresAt: new Date('2030-01-01T00:05:00.000Z'),
					failedAttempts: 5,
				},
			],
		});

		const eligibleChallenge = (tokenDigest: string) =>
			prisma.platformMfaChallenge.findFirst({
				where: {
					tokenDigest,
					consumedAt: null,
					expiresAt: { gt: REFERENCE_TIME },
					failedAttempts: { lt: 5 },
				},
			});

		await expect(eligibleChallenge(activeDigest)).resolves.toMatchObject({
			tokenDigest: activeDigest,
		});
		await expect(eligibleChallenge(fixtureDigest('challenge.expired'))).resolves.toBeNull();
		await expect(eligibleChallenge(fixtureDigest('challenge.consumed'))).resolves.toBeNull();
		await expect(eligibleChallenge(fixtureDigest('challenge.exhausted'))).resolves.toBeNull();
		await expect(eligibleChallenge(fixtureDigest('challenge.invalid'))).resolves.toBeNull();

		const consume = () =>
			prisma.platformMfaChallenge.updateMany({
				where: {
					tokenDigest: activeDigest,
					consumedAt: null,
					expiresAt: { gt: REFERENCE_TIME },
					failedAttempts: { lt: 5 },
				},
				data: { consumedAt: REFERENCE_TIME },
			});
		expect((await consume()).count).toBe(1);
		expect((await consume()).count).toBe(0);
		await expect(eligibleChallenge(activeDigest)).resolves.toBeNull();
	});

	it('restricts deleting staff while authentication records exist', async () => {
		const staff = await createActiveStaff(fixtures, 'restricted.staff');
		await prisma.platformAdminSession.create({
			data: {
				id: fixtures.reservePlatformAdminSessionId(),
				platformStaffId: staff.id,
				tokenDigest: fixtureDigest('session.restrict-delete'),
				expiresAt: new Date('2030-01-02T00:00:00.000Z'),
				idleExpiresAt: new Date('2030-01-01T00:30:00.000Z'),
				mfaVerifiedAt: REFERENCE_TIME,
			},
		});

		await expectConstraintViolation(
			prisma.platformStaff.delete({ where: { id: staff.id } }),
			'P2003',
		);
	});

	it('rolls back platform authentication records together', async () => {
		const staff = await createActiveStaff(fixtures, 'rollback.auth');
		const sessionId = fixtures.reservePlatformAdminSessionId();
		const challengeId = fixtures.reservePlatformMfaChallengeId();
		const rollbackError = new Error('intentional platform authentication rollback');

		await expect(
			prisma.$transaction(
				async (transaction) => {
					await transaction.platformAdminSession.create({
						data: {
							id: sessionId,
							platformStaffId: staff.id,
							tokenDigest: fixtureDigest('session.rollback'),
							expiresAt: new Date('2030-01-02T00:00:00.000Z'),
							idleExpiresAt: new Date('2030-01-01T00:30:00.000Z'),
							mfaVerifiedAt: REFERENCE_TIME,
						},
					});
					await transaction.platformMfaChallenge.create({
						data: {
							id: challengeId,
							platformStaffId: staff.id,
							tokenDigest: fixtureDigest('challenge.rollback'),
							expiresAt: new Date('2030-01-01T00:05:00.000Z'),
						},
					});
					throw rollbackError;
				},
				{
					maxWait: TRANSACTION_MAX_WAIT_MILLISECONDS,
					timeout: TRANSACTION_TIMEOUT_MILLISECONDS,
				},
			),
		).rejects.toBe(rollbackError);

		await expect(
			prisma.platformAdminSession.findUnique({ where: { id: sessionId } }),
		).resolves.toBeNull();
		await expect(
			prisma.platformMfaChallenge.findUnique({ where: { id: challengeId } }),
		).resolves.toBeNull();
	});

	it('cleans only authentication records reserved by its fixture set', async () => {
		const unrelatedFixtures = new PlatformAdminTestFixtures();
		additionalFixtures.push(unrelatedFixtures);
		const unrelatedStaff = await createActiveStaff(unrelatedFixtures, 'unrelated.auth');
		const ownedStaff = await createActiveStaff(fixtures, 'owned.auth');
		const unrelatedSessionId = unrelatedFixtures.reservePlatformAdminSessionId();
		const ownedSessionId = fixtures.reservePlatformAdminSessionId();

		await prisma.platformAdminSession.createMany({
			data: [
				{
					id: unrelatedSessionId,
					platformStaffId: unrelatedStaff.id,
					tokenDigest: fixtureDigest('session.unrelated'),
					expiresAt: new Date('2030-01-02T00:00:00.000Z'),
					idleExpiresAt: new Date('2030-01-01T00:30:00.000Z'),
					mfaVerifiedAt: REFERENCE_TIME,
				},
				{
					id: ownedSessionId,
					platformStaffId: ownedStaff.id,
					tokenDigest: fixtureDigest('session.owned'),
					expiresAt: new Date('2030-01-02T00:00:00.000Z'),
					idleExpiresAt: new Date('2030-01-01T00:30:00.000Z'),
					mfaVerifiedAt: REFERENCE_TIME,
				},
			],
		});

		await fixtures.cleanup(prisma, requireVerifiedDatabase());

		await expect(
			prisma.platformAdminSession.findUnique({ where: { id: ownedSessionId } }),
		).resolves.toBeNull();
		await expect(
			prisma.platformAdminSession.findUnique({ where: { id: unrelatedSessionId } }),
		).resolves.toMatchObject({ id: unrelatedSessionId });
	});
});
