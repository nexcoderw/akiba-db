import { createHash, randomUUID } from 'node:crypto';

import { jest } from '@jest/globals';
import { Test, type TestingModule } from '@nestjs/testing';

import { DatabaseModule } from '../../src/database/database.module.js';
import { PrismaService } from '../../src/database/prisma.service.js';
import { UserStatus } from '../../src/index.js';
import { PlatformAdminTestFixtures } from './platform-admin-test-fixtures.js';
import { OrganizationMembershipTestFixtures } from './organization-membership-test-fixtures.js';
import { OrganizationTestFixtures } from './organization-test-fixtures.js';
import {
	loadDevelopmentDatabaseConfig,
	verifyDevelopmentDatabaseSafety,
	verifyTestTablePrivileges,
	type VerifiedDevelopmentDatabase,
} from './development-database-safety.js';

const safety = loadDevelopmentDatabaseConfig();
const requiredChecks = [
	'owner_sessions_token_digest_check',
	'owner_sessions_assurance_check',
	'owner_sessions_timestamp_order_check',
	'owner_sessions_binding_check',
];

jest.setTimeout(60_000);

describe('owner session persistence', () => {
	let module: TestingModule | undefined;
	let prisma: PrismaService;
	let verified: VerifiedDevelopmentDatabase | undefined;
	let identities: PlatformAdminTestFixtures;
	let organizations: OrganizationTestFixtures;
	let memberships: OrganizationMembershipTestFixtures;
	const sessionIds = new Set<string>();

	beforeAll(async () => {
		module = await Test.createTestingModule({
			imports: [
				DatabaseModule.forRoot({
					databaseUrl: safety.databaseUrl,
					poolMax: 2,
					connectionTimeoutMilliseconds: 10_000,
				}),
			],
		}).compile();
		await module.init();
		prisma = module.get(PrismaService);
		const safe = await verifyDevelopmentDatabaseSafety(prisma, safety);
		const [table, checks, triggers] = await Promise.all([
			prisma.$queryRaw<{ relation: string | null }[]>`
				SELECT to_regclass('public.owner_sessions')::text AS relation
			`,
			prisma.$queryRaw<{ name: string }[]>`
				SELECT conname AS name
				FROM pg_catalog.pg_constraint
				WHERE conrelid = to_regclass('public.owner_sessions')
					AND contype = 'c'
					AND convalidated
			`,
			prisma.$queryRaw<{ name: string }[]>`
				SELECT tgname AS name
				FROM pg_catalog.pg_trigger
				WHERE tgrelid = to_regclass('public.owner_sessions')
					AND NOT tgisinternal
					AND tgenabled IN ('O', 'A')
			`,
		]);
		if (
			table[0]?.relation === null ||
			table[0] === undefined ||
			requiredChecks.some((name) => !checks.some((check) => check.name === name)) ||
			!triggers.some(({ name }) => name === 'owner_session_guard')
		) {
			throw new Error(
				'Owner session prerequisites are missing. Apply the reviewed session ' +
					'migration to the approved development branch before this suite.',
			);
		}
		await verifyTestTablePrivileges(prisma, [
			{
				tableName: 'owner_sessions',
				privileges: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
			},
		]);
		verified = safe;
	});

	beforeEach(() => {
		identities = new PlatformAdminTestFixtures();
		organizations = new OrganizationTestFixtures();
		memberships = new OrganizationMembershipTestFixtures();
		sessionIds.clear();
	});

	afterEach(async () => {
		if (verified === undefined) return;
		for (const id of sessionIds) {
			await prisma.$executeRaw`DELETE FROM public.owner_sessions WHERE id = ${id}::uuid`;
		}
		await memberships.cleanup(prisma, verified);
		await organizations.cleanup(prisma, verified);
		await identities.cleanup(prisma, verified);
	});

	afterAll(async () => {
		await module?.close();
	});

	async function databaseNow(): Promise<Date> {
		const [row] = await prisma.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
		if (row === undefined) throw new Error('Database clock is unavailable.');
		return row.now;
	}

	async function createUser(status: UserStatus = UserStatus.ACTIVE): Promise<string> {
		const id = identities.reserveUserId();
		await prisma.user.create({
			data: {
				id,
				email: `owner-session-${id}@example.com`,
				displayName: 'Fictional Organization Owner',
				status,
				emailVerifiedAt: status === UserStatus.ACTIVE ? await databaseNow() : null,
			},
		});
		return id;
	}

	async function createBinding(userId: string): Promise<{
		readonly organizationId: string;
		readonly membershipId: string;
	}> {
		if (verified === undefined) throw new Error('Development database is not verified.');
		const organization = organizations.reserve(verified);
		await prisma.organization.create({
			data: { ...organization, name: 'Fictional Owner Session Organization' },
		});
		const membershipId = memberships.reserveMembershipId(verified);
		await prisma.organizationMembership.create({
			data: { id: membershipId, organizationId: organization.id, userId },
		});
		return { organizationId: organization.id, membershipId };
	}

	async function insertAal1Session(userId: string): Promise<{
		readonly id: string;
		readonly organizationId: string;
		readonly membershipId: string;
		readonly createdAt: Date;
		readonly idleExpiresAt: Date;
		readonly absoluteExpiresAt: Date;
	}> {
		const id = randomUUID();
		sessionIds.add(id);
		const createdAt = await databaseNow();
		const idleExpiresAt = new Date(createdAt.getTime() + 30 * 60_000);
		const absoluteExpiresAt = new Date(createdAt.getTime() + 8 * 60 * 60_000);
		const digest = createHash('sha256').update(randomUUID()).digest('hex');
		const { organizationId, membershipId } = await createBinding(userId);

		await prisma.$executeRaw`
			INSERT INTO public.owner_sessions (
				id, user_id, organization_id, membership_id, token_digest, assurance, authenticated_at, created_at,
				last_activity_at, idle_expires_at, absolute_expires_at
			) VALUES (
				${id}::uuid, ${userId}::uuid, ${organizationId}::uuid, ${membershipId}::uuid,
				${digest}, 'aal1', ${createdAt}, ${createdAt},
				${createdAt}, ${idleExpiresAt}, ${absoluteExpiresAt}
			)
		`;

		return { id, organizationId, membershipId, createdAt, idleExpiresAt, absoluteExpiresAt };
	}

	it('stores a digest-only AAL1 session bound to an organization membership', async () => {
		const userId = await createUser();
		const session = await insertAal1Session(userId);
		const [row] = await prisma.$queryRaw<
			{
				userId: string;
				organizationId: string;
				membershipId: string;
				assurance: string;
				revokedAt: Date | null;
			}[]
		>`
			SELECT user_id AS "userId", organization_id AS "organizationId",
				membership_id AS "membershipId", assurance::text, revoked_at AS "revokedAt"
			FROM public.owner_sessions
			WHERE id = ${session.id}::uuid
		`;

		expect(row).toEqual({
			userId,
			organizationId: session.organizationId,
			membershipId: session.membershipId,
			assurance: 'aal1',
			revokedAt: null,
		});
	});

	it('rejects malformed digests, false AAL2 claims and inactive users', async () => {
		const activeUserId = await createUser();
		const suspendedUserId = await createUser(UserStatus.SUSPENDED);
		const activeBinding = await createBinding(activeUserId);
		const suspendedBinding = await createBinding(suspendedUserId);
		const createdAt = await databaseNow();
		const idleExpiresAt = new Date(createdAt.getTime() + 30 * 60_000);
		const absoluteExpiresAt = new Date(createdAt.getTime() + 8 * 60 * 60_000);
		const validDigest = createHash('sha256').update(randomUUID()).digest('hex');

		await expect(prisma.$executeRaw`
			INSERT INTO public.owner_sessions (
				id, user_id, organization_id, membership_id, token_digest,
				authenticated_at, created_at, last_activity_at,
				idle_expires_at, absolute_expires_at
			) VALUES (
				${randomUUID()}::uuid, ${activeUserId}::uuid,
				${activeBinding.organizationId}::uuid, ${activeBinding.membershipId}::uuid,
				'raw-token', ${createdAt}, ${createdAt},
				${createdAt}, ${idleExpiresAt}, ${absoluteExpiresAt}
			)
		`).rejects.toThrow();

		await expect(prisma.$executeRaw`
			INSERT INTO public.owner_sessions (
				id, user_id, organization_id, membership_id, token_digest, assurance, authenticated_at, created_at,
				last_activity_at, idle_expires_at, absolute_expires_at
			) VALUES (
				${randomUUID()}::uuid, ${activeUserId}::uuid,
				${activeBinding.organizationId}::uuid, ${activeBinding.membershipId}::uuid,
				${validDigest}, 'aal2', ${createdAt},
				${createdAt}, ${createdAt}, ${idleExpiresAt}, ${absoluteExpiresAt}
			)
		`).rejects.toThrow();

		await expect(prisma.$executeRaw`
			INSERT INTO public.owner_sessions (
				id, user_id, organization_id, membership_id, token_digest,
				authenticated_at, created_at, last_activity_at,
				idle_expires_at, absolute_expires_at
			) VALUES (
				${randomUUID()}::uuid, ${suspendedUserId}::uuid,
				${suspendedBinding.organizationId}::uuid, ${suspendedBinding.membershipId}::uuid,
				${validDigest}, ${createdAt},
				${createdAt}, ${createdAt}, ${idleExpiresAt}, ${absoluteExpiresAt}
			)
		`).rejects.toThrow('owner sessions require an active user and membership');

		await expect(prisma.$executeRaw`
			INSERT INTO public.owner_sessions (
				id, user_id, token_digest, authenticated_at, created_at, last_activity_at,
				idle_expires_at, absolute_expires_at
			) VALUES (
				${randomUUID()}::uuid, ${activeUserId}::uuid, ${validDigest}, ${createdAt},
				${createdAt}, ${createdAt}, ${idleExpiresAt}, ${absoluteExpiresAt}
			)
		`).rejects.toThrow('owner sessions require an active user and membership');
	});

	it('allows bounded activity refresh while protecting session identity', async () => {
		const userId = await createUser();
		const session = await insertAal1Session(userId);
		const nextActivity = new Date(session.createdAt.getTime() + 60_000);
		const nextIdleExpiry = new Date(session.idleExpiresAt.getTime() + 60_000);

		await prisma.$executeRaw`
			UPDATE public.owner_sessions
			SET last_activity_at = ${nextActivity}, idle_expires_at = ${nextIdleExpiry}
			WHERE id = ${session.id}::uuid
		`;

		await expect(prisma.$executeRaw`
			UPDATE public.owner_sessions
			SET token_digest = ${createHash('sha256').update(randomUUID()).digest('hex')}
			WHERE id = ${session.id}::uuid
		`).rejects.toThrow('owner session identity and authentication evidence are immutable');
	});

	it('makes revocation one-way and terminal', async () => {
		const userId = await createUser();
		const session = await insertAal1Session(userId);
		const revokedAt = await databaseNow();

		await prisma.$executeRaw`
			UPDATE public.owner_sessions
			SET revoked_at = ${revokedAt}
			WHERE id = ${session.id}::uuid
		`;

		await expect(prisma.$executeRaw`
			UPDATE public.owner_sessions
			SET revoked_at = NULL
			WHERE id = ${session.id}::uuid
		`).rejects.toThrow('revoked owner sessions are immutable');
	});
});
