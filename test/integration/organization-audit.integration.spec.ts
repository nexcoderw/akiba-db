import { randomUUID } from 'node:crypto';

import { jest } from '@jest/globals';
import { Test, type TestingModule } from '@nestjs/testing';

import { DatabaseModule } from '../../src/database/database.module.js';
import { PrismaService } from '../../src/database/prisma.service.js';
import {
	OrganizationAuditAction,
	OrganizationStatus,
	PlatformAuthorizationAuditAction,
	PlatformAuthorizationAuditOutcome,
	PlatformStaffStatus,
	UserStatus,
	type Prisma,
} from '../../src/index.js';
import { AuditTestFixtures } from './audit-test-fixtures.js';
import { OrganizationTestFixtures } from './organization-test-fixtures.js';
import { PlatformAdminTestFixtures } from './platform-admin-test-fixtures.js';
import {
	loadDevelopmentDatabaseConfig,
	verifyDevelopmentDatabaseSafety,
	type VerifiedDevelopmentDatabase,
} from './development-database-safety.js';

const safety = loadDevelopmentDatabaseConfig();

const options = { maxWait: 10_000, timeout: 20_000 };
const approvedKeys = [
	'platform.organizations.create',
	'platform.organizations.read',
	'platform.organizations.update',
	'platform.organizations.activate',
	'platform.organizations.suspend',
];
const requiredChecks = [
	'organizations_name_nonblank_check',
	'organizations_slug_format_check',
	'organizations_slug_reserved_check',
	'organization_audit_events_request_check',
	'organization_audit_events_metadata_check',
	'organization_audit_events_names_check',
	'platform_authorization_audit_events_approval_check',
	'platform_authorization_audit_events_permissions_check',
];

jest.setTimeout(60_000);

describe('durable organization and authorization audit', () => {
	let module: TestingModule | undefined;
	let prisma: PrismaService;
	let verified: VerifiedDevelopmentDatabase | undefined;
	let audits = new AuditTestFixtures();
	let organizations = new OrganizationTestFixtures();
	let identities = new PlatformAdminTestFixtures();
	const additionalAudits: AuditTestFixtures[] = [];

	beforeAll(async () => {
		module = await Test.createTestingModule({
			imports: [DatabaseModule.forRoot(databaseConfig(safety.databaseUrl))],
		}).compile();
		await module.init();
		prisma = module.get(PrismaService);
		const safe = await verifyDevelopmentDatabaseSafety(prisma, safety);
		const checks = await prisma.$queryRaw<{ name: string }[]>`
			SELECT conname AS name FROM pg_catalog.pg_constraint
			WHERE conrelid IN (to_regclass('public.organizations'),
				to_regclass('public.organization_audit_events'),
				to_regclass('public.platform_authorization_audit_events'))
			AND contype = 'c' AND convalidated
		`;
		if (requiredChecks.some((name) => !checks.some((check) => check.name === name))) {
			throw new Error(
				'Apply the reviewed audit migration and all validated CHECK constraints first.',
			);
		}
		const triggers = await prisma.$queryRaw<{ name: string }[]>`
			SELECT tgname AS name FROM pg_catalog.pg_trigger
			WHERE tgrelid IN (to_regclass('public.organization_audit_events'),
				to_regclass('public.platform_authorization_audit_events'))
			AND NOT tgisinternal AND tgenabled = 'O'
		`;
		for (const name of ['organization_audit_stamp', 'platform_authorization_audit_stamp']) {
			if (!triggers.some((trigger) => trigger.name === name)) {
				throw new Error('Reviewed audit stamping triggers are missing or disabled.');
			}
		}
		// No fixture or cleanup authorization until every target/schema/privilege precondition passes.
		verified = safe;
	});

	beforeEach(() => {
		audits = new AuditTestFixtures();
		organizations = new OrganizationTestFixtures();
		identities = new PlatformAdminTestFixtures();
		additionalAudits.length = 0;
	});

	afterEach(async () => {
		if (verified === undefined) return;
		// A failed audit cleanup must NOT cause deletion of its referenced parents.
		for (const fixtures of [...additionalAudits, audits]) {
			await fixtures.cleanup(prisma, verified);
		}
		await organizations.cleanup(prisma, verified);
		await identities.cleanup(prisma, verified);
	});

	afterAll(async () => {
		await module?.close();
	});

	function requireVerified(): VerifiedDevelopmentDatabase {
		if (verified === undefined) throw new Error('Audit test prerequisites did not pass.');
		return verified;
	}

	async function actor(): Promise<string> {
		requireVerified();
		const userId = identities.reserveUserId();
		const id = identities.reservePlatformStaffId();
		await prisma.user.create({
			data: {
				id: userId,
				email: `audit-${userId}@example.com`,
				displayName: 'Aline Uwase',
				status: UserStatus.ACTIVE,
				emailVerifiedAt: new Date(),
				platformStaff: { create: { id, status: PlatformStaffStatus.ACTIVE } },
			},
		});
		return id;
	}

	async function organization(): Promise<string> {
		const fixture = organizations.reserve(requireVerified());
		await prisma.organization.create({ data: { ...fixture, name: 'Kimihurura Supplies' } });
		return fixture.id;
	}

	function event(
		organizationId: string,
		staffId: string,
	): Prisma.OrganizationAuditEventUncheckedCreateInput & { readonly id: string } {
		return {
			...audits.reserveOrganizationEvent(requireVerified(), organizationId, staffId),
			requestId: randomUUID(),
			action: OrganizationAuditAction.CREATE,
			previousStatus: null,
			resultingStatus: OrganizationStatus.PENDING,
			changedFields: ['name', 'slug', 'status'],
			previousName: null,
			resultingName: 'Kimihurura Supplies',
			occurredAt: new Date(),
		};
	}

	async function authorizationEvent(): Promise<
		Prisma.PlatformAuthorizationAuditEventUncheckedCreateInput & { readonly id: string }
	> {
		const staffId = await actor();
		const roleId = identities.reservePlatformRoleId();
		await prisma.platformRole.create({
			data: {
				id: roleId,
				key: `audit-role.${roleId}`,
				name: 'Audit fixture',
				description: 'Test only',
			},
		});
		return {
			...audits.reserveAuthorizationEvent(requireVerified(), staffId, roleId),
			action: PlatformAuthorizationAuditAction.PROVISION_ORGANIZATION_MANAGER,
			approvedPermissionKeys: [...approvedKeys],
			grantedPermissionKeys: [...approvedKeys],
			approvalReference: 'CHANGE-TEST-12',
			outcome: PlatformAuthorizationAuditOutcome.GRANTED,
			occurredAt: new Date(),
		};
	}

	it('records a valid create event with restrictive identities and a database persistence clock', async () => {
		const data = event(await organization(), await actor());
		const row = await prisma.organizationAuditEvent.create({
			data: { ...data, recordedAt: new Date('2000-01-01T00:00:00.000Z') },
		});
		expect(row).toMatchObject({
			id: data.id,
			requestId: data.requestId,
			organizationId: data.organizationId,
			actorPlatformStaffId: data.actorPlatformStaffId,
			changedFields: ['name', 'slug', 'status'],
		});
		expect(row.recordedAt.getTime()).toBeGreaterThan(Date.now() - 60_000);
		expect(row.recordedAt.getTime()).toBeLessThan(Date.now() + 60_000);
	});

	it.each(['organization', 'actor'] as const)(
		'rejects a nonexistent %s reference',
		async (reference) => {
			const organizationId = reference === 'organization' ? randomUUID() : await organization();
			const staffId = reference === 'actor' ? randomUUID() : await actor();
			await expect(
				prisma.organizationAuditEvent.create({ data: event(organizationId, staffId) }),
			).rejects.toMatchObject({ code: 'P2003' });
		},
	);

	it.each(['', 'bad\nrequest', 'has space', 'x'.repeat(129)])(
		'rejects unsafe request IDs: %#',
		async (requestId) => {
			const data = event(await organization(), await actor());
			await expect(
				prisma.organizationAuditEvent.create({ data: { ...data, requestId } }),
			).rejects.toThrow();
		},
	);

	it.each(['secret', 'authorization', 'cookie', 'password'])(
		'rejects nonallowlisted metadata: %s',
		async (field) => {
			const data = event(await organization(), await actor());
			await expect(
				prisma.organizationAuditEvent.create({ data: { ...data, changedFields: [field] } }),
			).rejects.toThrow();
		},
	);

	it.each([
		{
			action: OrganizationAuditAction.UPDATE,
			previousStatus: OrganizationStatus.PENDING,
			resultingStatus: OrganizationStatus.PENDING,
			changedFields: ['name'],
			previousName: 'Kimihurura Supplies',
			resultingName: 'Remera Trading',
		},
		{
			action: OrganizationAuditAction.ACTIVATE,
			previousStatus: OrganizationStatus.PENDING,
			resultingStatus: OrganizationStatus.ACTIVE,
			changedFields: ['status', 'activatedAt'],
			previousName: null,
			resultingName: null,
		},
		{
			action: OrganizationAuditAction.SUSPEND,
			previousStatus: OrganizationStatus.ACTIVE,
			resultingStatus: OrganizationStatus.SUSPENDED,
			changedFields: ['status', 'suspendedAt'],
			previousName: null,
			resultingName: null,
		},
		{
			action: OrganizationAuditAction.ARCHIVE,
			previousStatus: OrganizationStatus.SUSPENDED,
			resultingStatus: OrganizationStatus.ARCHIVED,
			changedFields: ['status', 'archivedAt'],
			previousName: null,
			resultingName: null,
		},
	])('persists action-specific history for $action', async (change) => {
		const data = event(await organization(), await actor());
		await expect(
			prisma.organizationAuditEvent.create({ data: { ...data, ...change } }),
		).resolves.toMatchObject(change);
	});

	it('rejects illegal lifecycle metadata, missing prior state and unbounded names', async () => {
		const data = event(await organization(), await actor());
		for (const change of [
			{ resultingStatus: OrganizationStatus.ACTIVE },
			{ changedFields: [] },
			{ changedFields: ['name', 'name', 'status'] },
			{ resultingName: '\u00a0' },
			{ resultingName: 'x'.repeat(161) },
			{
				action: OrganizationAuditAction.UPDATE,
				changedFields: ['name'],
				previousName: 'Kimihurura Supplies',
			},
		]) {
			await expect(
				prisma.organizationAuditEvent.create({ data: { ...data, ...change } }),
			).rejects.toThrow();
		}
	});

	it('rejects missing required values and unknown enum actions for raw SQL writers', async () => {
		const data = event(await organization(), await actor());
		for (const action of ['create', 'unknown']) {
			await expect(prisma.$executeRaw`
				INSERT INTO public.organization_audit_events
				(id, organization_id, actor_platform_staff_id, request_id, action, resulting_status,
				 changed_fields, resulting_name, occurred_at)
				VALUES (${data.id}::uuid, ${data.organizationId}::uuid,
				 ${data.actorPlatformStaffId}::uuid, NULL, ${action}::public.organization_audit_action,
				 'pending', ARRAY['name', 'slug', 'status'], 'Kimihurura Supplies', now())
			`).rejects.toThrow();
		}
	});

	it('commits mutation and audit together and rolls back both after a late failure', async () => {
		const id = await organization();
		const staffId = await actor();
		const data = {
			...event(id, staffId),
			action: OrganizationAuditAction.UPDATE,
			previousStatus: OrganizationStatus.PENDING,
			changedFields: ['name'],
			previousName: 'Kimihurura Supplies',
			resultingName: 'Remera Trading',
		};
		await prisma.$transaction(async (transaction) => {
			await transaction.organization.update({ where: { id }, data: { name: 'Remera Trading' } });
			await transaction.organizationAuditEvent.create({ data });
		}, options);
		expect(await prisma.organization.findUnique({ where: { id } })).toMatchObject({
			name: 'Remera Trading',
		});
		expect(await prisma.organizationAuditEvent.count({ where: { organizationId: id } })).toBe(1);
		const failed = {
			...event(id, staffId),
			action: OrganizationAuditAction.UPDATE,
			previousStatus: OrganizationStatus.PENDING,
			changedFields: ['name'],
			previousName: 'Remera Trading',
			resultingName: 'Remera Supplies',
		};
		await expect(
			prisma.$transaction(async (transaction) => {
				await transaction.organization.update({ where: { id }, data: { name: 'Remera Supplies' } });
				await transaction.organizationAuditEvent.create({ data: failed });
				throw new Error('Intentional failure after audit insertion');
			}, options),
		).rejects.toThrow('Intentional failure');
		expect(await prisma.organization.findUnique({ where: { id } })).toMatchObject({
			name: 'Remera Trading',
		});
		expect(await prisma.organizationAuditEvent.count({ where: { organizationId: id } })).toBe(1);
	});

	it('rolls back a newly created organization when audit insertion fails', async () => {
		const fixture = organizations.reserve(requireVerified());
		const data = event(fixture.id, await actor());
		await expect(
			prisma.$transaction(async (transaction) => {
				await transaction.organization.create({
					data: { ...fixture, name: 'Kimihurura Supplies' },
				});
				await transaction.organizationAuditEvent.create({
					data: { ...data, requestId: 'bad request' },
				});
			}, options),
		).rejects.toThrow();
		expect(await prisma.organization.findUnique({ where: { id: fixture.id } })).toBeNull();
		expect(await prisma.organizationAuditEvent.findUnique({ where: { id: data.id } })).toBeNull();
	});

	it('retains organization and actor references when deletion is attempted', async () => {
		const id = await organization();
		const staffId = await actor();
		await prisma.organizationAuditEvent.create({ data: event(id, staffId) });
		await expect(prisma.organization.delete({ where: { id } })).rejects.toMatchObject({
			code: 'P2003',
		});
		await expect(prisma.platformStaff.delete({ where: { id: staffId } })).rejects.toMatchObject({
			code: 'P2003',
		});
	});

	it('rolls back failed archival and retains the record and previous audit after successful archival', async () => {
		const id = await organization();
		const staffId = await actor();
		const created = event(id, staffId);
		await prisma.organizationAuditEvent.create({ data: created });
		const archived = {
			...event(id, staffId),
			action: OrganizationAuditAction.ARCHIVE,
			previousStatus: OrganizationStatus.PENDING,
			resultingStatus: OrganizationStatus.ARCHIVED,
			changedFields: ['status', 'archivedAt'],
			previousName: null,
			resultingName: null,
		};
		await expect(
			prisma.$transaction(async (transaction) => {
				await transaction.organization.update({
					where: { id },
					data: { status: OrganizationStatus.ARCHIVED, archivedAt: new Date() },
				});
				await transaction.organizationAuditEvent.create({
					data: { ...archived, requestId: 'invalid request' },
				});
			}, options),
		).rejects.toThrow();
		expect(await prisma.organization.findUnique({ where: { id } })).toMatchObject({
			status: OrganizationStatus.PENDING,
			archivedAt: null,
		});
		const archivedAt = new Date();
		await prisma.$transaction(async (transaction) => {
			await transaction.organization.update({
				where: { id },
				data: { status: OrganizationStatus.ARCHIVED, archivedAt },
			});
			await transaction.organizationAuditEvent.create({ data: archived });
		}, options);
		expect(await prisma.organization.findUnique({ where: { id } })).toMatchObject({
			status: OrganizationStatus.ARCHIVED,
			archivedAt,
		});
		expect(await prisma.organizationAuditEvent.count({ where: { organizationId: id } })).toBe(2);
		await expect(prisma.organization.delete({ where: { id } })).rejects.toMatchObject({
			code: 'P2003',
		});
	});

	it('derives authorization operator identity and recordedAt despite spoofed values', async () => {
		const data = await authorizationEvent();
		const row = await prisma.platformAuthorizationAuditEvent.create({
			data: {
				...data,
				operatorSessionRole: 'spoofed',
				operatorDatabaseRole: 'spoofed',
				databaseName: 'spoofed',
				recordedAt: new Date('2000-01-01T00:00:00.000Z'),
			},
		});
		expect(row.operatorDatabaseRole).toBe(safety.databaseUser);
		expect(row.operatorSessionRole).toBe(safety.databaseUser);
		expect(row.databaseName).toBe(safety.databaseName);
		expect(row.recordedAt.getTime()).toBeGreaterThan(Date.now() - 60_000);
		await expect(
			prisma.platformRole.delete({ where: { id: data.targetPlatformRoleId } }),
		).rejects.toMatchObject({ code: 'P2003' });
	});

	it('rejects arbitrary permissions, ambiguous grant outcomes and missing approval references', async () => {
		const data = await authorizationEvent();
		for (const change of [
			{ approvedPermissionKeys: ['platform.dashboard.read'] },
			{ approvedPermissionKeys: [...approvedKeys, approvedKeys[0] ?? 'invalid'] },
			{ grantedPermissionKeys: [] },
			{ approvalReference: '' },
			{ approvalReference: 'bad\nreference' },
			{ outcome: PlatformAuthorizationAuditOutcome.ALREADY_GRANTED },
		]) {
			await expect(
				prisma.platformAuthorizationAuditEvent.create({ data: { ...data, ...change } }),
			).rejects.toThrow();
		}
		await expect(
			prisma.platformAuthorizationAuditEvent.create({
				data: {
					...data,
					grantedPermissionKeys: [],
					outcome: PlatformAuthorizationAuditOutcome.ALREADY_GRANTED,
				},
			}),
		).resolves.toMatchObject({ grantedPermissionKeys: [] });
	});

	it.each(['staff', 'role'] as const)(
		'rejects authorization events with nonexistent %s references',
		async (reference) => {
			const data = await authorizationEvent();
			const invalid =
				reference === 'staff'
					? { targetPlatformStaffId: randomUUID() }
					: { targetPlatformRoleId: randomUUID() };
			await expect(
				prisma.platformAuthorizationAuditEvent.create({ data: { ...data, ...invalid } }),
			).rejects.toMatchObject({ code: 'P2003' });
		},
	);

	it('commits a permission assignment and authorization audit atomically', async () => {
		const data = await authorizationEvent();
		await prisma.$transaction(async (transaction) => {
			await transaction.platformStaffRole.create({
				data: {
					platformStaffId: data.targetPlatformStaffId,
					platformRoleId: data.targetPlatformRoleId,
				},
			});
			await transaction.platformAuthorizationAuditEvent.create({ data });
		}, options);
		expect(
			await prisma.platformStaffRole.count({
				where: { platformStaffId: data.targetPlatformStaffId },
			}),
		).toBe(1);
		expect(
			await prisma.platformAuthorizationAuditEvent.findUnique({ where: { id: data.id } }),
		).not.toBeNull();
	});

	it('rolls back new role permission links and staff assignment if authorization auditing fails', async () => {
		const data = await authorizationEvent();
		const permissionId = identities.reservePlatformPermissionId();
		await expect(
			prisma.$transaction(async (transaction) => {
				await transaction.platformPermission.create({
					data: {
						id: permissionId,
						key: `audit-permission.${permissionId}`,
						description: 'Test fixture',
					},
				});
				await transaction.platformRolePermission.create({
					data: {
						platformRoleId: data.targetPlatformRoleId,
						platformPermissionId: permissionId,
					},
				});
				await transaction.platformStaffRole.create({
					data: {
						platformStaffId: data.targetPlatformStaffId,
						platformRoleId: data.targetPlatformRoleId,
					},
				});
				await transaction.platformAuthorizationAuditEvent.create({
					data: { ...data, approvalReference: '' },
				});
			}, options),
		).rejects.toThrow();
		expect(
			await prisma.platformStaffRole.count({
				where: { platformStaffId: data.targetPlatformStaffId },
			}),
		).toBe(0);
		expect(
			await prisma.platformRolePermission.count({
				where: { platformRoleId: data.targetPlatformRoleId },
			}),
		).toBe(0);
		expect(await prisma.platformPermission.findUnique({ where: { id: permissionId } })).toBeNull();
		expect(
			await prisma.platformAuthorizationAuditEvent.findUnique({ where: { id: data.id } }),
		).toBeNull();
	});

	it('does not grant PUBLIC table or column access to either audit table', async () => {
		const grants = await prisma.$queryRaw<{ count: number }[]>`
			SELECT count(*)::integer AS count FROM (
			 SELECT a.grantee FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
			 CROSS JOIN LATERAL aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
			 WHERE n.nspname = 'public' AND c.relname IN
			 ('organization_audit_events', 'platform_authorization_audit_events')
			 UNION ALL
			 SELECT a.grantee FROM pg_attribute att JOIN pg_class c ON c.oid = att.attrelid
			 JOIN pg_namespace n ON n.oid = c.relnamespace
			 CROSS JOIN LATERAL aclexplode(att.attacl) a
			 WHERE n.nspname = 'public' AND c.relname IN
			 ('organization_audit_events', 'platform_authorization_audit_events')
			) grants WHERE grantee = 0
		`;
		expect(grants).toEqual([{ count: 0 }]);
	});

	it('cleans only reserved audit identifiers and preserves an unrelated sentinel', async () => {
		const data = event(await organization(), await actor());
		await prisma.organizationAuditEvent.create({ data });
		const second = new AuditTestFixtures();
		additionalAudits.push(second);
		const fixture = second.reserveOrganizationEvent(
			requireVerified(),
			data.organizationId,
			data.actorPlatformStaffId,
		);
		await prisma.organizationAuditEvent.create({ data: { ...data, ...fixture } });
		await second.cleanup(prisma, requireVerified());
		expect(
			await prisma.organizationAuditEvent.findUnique({ where: { id: data.id } }),
		).not.toBeNull();
	});
});

function databaseConfig(databaseUrl: string) {
	return { databaseUrl, poolMax: 2, connectionTimeoutMilliseconds: 15_000 };
}
