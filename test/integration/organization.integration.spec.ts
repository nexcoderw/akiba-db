import { jest } from '@jest/globals';
import { Test, type TestingModule } from '@nestjs/testing';

import { DatabaseModule } from '../../src/database/database.module.js';
import { PrismaService } from '../../src/database/prisma.service.js';
import { OrganizationStatus } from '../../src/index.js';
import {
	OrganizationTestFixtures,
	type OrganizationFixture,
} from './organization-test-fixtures.js';
import {
	loadDevelopmentDatabaseConfig,
	verifyDevelopmentDatabaseSafety,
	type VerifiedDevelopmentDatabase,
} from './development-database-safety.js';

const safety = loadDevelopmentDatabaseConfig();
const transactionOptions = { maxWait: 10_000, timeout: 15_000 };
const RESERVED_SLUGS = [
	'admin',
	'api',
	'app',
	'www',
	'auth',
	'login',
	'member',
	'members',
	'portal',
	'dashboard',
	'billing',
	'support',
	'status',
	'static',
	'assets',
	'cdn',
	'mail',
	'dev',
	'staging',
	'test',
	'localhost',
	'account',
	'accounts',
	'oauth',
	'console',
	'internal',
	'health',
	'metrics',
	'production',
	'development',
	'bootstrap',
];

jest.setTimeout(30_000);

describe('organization database foundation', () => {
	let module: TestingModule | undefined;
	let prisma: PrismaService;
	let verified: VerifiedDevelopmentDatabase | undefined;
	let fixtures: OrganizationTestFixtures;
	const extraFixtures: OrganizationTestFixtures[] = [];

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
		const verifiedDatabase = await verifyDevelopmentDatabaseSafety(prisma, safety);
		const readiness = await prisma.$queryRaw<{ table_exists: boolean; validated_checks: number }[]>`
			SELECT to_regclass('public.organizations') IS NOT NULL AS table_exists,
				(SELECT count(*)::integer FROM pg_catalog.pg_constraint
				 WHERE conrelid = to_regclass('public.organizations') AND contype = 'c'
				 AND convalidated AND conname IN (
					'organizations_name_nonblank_check',
					'organizations_slug_format_check',
					'organizations_slug_reserved_check'
				 )) AS validated_checks
		`;
		const schema = readiness[0];
		if (
			readiness.length !== 1 ||
			schema === undefined ||
			!schema.table_exists ||
			schema.validated_checks !== 3
		) {
			throw new Error(
				'Organization integration prerequisites are missing: apply the reviewed organization ' +
					'migration with all three validated CHECK constraints to the verified test database.',
			);
		}
		// Enable fixture teardown only after both target safety and schema readiness succeed.
		verified = verifiedDatabase;
	});

	beforeEach(() => {
		fixtures = new OrganizationTestFixtures();
		extraFixtures.length = 0;
	});

	afterEach(async () => {
		if (verified === undefined) return;
		// Settle every teardown attempt so a failed cleanup cannot prevent other scoped cleanups.
		const results = await Promise.allSettled(
			[fixtures, ...extraFixtures].map((set) => set.cleanup(prisma, requireVerified())),
		);
		const failure = results.find((result) => result.status === 'rejected');
		if (failure !== undefined) {
			const reason: unknown = failure.reason;
			if (reason instanceof Error) throw reason;
			throw new Error('Scoped organization fixture cleanup failed.', { cause: reason });
		}
	}, 60_000);

	afterAll(async () => {
		await module?.close();
	});

	function requireVerified(): VerifiedDevelopmentDatabase {
		if (verified === undefined)
			throw new Error('Organization development database is not verified.');
		return verified;
	}

	function reserve(slug?: string): OrganizationFixture {
		return fixtures.reserve(requireVerified(), slug);
	}

	function insertRaw(fixture: OrganizationFixture, name: string | null, status = 'pending') {
		return prisma.$executeRaw`
			INSERT INTO public.organizations (id, name, slug, status, updated_at)
			VALUES (${fixture.id}::uuid, ${name}, ${fixture.slug}, ${status}::public.organization_status, now())
		`;
	}

	it('creates a pending organization with UUID, UTC timestamps and no lifecycle activation', async () => {
		const fixture = reserve();
		const start = Date.now();
		const row = await prisma.organization.create({
			data: { ...fixture, name: 'Kimihurura Supplies' },
		});
		expect(row.id).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
		);
		expect(row.slug).toBe(fixture.slug);
		expect(row.status).toBe(OrganizationStatus.PENDING);
		expect(row.createdAt.getTime()).toBeGreaterThanOrEqual(start - 60_000);
		expect(row.createdAt.getTime()).toBeLessThanOrEqual(Date.now() + 60_000);
		expect(row.updatedAt).toBeInstanceOf(Date);
		expect(row.activatedAt).toBeNull();
		expect(row.suspendedAt).toBeNull();
		expect(row.archivedAt).toBeNull();
		expect(await prisma.user.findUnique({ where: { id: row.id } })).toBeNull();
		expect(await prisma.platformStaff.findUnique({ where: { id: row.id } })).toBeNull();
		// Check the Prisma default separately from fixtures that reserve an explicit UUID for cleanup.
		const generated = await prisma.$transaction(async (transaction) => {
			const result = await transaction.organization.create({
				data: { name: 'Kimihurura Supplies', slug: reserve().slug },
			});
			fixtures.track(requireVerified(), result);
			await transaction.organization.delete({ where: { id: result.id } });
			return result;
		}, transactionOptions);
		expect(generated.id).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
		);
		expect(generated.id).not.toBe(row.id);
	});

	it('enforces constraints for raw SQL writers while accepting nonunique display names', async () => {
		const first = reserve();
		await expect(insertRaw(first, 'Remera Trading')).resolves.toBe(1);
		await expect(
			prisma.organization.create({ data: { ...reserve(), name: 'Remera Trading' } }),
		).resolves.toMatchObject({ name: 'Remera Trading' });
	});

	it.each(['', ' ', '\t\n\r', '\u00a0', '\u2003', '\u3000'])(
		'rejects blank names in PostgreSQL: %#',
		async (name) => {
			await expect(insertRaw(reserve(), name)).rejects.toThrow('organizations_name_nonblank_check');
		},
	);

	it('rejects a missing name and an overlong name in PostgreSQL', async () => {
		await expect(insertRaw(reserve(), null)).rejects.toMatchObject({ code: 'P2010' });
		await expect(insertRaw(reserve(), 'x'.repeat(161))).rejects.toMatchObject({ code: 'P2010' });
	});

	it.each([
		'Abc',
		'a bc',
		'-abc',
		'abc-',
		'a--bc',
		'a_bc',
		'a.bc',
		'123',
		'ab',
		'école',
		'a\nb',
		'abc\n',
	])('rejects invalid slug grammar in PostgreSQL: %s', async (slug) => {
		await expect(insertRaw(reserve(slug), 'Kigali Supplies')).rejects.toThrow(
			'organizations_slug_format_check',
		);
	});

	it('rejects slugs beyond the PostgreSQL varchar limit', async () => {
		await expect(insertRaw(reserve('a'.repeat(64)), 'Kigali Supplies')).rejects.toMatchObject({
			code: 'P2010',
		});
	});

	it.each(RESERVED_SLUGS)('rejects reserved infrastructure slug: %s', async (slug) => {
		await expect(insertRaw(reserve(slug), 'Kigali Supplies')).rejects.toThrow(
			'organizations_slug_reserved_check',
		);
	});

	it('accepts the shortest and longest permitted ASCII slugs', async () => {
		let shortest: string | undefined;
		for (let attempt = 0; attempt < 16; attempt += 1) {
			const candidate = `g${reserve().id.slice(0, 2)}`;
			if ((await prisma.organization.findUnique({ where: { slug: candidate } })) === null) {
				shortest = candidate;
				break;
			}
		}
		if (shortest === undefined) throw new Error('No unused short slug available for the fixture.');
		// Isolated rollbacks avoid claiming fixed valid names that could collide with unrelated fixtures.
		const longest = `${reserve().slug}${'a'.repeat(63)}`.slice(0, 63);
		for (const slug of [shortest, longest]) {
			const marker = new Error('rollback valid slug fixture');
			await expect(
				prisma.$transaction(async (transaction) => {
					const row = await transaction.organization.create({
						data: { ...reserve(slug), name: 'é'.repeat(160) },
					});
					expect(row.slug).toBe(slug);
					throw marker;
				}, transactionOptions),
			).rejects.toBe(marker);
		}
	});

	it('rejects duplicate slugs including after archival', async () => {
		const fixture = reserve();
		await prisma.organization.create({
			data: { ...fixture, name: 'Kimihurura Supplies', status: OrganizationStatus.ARCHIVED },
		});
		await expect(
			prisma.organization.create({ data: { ...reserve(fixture.slug), name: 'Remera Trading' } }),
		).rejects.toMatchObject({ code: 'P2002' });
	});

	it('allows exactly one concurrent insert for the same slug', async () => {
		const first = reserve();
		const second = reserve(first.slug);
		const results = await Promise.allSettled(
			[first, second].map((fixture) =>
				prisma.organization.create({ data: { ...fixture, name: 'Remera Trading' } }),
			),
		);
		expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
		const rejected = results.find((result) => result.status === 'rejected');
		expect(rejected).toMatchObject({ status: 'rejected', reason: { code: 'P2002' } });
		expect(await prisma.organization.count({ where: { slug: first.slug } })).toBe(1);
	});

	it('persists lifecycle metadata without inventing authorization or transition rules', async () => {
		const fixture = reserve();
		const initial = await prisma.organization.create({
			data: { ...fixture, name: 'Kimihurura Supplies' },
		});
		const time = new Date('2030-01-01T00:00:00.000Z');
		for (const status of Object.values(OrganizationStatus)) {
			const row = await prisma.organization.update({
				where: { id: fixture.id },
				data: { status, activatedAt: time, suspendedAt: time, archivedAt: time },
			});
			expect(row.id).toBe(initial.id);
			expect(row.createdAt).toEqual(initial.createdAt);
			expect(row.updatedAt.getTime()).toBeGreaterThanOrEqual(initial.updatedAt.getTime());
			expect(row.status).toBe(status);
			expect(row.activatedAt).toEqual(time);
			expect(row.suspendedAt).toEqual(time);
			expect(row.archivedAt).toEqual(time);
		}
	});

	it('rejects a status outside the PostgreSQL enum', async () => {
		await expect(insertRaw(reserve(), 'Kimihurura Supplies', 'unknown')).rejects.toMatchObject({
			code: 'P2010',
		});
	});

	it('rolls back organization writes on a later failure', async () => {
		const fixture = reserve();
		const marker = new Error('rollback organization fixture');
		await expect(
			prisma.$transaction(async (transaction) => {
				await transaction.organization.create({
					data: { ...fixture, name: 'Kimihurura Supplies' },
				});
				throw marker;
			}, transactionOptions),
		).rejects.toBe(marker);
		expect(await prisma.organization.findUnique({ where: { id: fixture.id } })).toBeNull();
	});

	it('preserves a separately tracked sentinel during cleanup and permits repeated cleanup', async () => {
		const sentinelSet = new OrganizationTestFixtures();
		extraFixtures.push(sentinelSet);
		const sentinel = sentinelSet.reserve(requireVerified());
		await prisma.organization.create({ data: { ...sentinel, name: 'Kigali Supplies' } });
		const own = reserve();
		await prisma.organization.create({ data: { ...own, name: 'Kimihurura Supplies' } });
		await fixtures.cleanup(prisma, requireVerified());
		await fixtures.cleanup(prisma, requireVerified());
		expect(await prisma.organization.findUnique({ where: { id: own.id } })).toBeNull();
		expect(await prisma.organization.findUnique({ where: { id: sentinel.id } })).toMatchObject(
			sentinel,
		);
	});

	it('has named validated checks and the mapped unique and administration indexes', async () => {
		const checks = await prisma.$queryRaw<{ name: string; validated: boolean }[]>`
			SELECT conname AS name, convalidated AS validated FROM pg_catalog.pg_constraint
			WHERE conrelid = 'public.organizations'::regclass AND contype = 'c'
		`;
		for (const name of [
			'organizations_name_nonblank_check',
			'organizations_slug_format_check',
			'organizations_slug_reserved_check',
		]) {
			expect(checks).toContainEqual({ name, validated: true });
		}
		const indexes = await prisma.$queryRaw<{ name: string; definition: string }[]>`
			SELECT indexname AS name, indexdef AS definition FROM pg_catalog.pg_indexes
			WHERE schemaname = 'public' AND tablename = 'organizations'
		`;
		expect(indexes.some((index) => index.name === 'organizations_pkey')).toBe(true);
		const slugIndex = indexes.find((index) => index.name === 'organizations_slug_key');
		expect(slugIndex).toBeDefined();
		expect(slugIndex?.definition).toContain('UNIQUE INDEX');
		const administrationIndex = indexes.find(
			(index) => index.name === 'organizations_status_created_at_id_idx',
		);
		expect(administrationIndex).toBeDefined();
		expect(administrationIndex?.definition).toContain('(status, created_at DESC, id)');
		const identities = await prisma.$queryRaw<{ users: string | null; staff: string | null }[]>`
			SELECT to_regclass('public.users')::text AS users,
				to_regclass('public.platform_staff')::text AS staff
		`;
		expect(identities).toEqual([{ users: 'users', staff: 'platform_staff' }]);
	});

	it('does not expose the organization registry through PUBLIC table or column grants', async () => {
		const privileges = await prisma.$queryRaw<{ exposed: boolean }[]>`
			SELECT EXISTS (
				SELECT 1
				FROM pg_catalog.pg_class AS relation
				CROSS JOIN LATERAL aclexplode(
					COALESCE(relation.relacl, acldefault('r', relation.relowner))
				) AS grant_entry
				WHERE relation.oid = 'public.organizations'::regclass
					AND grant_entry.grantee = 0
				UNION ALL
				SELECT 1
				FROM pg_catalog.pg_attribute AS attribute
				CROSS JOIN LATERAL aclexplode(attribute.attacl) AS grant_entry
				WHERE attribute.attrelid = 'public.organizations'::regclass
					AND attribute.attnum > 0
					AND NOT attribute.attisdropped
					AND grant_entry.grantee = 0
			) AS exposed
		`;
		expect(privileges).toEqual([{ exposed: false }]);
	});
});
