import { jest } from '@jest/globals';

import type { PrismaService } from '../../src/database/prisma.service.js';
import {
	assertConnectedTestDatabaseIsSafe,
	loadTestDatabaseSafetyConfig,
	type ConnectedTestDatabaseIdentity,
	verifyTestTablePrivileges,
} from '../integration/test-database-safety.js';

const TEST_MARKER = '11111111-1111-4111-8111-111111111111';
type RawQuery = (query: TemplateStringsArray, ...values: unknown[]) => Promise<unknown>;
const UNSAFE_ENVIRONMENT_CASES: readonly {
	readonly name: string;
	readonly override: NodeJS.ProcessEnv;
	readonly message: string;
}[] = [
	{
		name: 'an invalid protocol',
		override: { TEST_DATABASE_URL: 'mysql://akiba_test@tests.example.test/akiba_test' },
		message: 'must use the postgresql: or postgres: protocol',
	},
	{
		name: 'an administrative database',
		override: { TEST_DATABASE_URL: 'postgresql://akiba_test@tests.example.test/postgres' },
		message: 'must not target a PostgreSQL administrative database',
	},
	{
		name: 'a production-labelled database',
		override: {
			TEST_DATABASE_URL: 'postgresql://akiba_test@tests.example.test/akiba_production',
		},
		message: 'appears to target a production configuration',
	},
	{
		name: 'the runtime target through a pooler alias',
		override: {
			TEST_DATABASE_URL: 'postgresql://akiba_test@runtime-pooler.example.test:5432/akiba',
		},
		message: 'must not target the same database as DATABASE_URL',
	},
	{
		name: 'a shared runtime user',
		override: {
			TEST_DATABASE_URL: 'postgresql://akiba_app@tests.example.test/akiba_test',
		},
		message: 'must use a database user distinct from DATABASE_URL',
	},
];

function safeEnvironment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
	return {
		TEST_DATABASE_URL: 'postgresql://akiba_test@tests.example.test:5432/akiba_test',
		TEST_DATABASE_MARKER: TEST_MARKER,
		DATABASE_URL: 'postgresql://akiba_app@runtime.example.test:5432/akiba',
		DIRECT_DATABASE_URL: 'postgresql://akiba_migrator@runtime.example.test:5432/akiba',
		SHADOW_DATABASE_URL: 'postgresql://akiba_shadow@shadow.example.test:5432/akiba_shadow',
		...overrides,
	};
}

function safeIdentity(
	overrides: Partial<ConnectedTestDatabaseIdentity> = {},
): ConnectedTestDatabaseIdentity {
	return {
		databaseName: 'akiba_test',
		databaseUser: 'akiba_test',
		databaseMarker: `akiba:disposable-integration-test:${TEST_MARKER}`,
		isSuperuser: false,
		canCreateDatabase: false,
		canCreateRole: false,
		canReplicate: false,
		canBypassRowLevelSecurity: false,
		canCreateSchema: false,
		canCreateInPublicSchema: false,
		...overrides,
	};
}

describe('integration-test database safety', () => {
	it('rejects missing test database configuration', () => {
		expect(() => loadTestDatabaseSafetyConfig({})).toThrow(
			'TEST_DATABASE_URL is required for database integration tests.',
		);
		expect(() =>
			loadTestDatabaseSafetyConfig({
				TEST_DATABASE_URL: safeEnvironment().TEST_DATABASE_URL,
			}),
		).toThrow('TEST_DATABASE_MARKER is required for database integration tests.');
	});

	it.each(UNSAFE_ENVIRONMENT_CASES)(
		'rejects unsafe configuration using $name',
		({ override, message }) => {
			expect(() => loadTestDatabaseSafetyConfig(safeEnvironment(override))).toThrow(message);
		},
	);

	it('accepts an isolated target with a dedicated user and valid marker configuration', () => {
		expect(loadTestDatabaseSafetyConfig(safeEnvironment())).toEqual({
			databaseUrl: safeEnvironment().TEST_DATABASE_URL,
			databaseName: 'akiba_test',
			databaseUser: 'akiba_test',
			marker: TEST_MARKER,
		});
	});

	it('prevents writes when the connected database marker is missing', () => {
		const config = loadTestDatabaseSafetyConfig(safeEnvironment());
		const write = jest.fn();

		expect(() => {
			const verifiedDatabase = assertConnectedTestDatabaseIsSafe(
				config,
				safeIdentity({ databaseMarker: null }),
			);
			write(verifiedDatabase);
		}).toThrow('missing its expected disposable-test marker');
		expect(write).not.toHaveBeenCalled();
	});

	it('prevents cleanup when connected database verification fails', () => {
		const config = loadTestDatabaseSafetyConfig(safeEnvironment());
		const cleanup = jest.fn();

		expect(() => {
			const verifiedDatabase = assertConnectedTestDatabaseIsSafe(
				config,
				safeIdentity({ canCreateDatabase: true }),
			);
			cleanup(verifiedDatabase);
		}).toThrow('has unsafe administrative privileges');
		expect(cleanup).not.toHaveBeenCalled();
	});

	it('rejects a connected database or user that differs from the configured target', () => {
		const config = loadTestDatabaseSafetyConfig(safeEnvironment());

		expect(() =>
			assertConnectedTestDatabaseIsSafe(
				config,
				safeIdentity({ databaseName: 'another_test_database' }),
			),
		).toThrow('does not match TEST_DATABASE_URL');
		expect(() =>
			assertConnectedTestDatabaseIsSafe(config, safeIdentity({ databaseUser: 'another_user' })),
		).toThrow('does not match TEST_DATABASE_URL');
	});

	it('verifies every required table privilege in one database round trip', async () => {
		const queryRaw = jest.fn<RawQuery>().mockResolvedValue([
			{
				table_name: 'organization_memberships',
				privileges: 'SELECT,INSERT,UPDATE,DELETE',
				allowed: true,
			},
			{
				table_name: 'organization_roles',
				privileges: 'SELECT,INSERT,UPDATE,DELETE',
				allowed: true,
			},
		]);
		const prisma = { $queryRaw: queryRaw } as unknown as PrismaService;

		await verifyTestTablePrivileges(prisma, [
			{
				tableName: 'organization_memberships',
				privileges: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
			},
			{
				tableName: 'organization_roles',
				privileges: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
			},
		]);

		expect(queryRaw).toHaveBeenCalledTimes(1);
		const serializedRequirements = queryRaw.mock.calls[0]?.[1];
		expect(typeof serializedRequirements).toBe('string');
		expect(JSON.parse(serializedRequirements as string)).toEqual([
			{
				table_name: 'organization_memberships',
				privileges: 'SELECT,INSERT,UPDATE,DELETE',
			},
			{
				table_name: 'organization_roles',
				privileges: 'SELECT,INSERT,UPDATE,DELETE',
			},
		]);
	});

	it('reports the exact denied table from a batched privilege check', async () => {
		const queryRaw = jest.fn<RawQuery>().mockResolvedValue([
			{
				table_name: 'organization_roles',
				privileges: 'SELECT,INSERT,UPDATE,DELETE',
				allowed: false,
			},
		]);
		const prisma = { $queryRaw: queryRaw } as unknown as PrismaService;

		await expect(
			verifyTestTablePrivileges(prisma, [
				{
					tableName: 'organization_roles',
					privileges: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
				},
			]),
		).rejects.toThrow('missing SELECT,INSERT,UPDATE,DELETE on public.organization_roles');
		expect(queryRaw).toHaveBeenCalledTimes(1);
	});
});
