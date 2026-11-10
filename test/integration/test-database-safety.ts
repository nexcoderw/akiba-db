import type { PrismaService } from '../../src/database/prisma.service.js';

const POSTGRES_PROTOCOLS = new Set(['postgres:', 'postgresql:']);
const REFERENCE_DATABASE_URLS = [
	'DATABASE_URL',
	'DIRECT_DATABASE_URL',
	'SHADOW_DATABASE_URL',
] as const;
const TEST_DATABASE_COMMENT_PREFIX = 'akiba:disposable-integration-test:';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const UNSAFE_NAME_PATTERN = /(?:^|[._-])(?:prod|production|live)(?:[._-]|$)/iu;

const verifiedTestDatabase = Symbol('verifiedTestDatabase');

export interface TestDatabaseSafetyConfig {
	readonly databaseUrl: string;
	readonly databaseName: string;
	readonly databaseUser: string;
	readonly marker: string;
}

export interface ConnectedTestDatabaseIdentity {
	readonly databaseName: string;
	readonly databaseUser: string;
	readonly databaseMarker: string | null;
	readonly isSuperuser: boolean;
	readonly canCreateDatabase: boolean;
	readonly canCreateRole: boolean;
	readonly canReplicate: boolean;
	readonly canBypassRowLevelSecurity: boolean;
	readonly canCreateSchema: boolean;
	readonly canCreateInPublicSchema: boolean;
}

export interface VerifiedTestDatabase {
	readonly [verifiedTestDatabase]: true;
}

export type TestTablePrivilege = 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE';

export interface TestTablePrivilegeRequirement {
	readonly tableName: string;
	readonly privileges: readonly TestTablePrivilege[];
}

export function assertTestDatabaseWasVerified(
	token: unknown,
): asserts token is VerifiedTestDatabase {
	if (
		typeof token !== 'object' ||
		token === null ||
		!(verifiedTestDatabase in token) ||
		token[verifiedTestDatabase] !== true
	) {
		throw new Error('The integration-test database safety check has not completed.');
	}
}

function requireEnvironmentValue(environment: NodeJS.ProcessEnv, name: string): string {
	const value = environment[name]?.trim();
	if (value === undefined || value === '') {
		throw new Error(`${name} is required for database integration tests.`);
	}

	return value;
}

function parsePostgresUrl(value: string, name: string): URL {
	let parsedUrl: URL;
	try {
		parsedUrl = new URL(value);
	} catch {
		throw new Error(`${name} must be a valid PostgreSQL connection URL.`);
	}

	if (!POSTGRES_PROTOCOLS.has(parsedUrl.protocol)) {
		throw new Error(`${name} must use the postgresql: or postgres: protocol.`);
	}

	return parsedUrl;
}

function decodeUrlComponent(value: string, name: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		throw new Error(`${name} contains invalid URL encoding.`);
	}
}

function readDatabaseName(url: URL, name: string): string {
	const databaseName = decodeUrlComponent(url.pathname.replace(/^\//u, ''), name);
	if (databaseName === '' || databaseName.includes('/')) {
		throw new Error(`${name} must identify exactly one PostgreSQL database.`);
	}

	return databaseName;
}

function readDatabaseUser(url: URL, name: string): string {
	const databaseUser = decodeUrlComponent(url.username, name);
	if (databaseUser === '') {
		throw new Error(`${name} must include a dedicated test database user.`);
	}

	return databaseUser;
}

function normalizeHost(hostname: string): string {
	const normalized = hostname.toLowerCase().replace(/-pooler(?=\.)/u, '');
	return normalized === '127.0.0.1' || normalized === '::1' ? 'localhost' : normalized;
}

function databaseTarget(url: URL, name: string): string {
	return [normalizeHost(url.hostname), url.port || '5432', readDatabaseName(url, name)].join('|');
}

function rejectUnsafeNames(databaseName: string, databaseUser: string, hostname: string): void {
	if (['postgres', 'template0', 'template1'].includes(databaseName.toLowerCase())) {
		throw new Error('TEST_DATABASE_URL must not target a PostgreSQL administrative database.');
	}

	if ([databaseName, databaseUser, hostname].some((value) => UNSAFE_NAME_PATTERN.test(value))) {
		throw new Error('TEST_DATABASE_URL appears to target a production configuration.');
	}
}

export function loadTestDatabaseSafetyConfig(
	environment: NodeJS.ProcessEnv = process.env,
): TestDatabaseSafetyConfig {
	const databaseUrl = requireEnvironmentValue(environment, 'TEST_DATABASE_URL');
	const marker = requireEnvironmentValue(environment, 'TEST_DATABASE_MARKER');
	if (!UUID_PATTERN.test(marker)) {
		throw new Error('TEST_DATABASE_MARKER must be a UUID provisioned for this test database.');
	}

	const parsedTestUrl = parsePostgresUrl(databaseUrl, 'TEST_DATABASE_URL');
	const databaseName = readDatabaseName(parsedTestUrl, 'TEST_DATABASE_URL');
	const databaseUser = readDatabaseUser(parsedTestUrl, 'TEST_DATABASE_URL');
	rejectUnsafeNames(databaseName, databaseUser, parsedTestUrl.hostname);

	const testTarget = databaseTarget(parsedTestUrl, 'TEST_DATABASE_URL');
	for (const name of REFERENCE_DATABASE_URLS) {
		const value = environment[name]?.trim();
		if (value === undefined || value === '') {
			continue;
		}

		const referenceUrl = parsePostgresUrl(value, name);
		if (databaseTarget(referenceUrl, name) === testTarget) {
			throw new Error(`TEST_DATABASE_URL must not target the same database as ${name}.`);
		}

		if (readDatabaseUser(referenceUrl, name) === databaseUser) {
			throw new Error(`TEST_DATABASE_URL must use a database user distinct from ${name}.`);
		}
	}

	return Object.freeze({ databaseUrl, databaseName, databaseUser, marker });
}

export function assertConnectedTestDatabaseIsSafe(
	config: TestDatabaseSafetyConfig,
	identity: ConnectedTestDatabaseIdentity,
): VerifiedTestDatabase {
	if (
		identity.databaseName !== config.databaseName ||
		identity.databaseUser !== config.databaseUser
	) {
		throw new Error('The connected PostgreSQL target does not match TEST_DATABASE_URL.');
	}

	if (identity.databaseMarker !== `${TEST_DATABASE_COMMENT_PREFIX}${config.marker}`) {
		throw new Error('The connected database is missing its expected disposable-test marker.');
	}

	if (
		identity.isSuperuser ||
		identity.canCreateDatabase ||
		identity.canCreateRole ||
		identity.canReplicate ||
		identity.canBypassRowLevelSecurity ||
		identity.canCreateSchema ||
		identity.canCreateInPublicSchema
	) {
		throw new Error('The integration-test database user has unsafe administrative privileges.');
	}

	const verifiedDatabase: VerifiedTestDatabase = { [verifiedTestDatabase]: true };
	return Object.freeze(verifiedDatabase);
}

export async function verifyTestDatabaseSafety(
	prisma: PrismaService,
	config: TestDatabaseSafetyConfig,
): Promise<VerifiedTestDatabase> {
	const identities = await prisma.$queryRaw<
		{
			database_name: string;
			database_user: string;
			database_marker: string | null;
			is_superuser: boolean;
			can_create_database: boolean;
			can_create_role: boolean;
			can_replicate: boolean;
			can_bypass_row_level_security: boolean;
			can_create_schema: boolean;
			can_create_in_public_schema: boolean;
		}[]
	>`
		SELECT
			current_database() AS database_name,
			current_user AS database_user,
			pg_catalog.shobj_description(databases.oid, 'pg_database') AS database_marker,
			roles.rolsuper AS is_superuser,
			roles.rolcreatedb AS can_create_database,
			roles.rolcreaterole AS can_create_role,
			roles.rolreplication AS can_replicate,
			roles.rolbypassrls AS can_bypass_row_level_security,
			has_database_privilege(current_user, current_database(), 'CREATE') AS can_create_schema,
			has_schema_privilege(current_user, 'public', 'CREATE') AS can_create_in_public_schema
		FROM pg_catalog.pg_database AS databases
		JOIN pg_catalog.pg_roles AS roles ON roles.rolname = current_user
		WHERE databases.datname = current_database()
	`;
	const identity = identities[0];
	if (identity === undefined || identities.length !== 1) {
		throw new Error('Unable to verify the connected PostgreSQL database identity.');
	}

	return assertConnectedTestDatabaseIsSafe(config, {
		databaseName: identity.database_name,
		databaseUser: identity.database_user,
		databaseMarker: identity.database_marker,
		isSuperuser: identity.is_superuser,
		canCreateDatabase: identity.can_create_database,
		canCreateRole: identity.can_create_role,
		canReplicate: identity.can_replicate,
		canBypassRowLevelSecurity: identity.can_bypass_row_level_security,
		canCreateSchema: identity.can_create_schema,
		canCreateInPublicSchema: identity.can_create_in_public_schema,
	});
}

/**
 * Fails before fixture writes when the restricted test role has not received a new table's
 * explicitly reviewed DML grants. Table names and privilege sets come only from authored tests;
 * PostgreSQL evaluates them as values rather than interpolated SQL identifiers.
 */
export async function verifyTestTablePrivileges(
	prisma: PrismaService,
	requirements: readonly TestTablePrivilegeRequirement[],
): Promise<void> {
	if (requirements.length === 0) return;

	const serializedRequirements = JSON.stringify(
		requirements.map(({ tableName, privileges }) => ({
			table_name: tableName,
			privileges: privileges.join(','),
		})),
	);
	const rows = await prisma.$queryRaw<
		{ table_name: string; privileges: string; allowed: boolean }[]
	>`
		SELECT
			requirement.table_name,
			requirement.privileges,
			has_table_privilege(
				current_user,
				format('%I.%I', 'public', requirement.table_name),
				requirement.privileges
			) AS allowed
		FROM jsonb_to_recordset(${serializedRequirements}::jsonb) AS requirement(
			table_name text,
			privileges text
		)
	`;
	const denied = rows.find(({ allowed }) => !allowed);
	if (rows.length !== requirements.length || denied !== undefined) {
		const missing = denied ?? {
			table_name: requirements[0]?.tableName ?? 'unknown',
			privileges: requirements[0]?.privileges.join(',') ?? 'unknown',
		};
		throw new Error(
			`The restricted integration-test role is missing ${missing.privileges} on ` +
				`public.${missing.table_name}. Apply the reviewed akiba_test-only grants before running tests.`,
		);
	}
}
