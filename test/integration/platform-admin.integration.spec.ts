import { randomUUID } from 'node:crypto';

import { jest } from '@jest/globals';
import { Test, type TestingModule } from '@nestjs/testing';

import { DatabaseModule } from '../../src/database/database.module.js';
import { PrismaService } from '../../src/database/prisma.service.js';
import { PlatformStaffStatus, UserStatus } from '../../src/generated/prisma/client.js';
import { PlatformAdminTestFixtures } from './platform-admin-test-fixtures.js';
import {
	loadDevelopmentDatabaseConfig,
	verifyDevelopmentDatabaseSafety,
	type VerifiedDevelopmentDatabase,
} from './development-database-safety.js';

const FICTIONAL_PASSWORD_HASH = 'argon2id-test-hash-not-a-real-credential';
const UNKNOWN_USER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const UNKNOWN_ROLE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const TRANSACTION_MAX_WAIT_MILLISECONDS = 10_000;
const TRANSACTION_TIMEOUT_MILLISECONDS = 15_000;
const TEST_RUN_ID = randomUUID().replaceAll('-', '');

jest.setTimeout(30_000);

function fixtureEmail(localPart: string): string {
	return `${localPart}.${TEST_RUN_ID}@example.com`;
}

function fixtureKey(key: string): string {
	return `${key}.${TEST_RUN_ID}`;
}

async function expectConstraintViolation(
	operation: Promise<unknown>,
	code: 'P2002' | 'P2003',
): Promise<void> {
	await expect(operation).rejects.toMatchObject({ code });
}

const developmentDatabase = loadDevelopmentDatabaseConfig();

describe('platform administrator database foundation', () => {
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

	function requireVerifiedDatabase(): VerifiedDevelopmentDatabase {
		if (verifiedDatabase === undefined) {
			throw new Error('The integration-test database safety check has not completed.');
		}

		return verifiedDatabase;
	}

	it('creates a pending global user without platform access', async () => {
		const user = await prisma.user.create({
			data: {
				id: fixtures.reserveUserId(),
				email: fixtureEmail('aline.uwase'),
				displayName: 'Aline Uwase',
			},
			include: { passwordCredential: true, platformStaff: true },
		});

		expect(user.status).toBe(UserStatus.PENDING);
		expect(user.passwordCredential).toBeNull();
		expect(user.platformStaff).toBeNull();
		expect(
			await prisma.platformStaffRole.count({
				where: { platformStaff: { userId: user.id } },
			}),
		).toBe(0);
	});

	it('rejects email duplicates that differ only by case', async () => {
		const email = fixtureEmail('claudine.mukamana');
		await prisma.user.create({
			data: {
				id: fixtures.reserveUserId(),
				email,
				displayName: 'Claudine Mukamana',
			},
		});

		await expectConstraintViolation(
			prisma.user.create({
				data: {
					id: fixtures.reserveUserId(),
					email: email.toUpperCase(),
					displayName: 'Another Identity',
				},
			}),
			'P2002',
		);
	});

	it('allows at most one password credential per user', async () => {
		const user = await prisma.user.create({
			data: {
				id: fixtures.reserveUserId(),
				email: fixtureEmail('kevin.habimana'),
				displayName: 'Kevin Habimana',
			},
		});
		await prisma.passwordCredential.create({
			data: {
				id: fixtures.reservePasswordCredentialId(),
				userId: user.id,
				passwordHash: FICTIONAL_PASSWORD_HASH,
			},
		});

		await expectConstraintViolation(
			prisma.passwordCredential.create({
				data: {
					id: fixtures.reservePasswordCredentialId(),
					userId: user.id,
					passwordHash: FICTIONAL_PASSWORD_HASH,
				},
			}),
			'P2002',
		);
	});

	it('rejects credentials for an unknown user', async () => {
		await expectConstraintViolation(
			prisma.passwordCredential.create({
				data: {
					id: fixtures.reservePasswordCredentialId(),
					userId: UNKNOWN_USER_ID,
					passwordHash: FICTIONAL_PASSWORD_HASH,
				},
			}),
			'P2003',
		);
	});

	it('allows at most one platform staff assignment per user', async () => {
		const user = await prisma.user.create({
			data: {
				id: fixtures.reserveUserId(),
				email: fixtureEmail('diane.ingabire'),
				displayName: 'Diane Ingabire',
			},
		});
		await prisma.platformStaff.create({
			data: {
				id: fixtures.reservePlatformStaffId(),
				userId: user.id,
				status: PlatformStaffStatus.PENDING,
			},
		});

		await expectConstraintViolation(
			prisma.platformStaff.create({
				data: {
					id: fixtures.reservePlatformStaffId(),
					userId: user.id,
					status: PlatformStaffStatus.ACTIVE,
				},
			}),
			'P2002',
		);
	});

	it('enforces unique platform role keys', async () => {
		const key = fixtureKey('platform.support');
		await prisma.platformRole.create({
			data: {
				id: fixtures.reservePlatformRoleId(),
				key,
				name: 'Platform Support',
				description: 'Supports fictional Akiba platform operations.',
			},
		});

		await expectConstraintViolation(
			prisma.platformRole.create({
				data: {
					id: fixtures.reservePlatformRoleId(),
					key: key.toUpperCase(),
					name: 'Duplicate Support',
					description: 'Must not be created.',
				},
			}),
			'P2002',
		);
	});

	it('enforces unique platform permission keys', async () => {
		const key = fixtureKey('platform.staff.read');
		await prisma.platformPermission.create({
			data: {
				id: fixtures.reservePlatformPermissionId(),
				key,
				description: 'Reads platform staff metadata.',
			},
		});

		await expectConstraintViolation(
			prisma.platformPermission.create({
				data: {
					id: fixtures.reservePlatformPermissionId(),
					key: key.toUpperCase(),
					description: 'Must not be created.',
				},
			}),
			'P2002',
		);
	});

	it('rejects duplicate staff role assignments', async () => {
		const user = await prisma.user.create({
			data: {
				id: fixtures.reserveUserId(),
				email: fixtureEmail('eric.nshimiyimana'),
				displayName: 'Eric Nshimiyimana',
			},
		});
		const staff = await prisma.platformStaff.create({
			data: {
				id: fixtures.reservePlatformStaffId(),
				userId: user.id,
				status: PlatformStaffStatus.ACTIVE,
			},
		});
		const role = await prisma.platformRole.create({
			data: {
				id: fixtures.reservePlatformRoleId(),
				key: fixtureKey('platform.administrator'),
				name: 'Platform Administrator',
				description: 'Administers approved Akiba platform capabilities.',
			},
		});
		const assignment = { platformStaffId: staff.id, platformRoleId: role.id };
		await prisma.platformStaffRole.create({ data: assignment });

		await expectConstraintViolation(prisma.platformStaffRole.create({ data: assignment }), 'P2002');
	});

	it('rejects duplicate role permission mappings', async () => {
		const role = await prisma.platformRole.create({
			data: {
				id: fixtures.reservePlatformRoleId(),
				key: fixtureKey('platform.billing'),
				name: 'Platform Billing',
				description: 'Manages approved platform billing capabilities.',
			},
		});
		const permission = await prisma.platformPermission.create({
			data: {
				id: fixtures.reservePlatformPermissionId(),
				key: fixtureKey('platform.subscriptions.manage'),
				description: 'Manages platform subscription configuration.',
			},
		});
		const mapping = { platformRoleId: role.id, platformPermissionId: permission.id };
		await prisma.platformRolePermission.create({ data: mapping });

		await expectConstraintViolation(
			prisma.platformRolePermission.create({ data: mapping }),
			'P2002',
		);
	});

	it('rejects staff role assignments with invalid relationships', async () => {
		await expectConstraintViolation(
			prisma.platformStaffRole.create({
				data: { platformStaffId: UNKNOWN_USER_ID, platformRoleId: UNKNOWN_ROLE_ID },
			}),
			'P2003',
		);
	});

	it('restricts deletion of security records that still have dependents', async () => {
		const user = await prisma.user.create({
			data: {
				id: fixtures.reserveUserId(),
				email: fixtureEmail('fiona.mutesi'),
				displayName: 'Fiona Mutesi',
			},
		});
		await prisma.passwordCredential.create({
			data: {
				id: fixtures.reservePasswordCredentialId(),
				userId: user.id,
				passwordHash: FICTIONAL_PASSWORD_HASH,
			},
		});
		const staff = await prisma.platformStaff.create({
			data: {
				id: fixtures.reservePlatformStaffId(),
				userId: user.id,
				status: PlatformStaffStatus.ACTIVE,
			},
		});
		const role = await prisma.platformRole.create({
			data: {
				id: fixtures.reservePlatformRoleId(),
				key: fixtureKey('platform.owner'),
				name: 'Platform Owner',
				description: 'Reserved for explicitly bootstrapped Akiba ownership.',
				isSystem: true,
			},
		});
		const permission = await prisma.platformPermission.create({
			data: {
				id: fixtures.reservePlatformPermissionId(),
				key: fixtureKey('platform.audit.read'),
				description: 'Reads privileged platform audit records.',
			},
		});
		await prisma.platformStaffRole.create({
			data: { platformStaffId: staff.id, platformRoleId: role.id },
		});
		await prisma.platformRolePermission.create({
			data: { platformRoleId: role.id, platformPermissionId: permission.id },
		});

		await expectConstraintViolation(prisma.user.delete({ where: { id: user.id } }), 'P2003');
		await expectConstraintViolation(
			prisma.platformStaff.delete({ where: { id: staff.id } }),
			'P2003',
		);
		await expectConstraintViolation(
			prisma.platformRole.delete({ where: { id: role.id } }),
			'P2003',
		);
		await expectConstraintViolation(
			prisma.platformPermission.delete({ where: { id: permission.id } }),
			'P2003',
		);
	});

	it('persists account suspension and platform staff suspension or revocation states', async () => {
		const suspendedAt = new Date('2026-10-12T12:00:00.000Z');
		const user = await prisma.user.create({
			data: {
				id: fixtures.reserveUserId(),
				email: fixtureEmail('grace.umutesi'),
				displayName: 'Grace Umutesi',
				status: UserStatus.SUSPENDED,
			},
		});
		const staff = await prisma.platformStaff.create({
			data: {
				id: fixtures.reservePlatformStaffId(),
				userId: user.id,
				status: PlatformStaffStatus.SUSPENDED,
				suspendedAt,
			},
		});

		expect(user.status).toBe(UserStatus.SUSPENDED);
		expect(staff.status).toBe(PlatformStaffStatus.SUSPENDED);
		expect(staff.suspendedAt).toEqual(suspendedAt);

		const revokedUser = await prisma.user.create({
			data: {
				id: fixtures.reserveUserId(),
				email: fixtureEmail('grace.revoked'),
				displayName: 'Grace Revoked',
			},
		});
		const revokedStaff = await prisma.platformStaff.create({
			data: {
				id: fixtures.reservePlatformStaffId(),
				userId: revokedUser.id,
				status: PlatformStaffStatus.REVOKED,
			},
		});

		expect(revokedStaff.status).toBe(PlatformStaffStatus.REVOKED);
	});

	it('resolves permissions only through explicit staff role relationships', async () => {
		const user = await prisma.user.create({
			data: {
				id: fixtures.reserveUserId(),
				email: fixtureEmail('henriette.kayitesi'),
				displayName: 'Henriette Kayitesi',
			},
		});
		const staff = await prisma.platformStaff.create({
			data: {
				id: fixtures.reservePlatformStaffId(),
				userId: user.id,
				status: PlatformStaffStatus.ACTIVE,
			},
		});
		const role = await prisma.platformRole.create({
			data: {
				id: fixtures.reservePlatformRoleId(),
				key: fixtureKey('platform.support'),
				name: 'Platform Support',
				description: 'Supports approved platform operations.',
			},
		});
		const permission = await prisma.platformPermission.create({
			data: {
				id: fixtures.reservePlatformPermissionId(),
				key: fixtureKey('platform.dashboard.read'),
				description: 'Reads the platform operations dashboard.',
			},
		});
		await prisma.platformStaffRole.create({
			data: { platformStaffId: staff.id, platformRoleId: role.id },
		});
		await prisma.platformRolePermission.create({
			data: { platformRoleId: role.id, platformPermissionId: permission.id },
		});

		const authorization = await prisma.platformStaff.findUnique({
			where: { id: staff.id },
			include: {
				roles: {
					include: {
						platformRole: {
							include: { permissions: { include: { platformPermission: true } } },
						},
					},
				},
			},
		});

		expect(authorization?.roles[0]?.platformRole.key).toBe(fixtureKey('platform.support'));
		expect(authorization?.roles[0]?.platformRole.permissions[0]?.platformPermission.key).toBe(
			fixtureKey('platform.dashboard.read'),
		);
	});

	it('removes only records reserved by the current fixture set', async () => {
		const unrelatedFixtures = new PlatformAdminTestFixtures();
		additionalFixtures.push(unrelatedFixtures);
		const unrelatedUserId = unrelatedFixtures.reserveUserId();
		const ownedUserId = fixtures.reserveUserId();

		await prisma.user.createMany({
			data: [
				{
					id: unrelatedUserId,
					email: fixtureEmail('unrelated.fixture'),
					displayName: 'Unrelated Fixture',
				},
				{
					id: ownedUserId,
					email: fixtureEmail('owned.fixture'),
					displayName: 'Owned Fixture',
				},
			],
		});

		await fixtures.cleanup(prisma, requireVerifiedDatabase());

		await expect(prisma.user.findUnique({ where: { id: ownedUserId } })).resolves.toBeNull();
		await expect(prisma.user.findUnique({ where: { id: unrelatedUserId } })).resolves.toMatchObject(
			{
				id: unrelatedUserId,
			},
		);
	});

	it('cleans fixtures after setup stops with a partial relationship graph', async () => {
		const userId = fixtures.reserveUserId();
		const passwordCredentialId = fixtures.reservePasswordCredentialId();
		const setupError = new Error('intentional partial fixture setup failure');
		await expect(
			(async () => {
				await prisma.user.create({
					data: {
						id: userId,
						email: fixtureEmail('partial.fixture'),
						displayName: 'Partial Fixture',
					},
				});
				await prisma.passwordCredential.create({
					data: {
						id: passwordCredentialId,
						userId,
						passwordHash: FICTIONAL_PASSWORD_HASH,
					},
				});
				throw setupError;
			})(),
		).rejects.toBe(setupError);

		await fixtures.cleanup(prisma, requireVerifiedDatabase());

		await expect(prisma.user.findUnique({ where: { id: userId } })).resolves.toBeNull();
	});

	it('keeps fixture cleanup repeatable', async () => {
		const userId = fixtures.reserveUserId();
		await prisma.user.create({
			data: {
				id: userId,
				email: fixtureEmail('repeatable.fixture'),
				displayName: 'Repeatable Fixture',
			},
		});

		await fixtures.cleanup(prisma, requireVerifiedDatabase());
		await expect(fixtures.cleanup(prisma, requireVerifiedDatabase())).resolves.toBeUndefined();
		await expect(prisma.user.findUnique({ where: { id: userId } })).resolves.toBeNull();
	});

	it('rolls back related identity and platform staff writes together', async () => {
		const rollbackError = new Error('intentional platform identity rollback');
		const email = fixtureEmail('ineza.marie');
		const userId = fixtures.reserveUserId();
		const passwordCredentialId = fixtures.reservePasswordCredentialId();
		const platformStaffId = fixtures.reservePlatformStaffId();

		await expect(
			prisma.$transaction(
				async (transaction) => {
					const user = await transaction.user.create({
						data: { id: userId, email, displayName: 'Marie Ineza' },
					});
					await transaction.passwordCredential.create({
						data: {
							id: passwordCredentialId,
							userId: user.id,
							passwordHash: FICTIONAL_PASSWORD_HASH,
						},
					});
					await transaction.platformStaff.create({
						data: {
							id: platformStaffId,
							userId: user.id,
							status: PlatformStaffStatus.PENDING,
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

		expect(await prisma.user.findUnique({ where: { email } })).toBeNull();
	});
});
