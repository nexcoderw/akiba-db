import { createHash, randomUUID } from 'node:crypto';

import { jest } from '@jest/globals';
import { Test, type TestingModule } from '@nestjs/testing';

import { DatabaseModule } from '../../src/database/database.module.js';
import { PrismaService } from '../../src/database/prisma.service.js';
import {
	OrganizationMembershipStatus,
	OrganizationOwnerEnrollmentPurpose,
	OrganizationOwnerEnrollmentStatus,
	OrganizationOwnerInvitationStatus,
	PlatformStaffStatus,
	UserStatus,
	type Prisma,
} from '../../src/index.js';
import { OrganizationMembershipTestFixtures } from './organization-membership-test-fixtures.js';
import { OrganizationOwnerInvitationTestFixtures } from './organization-owner-invitation-test-fixtures.js';
import { OrganizationTestFixtures } from './organization-test-fixtures.js';
import { OwnerEnrollmentTestFixtures } from './owner-enrollment-test-fixtures.js';
import { PlatformAdminTestFixtures } from './platform-admin-test-fixtures.js';
import {
	loadDevelopmentDatabaseConfig,
	verifyDevelopmentDatabaseSafety,
	verifyTestTablePrivileges,
	type VerifiedDevelopmentDatabase,
} from './development-database-safety.js';

const safety = loadDevelopmentDatabaseConfig();
const transactionOptions = { maxWait: 10_000, timeout: 20_000 } as const;
const requiredChecks = [
	'owner_enrollment_challenges_lifecycle_check',
	'owner_enrollment_challenges_attempts_check',
	'owner_enrollment_challenges_timestamps_check',
	'owner_enrollment_challenges_digest_check',
	'owner_acceptance_audit_events_request_check',
];
const requiredTriggers = [
	'owner_enrollment_challenge_guard',
	'owner_acceptance_audit_guard',
	'owner_acceptance_audit_stamp',
];

jest.setTimeout(60_000);

describe('owner enrollment proof and recipient acceptance audit foundation', () => {
	let module: TestingModule | undefined;
	let prisma: PrismaService;
	let verified: VerifiedDevelopmentDatabase | undefined;
	let organizations: OrganizationTestFixtures;
	let identities: PlatformAdminTestFixtures;
	let invitations: OrganizationOwnerInvitationTestFixtures;
	let memberships: OrganizationMembershipTestFixtures;
	let enrollments: OwnerEnrollmentTestFixtures;
	const sentinelFixtures: OwnerEnrollmentTestFixtures[] = [];

	beforeAll(async () => {
		module = await Test.createTestingModule({
			imports: [
				DatabaseModule.forRoot({
					databaseUrl: safety.databaseUrl,
					poolMax: 3,
					connectionTimeoutMilliseconds: 10_000,
				}),
			],
		}).compile();
		await module.init();
		prisma = module.get(PrismaService);
		const safe = await verifyDevelopmentDatabaseSafety(prisma, safety);
		const tables = await prisma.$queryRaw<{ name: string; relation: string | null }[]>`
			SELECT expected.name, to_regclass(expected.name)::text AS relation
			FROM (VALUES
				('public.organization_owner_enrollment_challenges'),
				('public.organization_owner_acceptance_audit_events')
			) AS expected(name)
		`;
		const checks = await prisma.$queryRaw<{ name: string }[]>`
			SELECT conname AS name FROM pg_catalog.pg_constraint
			WHERE conrelid IN (
				to_regclass('public.organization_owner_enrollment_challenges'),
				to_regclass('public.organization_owner_acceptance_audit_events')
			) AND contype = 'c' AND convalidated
		`;
		const triggers = await prisma.$queryRaw<{ name: string }[]>`
			SELECT tgname AS name FROM pg_catalog.pg_trigger
			WHERE tgrelid IN (
				to_regclass('public.organization_owner_enrollment_challenges'),
				to_regclass('public.organization_owner_acceptance_audit_events')
			) AND NOT tgisinternal AND tgenabled IN ('O', 'A')
		`;
		const missing = [
			...tables.filter(({ relation }) => relation === null).map(({ name }) => `table ${name}`),
			...requiredChecks
				.filter((name) => !checks.some((check) => check.name === name))
				.map((name) => `validated check ${name}`),
			...requiredTriggers
				.filter((name) => !triggers.some((trigger) => trigger.name === name))
				.map((name) => `enabled trigger ${name}`),
		];
		if (missing.length > 0) {
			throw new Error(
				`Owner enrollment prerequisites are missing: ${missing.join('; ')}. ` +
					'Review the Step 19 foundation and forward hardening on the approved ' +
					'development branch. Migration status alone does not prove these protections exist; ' +
					'do not rewrite an applied foundation or bypass this preflight.',
			);
		}
		await verifyTestTablePrivileges(
			prisma,
			[
				'organizations',
				'users',
				'platform_staff',
				'organization_memberships',
				'organization_roles',
				'organization_membership_roles',
				'organization_owner_invitations',
				'organization_ownership_audit_events',
				'organization_owner_enrollment_challenges',
				'organization_owner_acceptance_audit_events',
			].map((tableName) => ({
				tableName,
				privileges: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'] as const,
			})),
		);
		verified = safe;
	});

	beforeEach(() => {
		organizations = new OrganizationTestFixtures();
		identities = new PlatformAdminTestFixtures();
		invitations = new OrganizationOwnerInvitationTestFixtures();
		memberships = new OrganizationMembershipTestFixtures();
		enrollments = new OwnerEnrollmentTestFixtures();
		sentinelFixtures.length = 0;
	});

	afterEach(async () => {
		if (verified === undefined) return;
		for (const fixture of [...sentinelFixtures, enrollments]) {
			await fixture.cleanup(prisma, verified);
		}
		await memberships.cleanup(prisma, verified);
		await invitations.cleanup(prisma, verified);
		await organizations.cleanup(prisma, verified);
		await identities.cleanup(prisma, verified);
	});

	afterAll(async () => {
		await module?.close();
	});

	function safeDatabase(): VerifiedDevelopmentDatabase {
		if (verified === undefined) throw new Error('Enrollment fixture database is not verified.');
		return verified;
	}

	async function databaseNow(): Promise<Date> {
		const [row] = await prisma.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
		if (row === undefined) throw new Error('Database clock is unavailable.');
		return row.now;
	}

	async function createContext() {
		const now = await databaseNow();
		const organization = organizations.reserve(safeDatabase());
		await prisma.organization.create({ data: { ...organization, name: 'Kigali Training Club' } });
		const actorId = identities.reserveUserId();
		const staffId = identities.reservePlatformStaffId();
		await prisma.user.create({
			data: {
				id: actorId,
				email: `inviter-${actorId}@example.com`,
				displayName: 'Fictional Inviter',
				status: UserStatus.ACTIVE,
				platformStaff: { create: { id: staffId, status: PlatformStaffStatus.ACTIVE } },
			},
		});
		const userId = identities.reserveUserId();
		const email = `recipient-${userId}@example.com`;
		await prisma.user.create({
			data: {
				id: userId,
				email,
				displayName: 'Fictional Recipient',
				status: UserStatus.ACTIVE,
				emailVerifiedAt: now,
			},
		});
		const invitationId = invitations.reserveInvitationId(safeDatabase());
		// Synthetic persistence fixture only; this never sends email or activates a runtime endpoint.
		await prisma.organizationOwnerInvitation.create({
			data: {
				id: invitationId,
				organizationId: organization.id,
				invitedByPlatformStaffId: staffId,
				invitedEmail: email,
				invitedDisplayName: 'Fictional Recipient',
				status: OrganizationOwnerInvitationStatus.SENT,
				tokenDigest: createHash('sha256').update(randomUUID()).digest('hex'),
				createdAt: new Date(now.getTime() - 60_000),
				sentAt: now,
				expiresAt: new Date(now.getTime() + 3_600_000),
			},
		});
		return { organizationId: organization.id, invitationId, userId, now };
	}

	type Context = Awaited<ReturnType<typeof createContext>>;

	function challengeData(
		context: Context,
	): Prisma.OrganizationOwnerEnrollmentChallengeUncheckedCreateInput & { readonly id: string } {
		return {
			id: enrollments.reserveChallengeId(safeDatabase()),
			organizationId: context.organizationId,
			ownerInvitationId: context.invitationId,
			purpose: OrganizationOwnerEnrollmentPurpose.EXISTING_USER_AUTHENTICATION,
			tokenDigest: createHash('sha256').update(randomUUID()).digest('hex'),
			createdAt: context.now,
			expiresAt: new Date(context.now.getTime() + 600_000),
		};
	}

	async function verifiedChallenge(context: Context): Promise<string> {
		const challenge = challengeData(context);
		await prisma.organizationOwnerEnrollmentChallenge.create({ data: challenge });
		await prisma.organizationOwnerEnrollmentChallenge.update({
			where: { id: challenge.id },
			data: {
				status: OrganizationOwnerEnrollmentStatus.VERIFIED,
				userId: context.userId,
				mailboxVerifiedAt: context.now,
				authenticatedAt: context.now,
				verifiedAt: context.now,
			},
		});
		return challenge.id;
	}

	it('keeps pending proof unbound and grants no membership, role or session', async () => {
		const context = await createContext();
		const data = challengeData(context);
		const challenge = await prisma.organizationOwnerEnrollmentChallenge.create({ data });
		expect(challenge).toMatchObject({
			userId: null,
			status: OrganizationOwnerEnrollmentStatus.PENDING,
			verifiedAt: null,
			consumedAt: null,
			failedAttempts: 0,
		});
		expect(
			await prisma.organizationMembership.count({
				where: { organizationId: context.organizationId },
			}),
		).toBe(0);
		expect(
			await prisma.organizationRole.count({ where: { organizationId: context.organizationId } }),
		).toBe(0);
		expect(
			await prisma.platformAdminSession.count({
				where: { platformStaff: { userId: context.userId } },
			}),
		).toBe(0);
	});

	it('rejects a cross-organization challenge and duplicate challenge digest', async () => {
		const first = await createContext();
		const second = await createContext();
		await expect(
			prisma.organizationOwnerEnrollmentChallenge.create({
				data: { ...challengeData(first), ownerInvitationId: second.invitationId },
			}),
		).rejects.toThrow();
		const data = challengeData(first);
		await prisma.organizationOwnerEnrollmentChallenge.create({ data });
		await expect(
			prisma.organizationOwnerEnrollmentChallenge.create({
				data: { ...data, id: enrollments.reserveChallengeId(safeDatabase()) },
			}),
		).rejects.toMatchObject({ code: 'P2002' });
	});

	it('rejects verification without identity evidence and bounds failed attempts', async () => {
		const context = await createContext();
		const data = challengeData(context);
		await prisma.organizationOwnerEnrollmentChallenge.create({ data });
		await expect(
			prisma.organizationOwnerEnrollmentChallenge.update({
				where: { id: data.id },
				data: { status: OrganizationOwnerEnrollmentStatus.VERIFIED, verifiedAt: context.now },
			}),
		).rejects.toThrow();
		await expect(
			prisma.organizationOwnerEnrollmentChallenge.update({
				where: { id: data.id },
				data: { failedAttempts: 6 },
			}),
		).rejects.toThrow();
		await prisma.organizationOwnerEnrollmentChallenge.update({
			where: { id: data.id },
			data: { failedAttempts: 1 },
		});
		await expect(
			prisma.organizationOwnerEnrollmentChallenge.update({
				where: { id: data.id },
				data: { failedAttempts: 0 },
			}),
		).rejects.toThrow();
	});

	it('rejects verification of expired or revoked challenges and invitations', async () => {
		const context = await createContext();
		const expired = challengeData(context);
		await prisma.organizationOwnerEnrollmentChallenge.create({
			data: {
				...expired,
				createdAt: new Date(context.now.getTime() - 120_000),
				expiresAt: new Date(context.now.getTime() - 60_000),
			},
		});
		await expect(
			prisma.organizationOwnerEnrollmentChallenge.update({
				where: { id: expired.id },
				data: {
					status: OrganizationOwnerEnrollmentStatus.VERIFIED,
					userId: context.userId,
					mailboxVerifiedAt: context.now,
					authenticatedAt: context.now,
					verifiedAt: context.now,
				},
			}),
		).rejects.toThrow();
		const data = challengeData(context);
		await prisma.organizationOwnerEnrollmentChallenge.create({ data });
		await prisma.organizationOwnerInvitation.update({
			where: { id: context.invitationId },
			data: {
				status: OrganizationOwnerInvitationStatus.REVOKED,
				revokedAt: context.now,
				tokenDigest: null,
			},
		});
		await expect(
			prisma.organizationOwnerEnrollmentChallenge.update({
				where: { id: data.id },
				data: {
					status: OrganizationOwnerEnrollmentStatus.VERIFIED,
					userId: context.userId,
					mailboxVerifiedAt: context.now,
					authenticatedAt: context.now,
					verifiedAt: context.now,
				},
			}),
		).rejects.toThrow();
	});

	/** Persistence contract fixture, not the future API's recipient authentication implementation. */
	async function acceptanceTransaction(
		context: Context,
		challengeId: string,
		requestId: string = randomUUID(),
	): Promise<{ readonly membershipId: string; readonly auditId: string }> {
		const membershipId = memberships.reserveMembershipId(safeDatabase());
		const roleId = memberships.reserveRoleId(safeDatabase());
		const auditId = enrollments.reserveAuditId(safeDatabase());
		return prisma.$transaction(async (transaction) => {
			await transaction.$queryRaw`
				SELECT id FROM public.organizations WHERE id = ${context.organizationId}::uuid FOR UPDATE
			`;
			await transaction.$queryRaw`
				SELECT id FROM public.organization_owner_invitations
				WHERE id = ${context.invitationId}::uuid
					AND organization_id = ${context.organizationId}::uuid FOR UPDATE
			`;
			await transaction.$queryRaw`
				SELECT id FROM public.users WHERE id = ${context.userId}::uuid FOR UPDATE
			`;
			const [clock] = await transaction.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
			if (clock === undefined) throw new Error('Database clock is unavailable.');
			const consumed = await transaction.organizationOwnerEnrollmentChallenge.updateMany({
				where: {
					id: challengeId,
					organizationId: context.organizationId,
					ownerInvitationId: context.invitationId,
					userId: context.userId,
					status: OrganizationOwnerEnrollmentStatus.VERIFIED,
					expiresAt: { gt: clock.now },
				},
				data: {
					status: OrganizationOwnerEnrollmentStatus.CONSUMED,
					consumedAt: clock.now,
					tokenDigest: null,
				},
			});
			if (consumed.count !== 1) throw new Error('The enrollment proof is unavailable.');
			const invitation = await transaction.organizationOwnerInvitation.updateMany({
				where: {
					id: context.invitationId,
					organizationId: context.organizationId,
					status: OrganizationOwnerInvitationStatus.SENT,
					expiresAt: { gt: clock.now },
				},
				data: {
					status: OrganizationOwnerInvitationStatus.ACCEPTED,
					tokenDigest: null,
					acceptedAt: clock.now,
				},
			});
			if (invitation.count !== 1) throw new Error('The invitation is unavailable.');
			await transaction.organizationMembership.create({
				data: {
					id: membershipId,
					organizationId: context.organizationId,
					userId: context.userId,
					status: OrganizationMembershipStatus.ACTIVE,
					activatedAt: clock.now,
				},
			});
			await transaction.organizationRole.create({
				data: {
					id: roleId,
					organizationId: context.organizationId,
					key: 'owner',
					name: 'Owner',
					isSystem: true,
				},
			});
			await transaction.organizationMembershipRole.create({
				data: {
					organizationId: context.organizationId,
					organizationMembershipId: membershipId,
					organizationRoleId: roleId,
				},
			});
			await transaction.organizationOwnerAcceptanceAuditEvent.create({
				data: {
					id: auditId,
					organizationId: context.organizationId,
					ownerInvitationId: context.invitationId,
					enrollmentChallengeId: challengeId,
					actorUserId: context.userId,
					organizationMembershipId: membershipId,
					requestId,
					occurredAt: clock.now,
					recordedAt: new Date(0),
				},
			});
			return { membershipId, auditId };
		}, transactionOptions);
	}

	it('consumes proof once and records the actual recipient without activating the organization', async () => {
		const context = await createContext();
		const challengeId = await verifiedChallenge(context);
		const result = await acceptanceTransaction(context, challengeId);
		const audit = await prisma.organizationOwnerAcceptanceAuditEvent.findUniqueOrThrow({
			where: { id: result.auditId },
		});
		expect(audit).toMatchObject({
			actorUserId: context.userId,
			organizationMembershipId: result.membershipId,
		});
		expect(audit.recordedAt.getTime()).toBeGreaterThanOrEqual(context.now.getTime());
		expect(
			await prisma.organizationOwnerEnrollmentChallenge.findUniqueOrThrow({
				where: { id: challengeId },
			}),
		).toMatchObject({ status: OrganizationOwnerEnrollmentStatus.CONSUMED, tokenDigest: null });
		await expect(acceptanceTransaction(context, challengeId)).rejects.toThrow();
		expect(
			await prisma.organizationOwnerAcceptanceAuditEvent.count({
				where: { ownerInvitationId: context.invitationId },
			}),
		).toBe(1);
		expect(
			await prisma.organization.findUniqueOrThrow({ where: { id: context.organizationId } }),
		).toMatchObject({ status: 'PENDING' });
	});

	it('allows only one of two simultaneous acceptance transactions to commit', async () => {
		const context = await createContext();
		const challengeId = await verifiedChallenge(context);
		const outcomes = await Promise.allSettled([
			acceptanceTransaction(context, challengeId),
			acceptanceTransaction(context, challengeId),
		]);
		expect(outcomes.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
		expect(
			await prisma.organizationMembership.count({
				where: { organizationId: context.organizationId },
			}),
		).toBe(1);
		expect(
			await prisma.organizationOwnerAcceptanceAuditEvent.count({
				where: { organizationId: context.organizationId },
			}),
		).toBe(1);
	});

	it('rolls back membership, owner assignment and proof consumption when auditing fails', async () => {
		const context = await createContext();
		const challengeId = await verifiedChallenge(context);
		await expect(
			acceptanceTransaction(context, challengeId, 'unsafe request id'),
		).rejects.toThrow();
		expect(
			await prisma.organizationMembership.count({
				where: { organizationId: context.organizationId },
			}),
		).toBe(0);
		expect(
			await prisma.organizationRole.count({ where: { organizationId: context.organizationId } }),
		).toBe(0);
		expect(
			await prisma.organizationOwnerInvitation.findUniqueOrThrow({
				where: { id: context.invitationId },
			}),
		).toMatchObject({ status: 'SENT' });
		expect(
			await prisma.organizationOwnerEnrollmentChallenge.findUniqueOrThrow({
				where: { id: challengeId },
			}),
		).toMatchObject({ status: 'VERIFIED' });
	});

	it('rejects audit substitution of another recipient, membership, invitation or organization', async () => {
		const first = await createContext();
		const second = await createContext();
		const challengeId = await verifiedChallenge(first);
		const result = await acceptanceTransaction(first, challengeId);
		const original = await prisma.organizationOwnerAcceptanceAuditEvent.findUniqueOrThrow({
			where: { id: result.auditId },
		});
		// Development cleanup may remove only this tracked synthetic audit fixture.
		await prisma.organizationOwnerAcceptanceAuditEvent.delete({ where: { id: result.auditId } });
		for (const changes of [
			{ actorUserId: second.userId },
			{ ownerInvitationId: second.invitationId },
			{ organizationId: second.organizationId },
			{ organizationMembershipId: randomUUID() },
		]) {
			await expect(
				prisma.organizationOwnerAcceptanceAuditEvent.create({
					data: { ...original, ...changes, id: enrollments.reserveAuditId(safeDatabase()) },
				}),
			).rejects.toThrow();
		}
		await prisma.organizationOwnerAcceptanceAuditEvent.create({ data: original });
		await expect(prisma.user.delete({ where: { id: first.userId } })).rejects.toMatchObject({
			code: 'P2003',
		});
		await expect(
			prisma.organizationMembership.delete({ where: { id: result.membershipId } }),
		).rejects.toMatchObject({ code: 'P2003' });
	});

	it('revocation before acceptance prevents every ownership write', async () => {
		const context = await createContext();
		const challengeId = await verifiedChallenge(context);
		await prisma.organizationOwnerInvitation.update({
			where: { id: context.invitationId },
			data: {
				status: OrganizationOwnerInvitationStatus.REVOKED,
				tokenDigest: null,
				revokedAt: await databaseNow(),
			},
		});
		await expect(acceptanceTransaction(context, challengeId)).rejects.toThrow();
		expect(
			await prisma.organizationMembership.count({
				where: { organizationId: context.organizationId },
			}),
		).toBe(0);
	});

	it('serializes revocation racing acceptance without leaving partial ownership', async () => {
		const context = await createContext();
		const challengeId = await verifiedChallenge(context);
		const revokedAt = await databaseNow();
		const [acceptance, revocation] = await Promise.allSettled([
			acceptanceTransaction(context, challengeId),
			prisma.organizationOwnerInvitation.updateMany({
				where: {
					id: context.invitationId,
					organizationId: context.organizationId,
					status: OrganizationOwnerInvitationStatus.SENT,
				},
				data: { status: OrganizationOwnerInvitationStatus.REVOKED, tokenDigest: null, revokedAt },
			}),
		]);
		const invitation = await prisma.organizationOwnerInvitation.findUniqueOrThrow({
			where: { id: context.invitationId },
		});
		const audits = await prisma.organizationOwnerAcceptanceAuditEvent.count({
			where: { ownerInvitationId: context.invitationId },
		});
		const memberCount = await prisma.organizationMembership.count({
			where: { organizationId: context.organizationId },
		});
		if (acceptance.status === 'fulfilled') {
			expect(invitation.status).toBe(OrganizationOwnerInvitationStatus.ACCEPTED);
			expect(audits).toBe(1);
			expect(memberCount).toBe(1);
			if (revocation.status === 'fulfilled') expect(revocation.value.count).toBe(0);
		} else {
			expect(revocation.status).toBe('fulfilled');
			expect(invitation.status).toBe(OrganizationOwnerInvitationStatus.REVOKED);
			expect(audits).toBe(0);
			expect(memberCount).toBe(0);
		}
	});

	it('cleans only reserved proof rows and preserves a sentinel', async () => {
		const context = await createContext();
		await prisma.organizationOwnerEnrollmentChallenge.create({ data: challengeData(context) });
		const sentinel = new OwnerEnrollmentTestFixtures();
		sentinelFixtures.push(sentinel);
		const sentinelId = sentinel.reserveChallengeId(safeDatabase());
		await prisma.organizationOwnerEnrollmentChallenge.create({
			data: { ...challengeData(context), id: sentinelId },
		});
		await enrollments.cleanup(prisma, safeDatabase());
		expect(
			await prisma.organizationOwnerEnrollmentChallenge.findUnique({ where: { id: sentinelId } }),
		).not.toBeNull();
	});

	it('denies PUBLIC access to enrollment proof and acceptance audit tables', async () => {
		const grants = await prisma.$queryRaw<{ count: number }[]>`
			SELECT count(*)::integer AS count FROM pg_catalog.pg_class AS relation
			CROSS JOIN LATERAL aclexplode(coalesce(relation.relacl, acldefault('r', relation.relowner))) AS grant_entry
			WHERE relation.oid IN (
				'public.organization_owner_enrollment_challenges'::regclass,
				'public.organization_owner_acceptance_audit_events'::regclass
			) AND grant_entry.grantee = 0
		`;
		expect(grants).toEqual([{ count: 0 }]);
	});
});
