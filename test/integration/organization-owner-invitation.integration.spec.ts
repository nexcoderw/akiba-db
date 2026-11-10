import { randomUUID } from 'node:crypto';

import { jest } from '@jest/globals';
import { Test, type TestingModule } from '@nestjs/testing';

import { DatabaseModule } from '../../src/database/database.module.js';
import { PrismaService } from '../../src/database/prisma.service.js';
import {
	OrganizationOwnerInvitationStatus,
	OrganizationOwnershipAuditAction,
	OrganizationStatus,
	PlatformStaffStatus,
	UserStatus,
	type Prisma,
} from '../../src/index.js';
import { OrganizationOwnerInvitationTestFixtures } from './organization-owner-invitation-test-fixtures.js';
import { OrganizationTestFixtures } from './organization-test-fixtures.js';
import { PlatformAdminTestFixtures } from './platform-admin-test-fixtures.js';
import {
	loadDevelopmentDatabaseConfig,
	verifyDevelopmentDatabaseSafety,
	verifyTestTablePrivileges,
	type VerifiedDevelopmentDatabase,
} from './development-database-safety.js';

const safety = loadDevelopmentDatabaseConfig();
const transactionOptions = { maxWait: 30_000, timeout: 60_000 } as const;
const requiredChecks = [
	'organization_owner_invitations_email_check',
	'organization_owner_invitations_display_name_nonblank_check',
	'organization_owner_invitations_lifecycle_check',
	'organization_owner_invitations_timestamp_order_check',
	'organization_ownership_audit_events_request_check',
	'organization_ownership_audit_events_metadata_check',
];

jest.setTimeout(180_000);

describe('organization owner invitation and ownership audit foundation', () => {
	let module: TestingModule | undefined;
	let prisma: PrismaService;
	let verified: VerifiedDevelopmentDatabase | undefined;
	let organizations: OrganizationTestFixtures;
	let identities: PlatformAdminTestFixtures;
	let invitations: OrganizationOwnerInvitationTestFixtures;
	const additionalInvitationFixtures: OrganizationOwnerInvitationTestFixtures[] = [];

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
		const [tables, checks, indexes, triggers] = await Promise.all([
			prisma.$queryRaw<{ name: string | null }[]>`
				SELECT unnest(ARRAY[
					to_regclass('public.organization_memberships')::text,
					to_regclass('public.organization_roles')::text,
					to_regclass('public.organization_owner_invitations')::text,
					to_regclass('public.organization_ownership_audit_events')::text
				]) AS name
			`,
			prisma.$queryRaw<{ name: string }[]>`
				SELECT conname AS name FROM pg_catalog.pg_constraint
				WHERE conrelid IN (
					to_regclass('public.organization_owner_invitations'),
					to_regclass('public.organization_ownership_audit_events')
				) AND contype = 'c' AND convalidated
			`,
			prisma.$queryRaw<{ name: string }[]>`
				SELECT indexname AS name FROM pg_catalog.pg_indexes
				WHERE schemaname = 'public'
					AND tablename = 'organization_owner_invitations'
			`,
			prisma.$queryRaw<{ name: string }[]>`
				SELECT tgname AS name FROM pg_catalog.pg_trigger
				WHERE tgrelid IN (
					to_regclass('public.organization_owner_invitations'),
					to_regclass('public.organization_ownership_audit_events')
				) AND NOT tgisinternal AND tgenabled = 'O'
			`,
		]);
		if (
			tables.some(({ name }) => name === null) ||
			requiredChecks.some((name) => !checks.some((check) => check.name === name)) ||
			!indexes.some(
				({ name }) => name === 'organization_owner_invitations_outstanding_email_key',
			) ||
			!triggers.some(({ name }) => name === 'organization_owner_invitation_identity_guard') ||
			!triggers.some(({ name }) => name === 'organization_ownership_audit_stamp')
		) {
			throw new Error(
				'Owner invitation prerequisites are missing: approve and apply the Step 15 and Step 16 ' +
					'migrations, reviewed constraints, indexes and triggers before integration tests.',
			);
		}
		await verifyTestTablePrivileges(prisma, [
			{
				tableName: 'organization_owner_invitations',
				privileges: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
			},
			{
				tableName: 'organization_ownership_audit_events',
				privileges: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
			},
		]);
		verified = safe;
	});

	beforeEach(() => {
		organizations = new OrganizationTestFixtures();
		identities = new PlatformAdminTestFixtures();
		invitations = new OrganizationOwnerInvitationTestFixtures();
		additionalInvitationFixtures.length = 0;
	});

	afterEach(async () => {
		if (verified === undefined) return;
		for (const fixtures of [...additionalInvitationFixtures, invitations]) {
			await fixtures.cleanup(prisma, verified);
		}
		await organizations.cleanup(prisma, verified);
		await identities.cleanup(prisma, verified);
	});

	afterAll(async () => {
		await module?.close();
	});

	function requireVerified(): VerifiedDevelopmentDatabase {
		if (verified === undefined)
			throw new Error('Owner invitation development database is not verified.');
		return verified;
	}

	async function createOrganization(
		name = 'Kimihurura Supplies',
		status: OrganizationStatus = OrganizationStatus.PENDING,
	): Promise<string> {
		const fixture = organizations.reserve(requireVerified());
		await prisma.organization.create({ data: { ...fixture, name, status } });
		return fixture.id;
	}

	async function createActor(): Promise<string> {
		const userId = identities.reserveUserId();
		const id = identities.reservePlatformStaffId();
		await prisma.user.create({
			data: {
				id: userId,
				email: `owner-invitation-actor-${userId}@example.com`,
				displayName: 'Aline Uwase',
				status: UserStatus.ACTIVE,
				emailVerifiedAt: new Date(),
				platformStaff: { create: { id, status: PlatformStaffStatus.ACTIVE } },
			},
		});
		return id;
	}

	function invitationData(
		organizationId: string,
		invitedByPlatformStaffId: string,
		email = 'owner@example.com',
	): Prisma.OrganizationOwnerInvitationUncheckedCreateInput & { readonly id: string } {
		return {
			id: invitations.reserveInvitationId(requireVerified()),
			organizationId,
			invitedEmail: email,
			invitedDisplayName: 'Aline Uwase',
			invitedByPlatformStaffId,
		};
	}

	function auditData(
		organizationId: string,
		ownerInvitationId: string,
		actorPlatformStaffId: string,
	): Prisma.OrganizationOwnershipAuditEventUncheckedCreateInput & { readonly id: string } {
		return {
			id: invitations.reserveAuditEventId(requireVerified()),
			organizationId,
			ownerInvitationId,
			actorPlatformStaffId,
			action: OrganizationOwnershipAuditAction.INVITATION_CREATED,
			requestId: randomUUID(),
			previousInvitationStatus: null,
			resultingInvitationStatus: OrganizationOwnerInvitationStatus.PENDING_DELIVERY,
			occurredAt: new Date(),
		};
	}

	it('persists a pending invitation and its dedicated audit without issuing access', async () => {
		const organizationId = await createOrganization();
		const actorId = await createActor();
		const data = invitationData(organizationId, actorId);
		const audit = auditData(organizationId, data.id, actorId);

		await prisma.$transaction(async (transaction) => {
			await transaction.organizationOwnerInvitation.create({ data });
			await transaction.organizationOwnershipAuditEvent.create({ data: audit });
		}, transactionOptions);

		const row = await prisma.organizationOwnerInvitation.findUniqueOrThrow({
			where: { id: data.id },
		});
		expect(row).toMatchObject({
			organizationId,
			invitedEmail: 'owner@example.com',
			invitedDisplayName: 'Aline Uwase',
			invitedByPlatformStaffId: actorId,
			status: OrganizationOwnerInvitationStatus.PENDING_DELIVERY,
			tokenDigest: null,
			expiresAt: null,
			sentAt: null,
			acceptedAt: null,
			revokedAt: null,
		});
		expect(await prisma.organizationMembership.count({ where: { organizationId } })).toBe(0);
		expect(await prisma.organizationRole.count({ where: { organizationId } })).toBe(0);
		expect(await prisma.platformStaffRole.count({ where: { platformStaffId: actorId } })).toBe(0);
	});

	it('requires existing organization and platform actor references and restricts deletion', async () => {
		const organizationId = await createOrganization();
		const actorId = await createActor();
		await expect(
			prisma.organizationOwnerInvitation.create({
				data: invitationData(randomUUID(), actorId),
			}),
		).rejects.toMatchObject({ code: 'P2003' });
		await expect(
			prisma.organizationOwnerInvitation.create({
				data: invitationData(organizationId, randomUUID()),
			}),
		).rejects.toMatchObject({ code: 'P2003' });

		const data = invitationData(organizationId, actorId);
		await prisma.organizationOwnerInvitation.create({ data });
		await expect(
			prisma.organization.delete({ where: { id: organizationId } }),
		).rejects.toMatchObject({
			code: 'P2003',
		});
		await expect(prisma.platformStaff.delete({ where: { id: actorId } })).rejects.toMatchObject({
			code: 'P2003',
		});
	});

	it('enforces normalized bounded recipient data and immutable invitation identity', async () => {
		const organizationId = await createOrganization();
		const otherOrganizationId = await createOrganization('Remera Trading');
		const actorId = await createActor();
		const otherActorId = await createActor();
		for (const change of [
			{ invitedEmail: 'Owner@example.com' },
			{ invitedEmail: ' owner@example.com' },
			{ invitedEmail: 'x'.repeat(255) },
			{ invitedDisplayName: '\u00a0' },
			{ invitedDisplayName: 'x'.repeat(161) },
		]) {
			await expect(
				prisma.organizationOwnerInvitation.create({
					data: { ...invitationData(organizationId, actorId), ...change },
				}),
			).rejects.toThrow();
		}

		const data = invitationData(organizationId, actorId);
		await prisma.organizationOwnerInvitation.create({ data });
		await expect(
			prisma.organizationOwnerInvitation.update({
				where: { id: data.id },
				data: { invitedEmail: 'different@example.com' },
			}),
		).rejects.toThrow('invalid invitation identity or lifecycle change');
		await expect(
			prisma.organizationOwnerInvitation.update({
				where: { id: data.id },
				data: { organizationId: otherOrganizationId },
			}),
		).rejects.toThrow('invalid invitation identity or lifecycle change');
		await expect(
			prisma.organizationOwnerInvitation.update({
				where: { id: data.id },
				data: { invitedByPlatformStaffId: otherActorId },
			}),
		).rejects.toThrow('invalid invitation identity or lifecycle change');
	});

	it('uses citext plus enforced lowercase normalization for recipient identity', async () => {
		const columns = await prisma.$queryRaw<{ type: string }[]>`
			SELECT atttypid::regtype::text AS type
			FROM pg_catalog.pg_attribute
			WHERE attrelid = 'public.organization_owner_invitations'::regclass
				AND attname = 'invited_email' AND NOT attisdropped
		`;
		expect(columns).toEqual([{ type: 'citext' }]);

		const organizationId = await createOrganization();
		const actorId = await createActor();
		await prisma.organizationOwnerInvitation.create({
			data: invitationData(organizationId, actorId, 'owner@example.com'),
		});
		await expect(
			prisma.organizationOwnerInvitation.create({
				data: invitationData(organizationId, actorId, 'OWNER@example.com'),
			}),
		).rejects.toThrow('organization_owner_invitations_email_check');
	});

	it('prevents concurrent outstanding duplicates per organization and email', async () => {
		const organizationId = await createOrganization();
		const actorId = await createActor();
		const candidates = [
			invitationData(organizationId, actorId, 'owner@example.com'),
			invitationData(organizationId, actorId, 'owner@example.com'),
		];
		const results = await Promise.allSettled(
			candidates.map((data) => prisma.organizationOwnerInvitation.create({ data })),
		);

		expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
		expect(results.find(({ status }) => status === 'rejected')).toMatchObject({
			status: 'rejected',
			reason: { code: 'P2002' },
		});
	});

	it('allows the same intended owner in different organizations', async () => {
		const actorId = await createActor();
		await prisma.organizationOwnerInvitation.create({
			data: invitationData(await createOrganization('Kimihurura Supplies'), actorId),
		});
		await expect(
			prisma.organizationOwnerInvitation.create({
				data: invitationData(await createOrganization('Remera Trading'), actorId),
			}),
		).resolves.toMatchObject({ invitedEmail: 'owner@example.com' });
	});

	it('enforces delivery lifecycle fields and timestamp ordering', async () => {
		const organizationId = await createOrganization();
		const actorId = await createActor();
		const sentAt = new Date('2030-01-01T00:00:00.000Z');
		const expiresAt = new Date('2030-01-02T00:00:00.000Z');
		await expect(
			prisma.organizationOwnerInvitation.create({
				data: {
					...invitationData(organizationId, actorId),
					status: OrganizationOwnerInvitationStatus.SENT,
					tokenDigest: 'a'.repeat(64),
					sentAt,
					expiresAt,
				},
			}),
		).resolves.toMatchObject({ status: OrganizationOwnerInvitationStatus.SENT });

		await expect(
			prisma.organizationOwnerInvitation.create({
				data: {
					...invitationData(organizationId, actorId, 'second@example.com'),
					status: OrganizationOwnerInvitationStatus.SENT,
					tokenDigest: 'b'.repeat(64),
				},
			}),
		).rejects.toThrow('organization_owner_invitations_lifecycle_check');
		await expect(
			prisma.organizationOwnerInvitation.create({
				data: {
					...invitationData(organizationId, actorId, 'third@example.com'),
					status: OrganizationOwnerInvitationStatus.SENT,
					tokenDigest: 'c'.repeat(64),
					sentAt,
					expiresAt: new Date('2029-12-31T00:00:00.000Z'),
				},
			}),
		).rejects.toThrow('organization_owner_invitations_timestamp_order_check');

		await expect(
			prisma.organizationOwnerInvitation.create({
				data: {
					...invitationData(organizationId, actorId, 'accepted@example.com'),
					status: OrganizationOwnerInvitationStatus.ACCEPTED,
					sentAt,
					expiresAt,
					acceptedAt: new Date('2030-01-01T12:00:00.000Z'),
				},
			}),
		).resolves.toMatchObject({ status: OrganizationOwnerInvitationStatus.ACCEPTED });
		await expect(
			prisma.organizationOwnerInvitation.create({
				data: {
					...invitationData(organizationId, actorId, 'revoked@example.com'),
					status: OrganizationOwnerInvitationStatus.REVOKED,
					revokedAt: new Date('2030-01-01T01:00:00.000Z'),
				},
			}),
		).resolves.toMatchObject({ status: OrganizationOwnerInvitationStatus.REVOKED });
	});

	it('overrides caller-supplied audit persistence time with the database clock', async () => {
		const organizationId = await createOrganization();
		const actorId = await createActor();
		const invitation = invitationData(organizationId, actorId);
		await prisma.organizationOwnerInvitation.create({ data: invitation });
		const supplied = new Date('2000-01-01T00:00:00.000Z');
		const audit = await prisma.organizationOwnershipAuditEvent.create({
			data: {
				...auditData(organizationId, invitation.id, actorId),
				recordedAt: supplied,
			},
		});

		expect(audit.recordedAt).not.toEqual(supplied);
		expect(audit.recordedAt.getTime()).toBeGreaterThan(Date.now() - 60_000);
		expect(audit.recordedAt.getTime()).toBeLessThan(Date.now() + 60_000);
	});

	it('revokes an invitation and appends its audit atomically', async () => {
		const organizationId = await createOrganization();
		const actorId = await createActor();
		const sentAt = new Date('2030-01-01T00:00:00.000Z');
		const data = {
			...invitationData(organizationId, actorId),
			status: OrganizationOwnerInvitationStatus.SENT,
			tokenDigest: 'd'.repeat(64),
			sentAt,
			expiresAt: new Date('2030-01-02T00:00:00.000Z'),
		};
		await prisma.organizationOwnerInvitation.create({ data });
		const revokedAt = new Date('2030-01-01T01:00:00.000Z');
		const audit = {
			...auditData(organizationId, data.id, actorId),
			action: OrganizationOwnershipAuditAction.INVITATION_REVOKED,
			previousInvitationStatus: OrganizationOwnerInvitationStatus.SENT,
			resultingInvitationStatus: OrganizationOwnerInvitationStatus.REVOKED,
		};

		await prisma.$transaction(async (transaction) => {
			await transaction.organizationOwnerInvitation.update({
				where: { id: data.id, status: OrganizationOwnerInvitationStatus.SENT },
				data: {
					status: OrganizationOwnerInvitationStatus.REVOKED,
					tokenDigest: null,
					revokedAt,
				},
			});
			await transaction.organizationOwnershipAuditEvent.create({ data: audit });
		}, transactionOptions);

		expect(
			await prisma.organizationOwnerInvitation.findUnique({ where: { id: data.id } }),
		).toMatchObject({
			status: OrganizationOwnerInvitationStatus.REVOKED,
			tokenDigest: null,
			revokedAt,
		});
		expect(
			await prisma.organizationOwnershipAuditEvent.findUnique({ where: { id: audit.id } }),
		).toMatchObject({ action: OrganizationOwnershipAuditAction.INVITATION_REVOKED });
	});

	it('rejects cross-organization audit linkage and invalid action metadata', async () => {
		const actorId = await createActor();
		const kimihurura = await createOrganization('Kimihurura Supplies');
		const power = await createOrganization('Remera Trading');
		const invitation = invitationData(kimihurura, actorId);
		await prisma.organizationOwnerInvitation.create({ data: invitation });

		await expect(
			prisma.organizationOwnershipAuditEvent.create({
				data: auditData(power, invitation.id, actorId),
			}),
		).rejects.toMatchObject({ code: 'P2003' });
		await expect(
			prisma.organizationOwnershipAuditEvent.create({
				data: {
					...auditData(kimihurura, invitation.id, actorId),
					action: OrganizationOwnershipAuditAction.INVITATION_REVOKED,
				},
			}),
		).rejects.toThrow('organization_ownership_audit_events_metadata_check');
	});

	it('rolls back invitation persistence when its required audit fails', async () => {
		const organizationId = await createOrganization();
		const actorId = await createActor();
		const data = invitationData(organizationId, actorId);
		await expect(
			prisma.$transaction(async (transaction) => {
				await transaction.organizationOwnerInvitation.create({ data });
				await transaction.organizationOwnershipAuditEvent.create({
					data: { ...auditData(organizationId, data.id, actorId), requestId: 'bad request' },
				});
			}, transactionOptions),
		).rejects.toThrow();

		expect(
			await prisma.organizationOwnerInvitation.findUnique({ where: { id: data.id } }),
		).toBeNull();
		expect(
			await prisma.organizationOwnershipAuditEvent.count({ where: { ownerInvitationId: data.id } }),
		).toBe(0);
	});

	it('does not bind an invitation to an existing user with the same email', async () => {
		const userId = identities.reserveUserId();
		await prisma.user.create({
			data: {
				id: userId,
				email: 'existing-owner@example.com',
				displayName: 'Existing User',
				status: UserStatus.ACTIVE,
				emailVerifiedAt: new Date(),
			},
		});
		const organizationId = await createOrganization();
		await prisma.organizationOwnerInvitation.create({
			data: invitationData(organizationId, await createActor(), 'existing-owner@example.com'),
		});

		expect(await prisma.organizationMembership.count({ where: { userId } })).toBe(0);
		expect(await prisma.user.findUniqueOrThrow({ where: { id: userId } })).toMatchObject({
			displayName: 'Existing User',
			status: UserStatus.ACTIVE,
		});
	});

	it('keeps invitation and ownership audit tables unavailable through PUBLIC', async () => {
		const grants = await prisma.$queryRaw<{ count: number }[]>`
			SELECT count(*)::integer AS count FROM pg_catalog.pg_class AS relation
			CROSS JOIN LATERAL aclexplode(
				coalesce(relation.relacl, acldefault('r', relation.relowner))
			) AS grant_entry
			WHERE relation.oid IN (
				'public.organization_owner_invitations'::regclass,
				'public.organization_ownership_audit_events'::regclass
			) AND grant_entry.grantee = 0
		`;
		expect(grants).toEqual([{ count: 0 }]);
	});

	it('cleans only reserved invitation records and preserves an unrelated sentinel', async () => {
		const organizationId = await createOrganization();
		const actorId = await createActor();
		const tracked = invitationData(organizationId, actorId, 'tracked@example.com');
		await prisma.organizationOwnerInvitation.create({ data: tracked });
		const sentinelFixtures = new OrganizationOwnerInvitationTestFixtures();
		additionalInvitationFixtures.push(sentinelFixtures);
		const sentinelId = sentinelFixtures.reserveInvitationId(requireVerified());
		await prisma.organizationOwnerInvitation.create({
			data: {
				...invitationData(organizationId, actorId, 'sentinel@example.com'),
				id: sentinelId,
			},
		});

		await invitations.cleanup(prisma, requireVerified());
		expect(
			await prisma.organizationOwnerInvitation.findUnique({ where: { id: sentinelId } }),
		).not.toBeNull();
	});
});
