import { coordinatorName, integrationLock } from '../../scripts/development-session.mjs';
import {
	readApprovedTargets,
	validateNeonEnvironment,
	type ApprovedTargets,
} from '../../scripts/neon-environment.mjs';
import type { PrismaService } from '../../src/database/prisma.service.js';

const verifiedDevelopmentDatabase = Symbol('verifiedDevelopmentDatabase');

export interface DevelopmentDatabaseSafetyConfig {
	readonly databaseUrl: string;
	readonly databaseName: string;
	readonly databaseUser: string;
	readonly coordinatorPid: number;
}

export interface ConnectedDevelopmentDatabaseIdentity {
	readonly databaseName: string;
	readonly databaseUser: string;
	readonly coordinatorAlive: boolean;
}

export interface VerifiedDevelopmentDatabase {
	readonly [verifiedDevelopmentDatabase]: true;
}

export type TestTablePrivilege = 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE';
export interface TestTablePrivilegeRequirement {
	readonly tableName: string;
	readonly privileges: readonly TestTablePrivilege[];
}

/** Fixture capability issued only after branch, live identity and coordinator verification. */
export function assertDevelopmentDatabaseWasVerified(
	token: unknown,
): asserts token is VerifiedDevelopmentDatabase {
	if (
		typeof token !== 'object' ||
		token === null ||
		!(verifiedDevelopmentDatabase in token) ||
		token[verifiedDevelopmentDatabase] !== true
	) {
		throw new Error('Development database verification has not completed.');
	}
}

export function loadDevelopmentDatabaseConfig(
	environment: NodeJS.ProcessEnv = process.env,
	targets: ApprovedTargets = readApprovedTargets(),
): DevelopmentDatabaseSafetyConfig {
	const config = validateNeonEnvironment('development', environment, targets);
	const coordinatorPid = Number(environment.AKIBA_INTEGRATION_COORDINATOR_PID);
	if (!Number.isSafeInteger(coordinatorPid) || coordinatorPid <= 0)
		throw new Error('Run integration suites through npm run test:integration.');
	return Object.freeze({
		databaseUrl: config.databaseUrl,
		databaseName: config.databaseName,
		databaseUser: config.databaseUser,
		coordinatorPid,
	});
}

export function assertConnectedDevelopmentDatabaseIsSafe(
	config: DevelopmentDatabaseSafetyConfig,
	identity: ConnectedDevelopmentDatabaseIdentity,
): VerifiedDevelopmentDatabase {
	if (
		identity.databaseName !== config.databaseName ||
		identity.databaseUser !== config.databaseUser ||
		!identity.coordinatorAlive
	) {
		throw new Error(
			'The connected development identity or exclusive integration coordinator could not be verified.',
		);
	}
	const token: VerifiedDevelopmentDatabase = { [verifiedDevelopmentDatabase]: true };
	return Object.freeze(token);
}

/** This verifies fixture coordination, not role privilege separation or RLS authorization. */
export async function verifyDevelopmentDatabaseSafety(
	prisma: PrismaService,
	config: DevelopmentDatabaseSafetyConfig,
): Promise<VerifiedDevelopmentDatabase> {
	const identities = await prisma.$queryRaw<
		{ database_name: string; database_user: string; coordinator_alive: boolean }[]
	>`
		SELECT current_database() AS database_name, current_user AS database_user,
			EXISTS (
				SELECT 1 FROM pg_catalog.pg_locks AS locks
				JOIN pg_catalog.pg_stat_activity AS activity ON activity.pid = locks.pid
				WHERE locks.locktype = 'advisory' AND locks.granted AND locks.mode = 'ExclusiveLock'
					AND locks.classid = ${integrationLock[0]}::oid AND locks.objid = ${integrationLock[1]}::oid AND locks.objsubid = 2
					AND locks.pid = ${config.coordinatorPid} AND activity.datname = current_database()
					AND activity.usename = current_user AND activity.application_name = ${coordinatorName}
			) AS coordinator_alive
	`;
	const row = identities[0];
	if (identities.length !== 1 || row === undefined)
		throw new Error('Unable to verify development database identity.');
	return assertConnectedDevelopmentDatabaseIsSafe(config, {
		databaseName: row.database_name,
		databaseUser: row.database_user,
		coordinatorAlive: row.coordinator_alive,
	});
}

/** Verify table availability for the existing suites without provisioning users or grants. */
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
		SELECT requirement.table_name, requirement.privileges,
			has_table_privilege(current_user, format('%I.%I', 'public', requirement.table_name), requirement.privileges) AS allowed
		FROM jsonb_to_recordset(${serializedRequirements}::jsonb) AS requirement(table_name text, privileges text)
	`;
	const denied = rows.find(({ allowed }) => !allowed);
	if (rows.length !== requirements.length || denied !== undefined) {
		const missing = denied ?? {
			table_name: requirements[0]?.tableName ?? 'unknown',
			privileges: requirements[0]?.privileges.join(',') ?? 'unknown',
		};
		throw new Error(
			`The development connection is missing ${missing.privileges} on public.${missing.table_name}. Review the selected database and applied migrations.`,
		);
	}
}
