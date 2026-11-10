import { randomUUID } from 'node:crypto';

import { jest } from '@jest/globals';
import { Test, type TestingModule } from '@nestjs/testing';

import { DatabaseModule } from '../../src/database/database.module.js';
import { PrismaService } from '../../src/database/prisma.service.js';
import { OrganizationMembershipStatus, OrganizationStatus, UserStatus } from '../../src/index.js';
import { OrganizationMembershipTestFixtures } from './organization-membership-test-fixtures.js';
import { OrganizationTestFixtures } from './organization-test-fixtures.js';
import { PlatformAdminTestFixtures } from './platform-admin-test-fixtures.js';
import {
	loadDevelopmentDatabaseConfig,
	verifyDevelopmentDatabaseSafety,
	verifyTestTablePrivileges,
	type VerifiedDevelopmentDatabase,
} from './development-database-safety.js';

const safety = loadDevelopmentDatabaseConfig();
const requiredChecks = [
	'organization_roles_key_format_check',
	'organization_roles_name_nonblank_check',
	'organization_roles_description_nonblank_check',
	'organization_roles_owner_system_check',
];

jest.setTimeout(180_000);

describe('organization ownership and membership foundation', () => {
	let module: TestingModule | undefined;
	let prisma: PrismaService;
	let verified: VerifiedDevelopmentDatabase | undefined;
	let organizations: OrganizationTestFixtures;
	let identities: PlatformAdminTestFixtures;
	let authorization: OrganizationMembershipTestFixtures;

	beforeAll(async () => {
		module = await Test.createTestingModule({
			imports: [
				DatabaseModule.forRoot({
					databaseUrl: safety.databaseUrl,
					poolMax: 3,
					connectionTimeoutMilliseconds: 30_000,
				}),
			],
		}).compile();
		await module.init();
		prisma = module.get(PrismaService);
		const safe = await verifyDevelopmentDatabaseSafety(prisma, safety);
		const [tables, checks, scopedForeignKeys] = await Promise.all([
			prisma.$queryRaw<{ name: string | null }[]>`
				SELECT unnest(ARRAY[
					to_regclass('public.organization_memberships')::text,
					to_regclass('public.organization_roles')::text,
					to_regclass('public.organization_membership_roles')::text,
					to_regclass('public.organization_permissions')::text,
					to_regclass('public.organization_role_permissions')::text
				]) AS name
			`,
			prisma.$queryRaw<{ name: string }[]>`
				SELECT conname AS name FROM pg_catalog.pg_constraint
				WHERE conrelid = to_regclass('public.organization_roles')
					AND contype = 'c' AND convalidated
			`,
			prisma.$queryRaw<{ name: string }[]>`
				SELECT conname AS name FROM pg_catalog.pg_constraint
				WHERE conrelid = to_regclass('public.organization_membership_roles')
					AND contype = 'f'
					AND array_length(conkey, 1) = 2
			`,
		]);
		if (
			tables.some(({ name }) => name === null) ||
			requiredChecks.some((name) => !checks.some((check) => check.name === name)) ||
			scopedForeignKeys.length !== 2
		) {
			throw new Error(
				'Organization membership prerequisites are missing: apply the reviewed membership ' +
					'migration, SQL checks and composite foreign keys to the verified test database.',
			);
		}
		await verifyTestTablePrivileges(prisma, [
			{
				tableName: 'organization_memberships',
				privileges: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
			},
			{
				tableName: 'organization_roles',
				privileges: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
			},
			{
				tableName: 'organization_membership_roles',
				privileges: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
			},
		]);
		verified = safe;
	});

	beforeEach(() => {
		organizations = new OrganizationTestFixtures();
		identities = new PlatformAdminTestFixtures();
		authorization = new OrganizationMembershipTestFixtures();
	});

	afterEach(async () => {
		if (verified === undefined) return;
		await authorization.cleanup(prisma, verified);
		await organizations.cleanup(prisma, verified);
		await identities.cleanup(prisma, verified);
	});

	afterAll(async () => {
		await module?.close();
	});

	function requireVerified(): VerifiedDevelopmentDatabase {
		if (verified === undefined) throw new Error('Membership development database is not verified.');
		return verified;
	}

	async function createOrganization(name = 'Kimihurura Supplies'): Promise<string> {
		const fixture = organizations.reserve(requireVerified());
		await prisma.organization.create({ data: { ...fixture, name } });
		return fixture.id;
	}

	async function createUser(): Promise<string> {
		const id = identities.reserveUserId();
		await prisma.user.create({
			data: {
				id,
				email: `member-${id}@example.com`,
				displayName: 'Aline Uwase',
				status: UserStatus.ACTIVE,
				emailVerifiedAt: new Date(),
			},
		});
		return id;
	}

	async function createMembership(
		organizationId: string,
		userId: string,
		status?: OrganizationMembershipStatus,
	): Promise<string> {
		const id = authorization.reserveMembershipId(requireVerified());
		await prisma.organizationMembership.create({
			data: { id, organizationId, userId, ...(status === undefined ? {} : { status }) },
		});
		return id;
	}

	async function createRole(
		organizationId: string,
		key = 'owner',
		isSystem = key === 'owner',
	): Promise<string> {
		const id = authorization.reserveRoleId(requireVerified());
		await prisma.organizationRole.create({
			data: {
				id,
				organizationId,
				key,
				name: key === 'owner' ? 'Owner' : 'Operator',
				description: key === 'owner' ? 'Organization ownership authority' : null,
				isSystem,
			},
		});
		return id;
	}

	it('creates a pending UUID membership with nullable lifecycle metadata', async () => {
		const organizationId = await createOrganization();
		const userId = await createUser();
		const id = await createMembership(organizationId, userId);
		const membership = await prisma.organizationMembership.findUniqueOrThrow({ where: { id } });

		expect(membership).toMatchObject({
			id,
			organizationId,
			userId,
			status: OrganizationMembershipStatus.PENDING,
			activatedAt: null,
			suspendedAt: null,
			revokedAt: null,
		});
		expect(membership.id).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
		);
		expect(membership.createdAt).toBeInstanceOf(Date);
		expect(membership.updatedAt).toBeInstanceOf(Date);
	});

	it('supports one user in multiple organizations and multiple users in one organization', async () => {
		const kimihurura = await createOrganization('Kimihurura Supplies');
		const power = await createOrganization('Remera Trading');
		const aline = await createUser();
		const uwase = await createUser();
		await createMembership(kimihurura, aline);
		await createMembership(power, aline);
		await createMembership(kimihurura, uwase);

		expect(await prisma.organizationMembership.count({ where: { userId: aline } })).toBe(2);
		expect(
			await prisma.organizationMembership.count({ where: { organizationId: kimihurura } }),
		).toBe(2);
	});

	it('rejects duplicate memberships and retains uniqueness after revocation', async () => {
		const organizationId = await createOrganization();
		const userId = await createUser();
		await createMembership(organizationId, userId, OrganizationMembershipStatus.REVOKED);
		const duplicateId = authorization.reserveMembershipId(requireVerified());

		await expect(
			prisma.organizationMembership.create({ data: { id: duplicateId, organizationId, userId } }),
		).rejects.toMatchObject({ code: 'P2002' });
	});

	it('allows exactly one concurrent membership for one organization and user', async () => {
		const organizationId = await createOrganization();
		const userId = await createUser();
		const ids = [
			authorization.reserveMembershipId(requireVerified()),
			authorization.reserveMembershipId(requireVerified()),
		];
		const results = await Promise.allSettled(
			ids.map((id) =>
				prisma.organizationMembership.create({ data: { id, organizationId, userId } }),
			),
		);

		expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
		expect(results.find(({ status }) => status === 'rejected')).toMatchObject({
			status: 'rejected',
			reason: { code: 'P2002' },
		});
	});

	it('persists every membership status without treating lifecycle metadata as access', async () => {
		const organizationId = await createOrganization();
		const userId = await createUser();
		const id = await createMembership(organizationId, userId);
		const time = new Date('2030-01-01T00:00:00.000Z');

		for (const status of Object.values(OrganizationMembershipStatus)) {
			const membership = await prisma.organizationMembership.update({
				where: { id },
				data: { status, activatedAt: time, suspendedAt: time, revokedAt: time },
			});
			expect(membership.status).toBe(status);
		}
		expect(await prisma.platformStaff.findUnique({ where: { userId } })).toBeNull();
	});

	it('rejects an unknown membership status in PostgreSQL', async () => {
		const organizationId = await createOrganization();
		const userId = await createUser();
		const id = authorization.reserveMembershipId(requireVerified());

		await expect(prisma.$executeRaw`
			INSERT INTO public.organization_memberships
				(id, organization_id, user_id, status, updated_at)
			VALUES (
				${id}::uuid, ${organizationId}::uuid, ${userId}::uuid,
				${'unknown'}::public.organization_membership_status, now()
			)
		`).rejects.toMatchObject({ code: 'P2010' });
	});

	it('requires existing organizations and users and restricts their deletion', async () => {
		const organizationId = await createOrganization();
		const userId = await createUser();
		const missingMembershipId = authorization.reserveMembershipId(requireVerified());
		await expect(
			prisma.organizationMembership.create({
				data: { id: missingMembershipId, organizationId: randomUUID(), userId },
			}),
		).rejects.toMatchObject({ code: 'P2003' });
		await expect(
			prisma.organizationMembership.create({
				data: { id: missingMembershipId, organizationId, userId: randomUUID() },
			}),
		).rejects.toMatchObject({ code: 'P2003' });
		await createMembership(organizationId, userId);
		await expect(prisma.user.delete({ where: { id: userId } })).rejects.toMatchObject({
			code: 'P2003',
		});
		await expect(
			prisma.organization.delete({ where: { id: organizationId } }),
		).rejects.toMatchObject({ code: 'P2003' });
	});

	it('creates no owner role or membership when an organization is registered', async () => {
		const organizationId = await createOrganization();
		expect(await prisma.organizationMembership.count({ where: { organizationId } })).toBe(0);
		expect(await prisma.organizationRole.count({ where: { organizationId } })).toBe(0);
	});

	it('keeps owner roles organization-specific and unique within one organization', async () => {
		const kimihurura = await createOrganization('Kimihurura Supplies');
		const power = await createOrganization('Remera Trading');
		await createRole(kimihurura);
		await createRole(power);
		const duplicateId = authorization.reserveRoleId(requireVerified());

		await expect(
			prisma.organizationRole.create({
				data: {
					id: duplicateId,
					organizationId: kimihurura,
					key: 'owner',
					name: 'Owner',
					isSystem: true,
				},
			}),
		).rejects.toMatchObject({ code: 'P2002' });
		await expect(prisma.organization.delete({ where: { id: power } })).rejects.toMatchObject({
			code: 'P2003',
		});
	});

	it.each(['Owner', 'owner role', '-owner', 'owner-', 'owner..role', '1owner', 'o'])(
		'rejects invalid organization role key: %s',
		async (key) => {
			const organizationId = await createOrganization();
			const id = authorization.reserveRoleId(requireVerified());
			await expect(prisma.$executeRaw`
				INSERT INTO public.organization_roles
					(id, organization_id, key, name, is_system, updated_at)
				VALUES (${id}::uuid, ${organizationId}::uuid, ${key}, 'Custom role', false, now())
			`).rejects.toThrow('organization_roles_key_format_check');
		},
	);

	it('reserves owner for a trusted system role and bounds role text', async () => {
		const organizationId = await createOrganization();
		const customOwnerId = authorization.reserveRoleId(requireVerified());
		await expect(prisma.$executeRaw`
			INSERT INTO public.organization_roles
				(id, organization_id, key, name, is_system, updated_at)
			VALUES (${customOwnerId}::uuid, ${organizationId}::uuid, 'owner', 'Owner', false, now())
		`).rejects.toThrow('organization_roles_owner_system_check');

		const blankNameId = authorization.reserveRoleId(requireVerified());
		await expect(prisma.$executeRaw`
			INSERT INTO public.organization_roles
				(id, organization_id, key, name, is_system, updated_at)
			VALUES (${blankNameId}::uuid, ${organizationId}::uuid, 'operator', ' ', false, now())
		`).rejects.toThrow('organization_roles_name_nonblank_check');

		const blankDescriptionId = authorization.reserveRoleId(requireVerified());
		await expect(prisma.$executeRaw`
			INSERT INTO public.organization_roles
				(id, organization_id, key, name, description, is_system, updated_at)
			VALUES (
				${blankDescriptionId}::uuid, ${organizationId}::uuid,
				'accountant', 'Accountant', ' ', false, now()
			)
		`).rejects.toThrow('organization_roles_description_nonblank_check');

		const longNameId = authorization.reserveRoleId(requireVerified());
		await expect(
			prisma.organizationRole.create({
				data: {
					id: longNameId,
					organizationId,
					key: 'operator',
					name: 'x'.repeat(121),
				},
			}),
		).rejects.toThrow();

		const longDescriptionId = authorization.reserveRoleId(requireVerified());
		await expect(
			prisma.organizationRole.create({
				data: {
					id: longDescriptionId,
					organizationId,
					key: 'accountant',
					name: 'Accountant',
					description: 'x'.repeat(501),
				},
			}),
		).rejects.toThrow();
	});

	it('assigns a same-organization role once and protects assignment parents', async () => {
		const organizationId = await createOrganization();
		const membershipId = await createMembership(organizationId, await createUser());
		const roleId = await createRole(organizationId);
		const data = {
			organizationId,
			organizationMembershipId: membershipId,
			organizationRoleId: roleId,
		};
		const assignment = await prisma.organizationMembershipRole.create({ data });

		expect(assignment).toMatchObject(data);
		await expect(prisma.organizationMembershipRole.create({ data })).rejects.toMatchObject({
			code: 'P2002',
		});
		await expect(
			prisma.organizationMembership.delete({ where: { id: membershipId } }),
		).rejects.toMatchObject({ code: 'P2003' });
		await expect(prisma.organizationRole.delete({ where: { id: roleId } })).rejects.toMatchObject({
			code: 'P2003',
		});
	});

	it('rejects cross-organization and nonexistent membership-role assignments', async () => {
		const kimihurura = await createOrganization('Kimihurura Supplies');
		const power = await createOrganization('Remera Trading');
		const kimihururaMembership = await createMembership(kimihurura, await createUser());
		const powerOwner = await createRole(power);

		await expect(
			prisma.organizationMembershipRole.create({
				data: {
					organizationId: kimihurura,
					organizationMembershipId: kimihururaMembership,
					organizationRoleId: powerOwner,
				},
			}),
		).rejects.toMatchObject({ code: 'P2003' });
		await expect(
			prisma.organizationMembershipRole.create({
				data: {
					organizationId: kimihurura,
					organizationMembershipId: kimihururaMembership,
					organizationRoleId: randomUUID(),
				},
			}),
		).rejects.toMatchObject({ code: 'P2003' });
		await expect(
			prisma.organizationMembershipRole.create({
				data: {
					organizationId: kimihurura,
					organizationMembershipId: randomUUID(),
					organizationRoleId: await createRole(kimihurura, 'operator'),
				},
			}),
		).rejects.toMatchObject({ code: 'P2003' });
	});

	it('allows exactly one concurrent duplicate role assignment', async () => {
		const organizationId = await createOrganization();
		const membershipId = await createMembership(organizationId, await createUser());
		const roleId = await createRole(organizationId);
		const data = {
			organizationId,
			organizationMembershipId: membershipId,
			organizationRoleId: roleId,
		};
		const results = await Promise.allSettled([
			prisma.organizationMembershipRole.create({ data }),
			prisma.organizationMembershipRole.create({ data }),
		]);

		expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
		expect(results.find(({ status }) => status === 'rejected')).toMatchObject({
			status: 'rejected',
			reason: { code: 'P2002' },
		});
	});

	it('enforces case-insensitive role names and rejects owner impersonation', async () => {
		const organizationId = await createOrganization();
		await createRole(organizationId, 'custom.operator', false);
		await expect(
			prisma.organizationRole.create({
				data: {
					id: authorization.reserveRoleId(requireVerified()),
					organizationId,
					key: 'custom.second',
					name: 'operator',
					isSystem: false,
				},
			}),
		).rejects.toMatchObject({ code: 'P2002' });
		await expect(
			prisma.organizationRole.create({
				data: {
					id: authorization.reserveRoleId(requireVerified()),
					organizationId,
					key: 'custom.owner',
					name: 'Organization Owner',
					isSystem: false,
				},
			}),
		).rejects.toThrow('organization_roles_system_identity_check');
	});

	it('rejects a cross-organization permission mapping at the database boundary', async () => {
		const first = await createOrganization('Kimihurura Supplies');
		const second = await createOrganization('Remera Trading');
		const roleId = await createRole(first, 'custom.reader', false);
		const permission = await prisma.organizationPermission.findUniqueOrThrow({
			where: { key: 'organization.members.read' },
		});
		await expect(
			prisma.organizationRolePermission.create({
				data: {
					organizationId: second,
					organizationRoleId: roleId,
					organizationPermissionId: permission.id,
				},
			}),
		).rejects.toMatchObject({ code: 'P2003' });
		try {
			await prisma.organizationRolePermission.create({
				data: {
					organizationId: first,
					organizationRoleId: roleId,
					organizationPermissionId: permission.id,
				},
			});
			await expect(
				prisma.organizationRolePermission.create({
					data: {
						organizationId: first,
						organizationRoleId: roleId,
						organizationPermissionId: permission.id,
					},
				}),
			).rejects.toMatchObject({ code: 'P2002' });
		} finally {
			await prisma.organizationRolePermission.deleteMany({
				where: {
					organizationId: first,
					organizationRoleId: roleId,
				},
			});
		}
	});

	it('keeps authorization audits immutable and rolls back a failed mutation', async () => {
		const organizationId = await createOrganization();
		const actorMembershipId = await createMembership(organizationId, await createUser());
		const actor = await prisma.organizationMembership.findUniqueOrThrow({
			where: { id: actorMembershipId },
		});
		const targetRoleId = await createRole(organizationId, 'custom.reader', false);
		const auditId = randomUUID();
		await expect(
			prisma.$transaction(async (transaction) => {
				await transaction.organizationAuthorizationAuditEvent.create({
					data: {
						id: auditId,
						organizationId,
						actorMembershipId,
						actorUserId: actor.userId,
						targetRoleId,
						action: 'role_created',
						requestId: `req_${randomUUID()}`,
					},
				});
				await transaction.organizationAuthorizationAuditEvent.updateMany({
					where: { id: auditId },
					data: { action: 'role_disabled' },
				});
			}),
		).rejects.toThrow();
		expect(
			await prisma.organizationAuthorizationAuditEvent.count({
				where: { id: auditId },
			}),
		).toBe(0);
	});

	it('exposes no tenant authorization tables through PUBLIC privileges', async () => {
		const privileges = await prisma.$queryRaw<{ exposed: boolean }[]>`
			SELECT EXISTS (
				SELECT 1 FROM pg_catalog.pg_class AS relation
				CROSS JOIN LATERAL aclexplode(
					COALESCE(relation.relacl, acldefault('r', relation.relowner))
				) AS grant_entry
				WHERE relation.oid IN (
					'public.organization_memberships'::regclass,
					'public.organization_roles'::regclass,
					'public.organization_membership_roles'::regclass,
					'public.organization_permissions'::regclass,
					'public.organization_role_permissions'::regclass,
					'public.organization_authorization_audit_events'::regclass
				) AND grant_entry.grantee = 0
			) AS exposed
		`;
		expect(privileges).toEqual([{ exposed: false }]);
	});

	it('keeps platform authorization separate from organization ownership', async () => {
		const organizationId = await createOrganization();
		const userId = await createUser();
		const membershipId = await createMembership(
			organizationId,
			userId,
			OrganizationMembershipStatus.ACTIVE,
		);
		const roleId = await createRole(organizationId);
		await prisma.organizationMembershipRole.create({
			data: { organizationId, organizationMembershipId: membershipId, organizationRoleId: roleId },
		});

		expect(await prisma.platformStaff.findUnique({ where: { userId } })).toBeNull();
		expect(
			await prisma.organization.findUniqueOrThrow({ where: { id: organizationId } }),
		).toMatchObject({ status: OrganizationStatus.PENDING });
	});

	it('maps the scoped composite foreign keys and organization-leading indexes', async () => {
		const foreignKeys = await prisma.$queryRaw<{ name: string; definition: string }[]>`
			SELECT conname AS name, pg_get_constraintdef(oid) AS definition
			FROM pg_catalog.pg_constraint
			WHERE conrelid = 'public.organization_membership_roles'::regclass AND contype = 'f'
		`;
		expect(foreignKeys).toHaveLength(2);
		for (const foreignKey of foreignKeys) {
			expect(foreignKey.definition).toContain('(organization_id');
			expect(foreignKey.definition).toContain('ON UPDATE RESTRICT ON DELETE RESTRICT');
		}

		const indexes = await prisma.$queryRaw<{ table_name: string; definition: string }[]>`
			SELECT tablename AS table_name, indexdef AS definition FROM pg_catalog.pg_indexes
			WHERE schemaname = 'public' AND tablename IN (
				'organization_memberships', 'organization_roles', 'organization_membership_roles'
			)
		`;
		expect(
			indexes.filter(({ definition }) => definition.includes('(organization_id')).length,
		).toBeGreaterThanOrEqual(6);
	});
});
