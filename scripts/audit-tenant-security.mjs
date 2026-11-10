import pg from 'pg';

import { loadNeonEnvironment } from './neon-environment.mjs';

/** @param {unknown} value @returns {Record<string, unknown>} */
function record(value) {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		throw new Error('Invalid tenant audit result.');
	}
	return Object.fromEntries(Object.entries(value));
}

/** Read-only development diagnostics. RLS activation is evidence to review, never policy proof. */
async function audit() {
	if (process.argv.length !== 2) throw new Error('This audit accepts no additional arguments.');
	const config = loadNeonEnvironment('development');
	const client = new pg.Client({ connectionString: config.directDatabaseUrl,
		connectionTimeoutMillis: 10000, query_timeout: 10000 });
	try {
		await client.connect();
		await client.query('BEGIN READ ONLY');
		await client.query("SET LOCAL statement_timeout = '10s'");
		const identity = await client.query(`SELECT current_database() AS database,
			current_user AS current_user, session_user AS session_user,
			r.rolsuper, r.rolbypassrls,
			EXISTS (SELECT 1 FROM pg_roles n WHERE n.rolname = 'neon_superuser'
			 AND pg_has_role(current_user, n.oid, 'MEMBER')) AS neon_superuser_member
			FROM pg_roles r WHERE r.rolname = current_user`);
		const connected = record(identity.rows[0]);
		if (connected.database !== config.databaseName ||
			connected.current_user !== config.databaseUser || connected.session_user !== config.databaseUser) {
			throw new Error('The connected identity does not match the approved development target.');
		}
		const roles = await client.query(`SELECT r.rolname, r.rolsuper, r.rolbypassrls,
			r.rolcreatedb, r.rolcreaterole FROM pg_roles r
			WHERE pg_has_role(current_user, r.oid, 'MEMBER') ORDER BY r.rolname`);
		const tables = await client.query(`SELECT c.relname AS table_name,
			pg_get_userbyid(c.relowner) AS owner, c.relrowsecurity AS rls_enabled,
			c.relforcerowsecurity AS force_rls, row_security_active(c.oid) AS rls_active_for_current_user,
			has_table_privilege(current_user, c.oid, 'SELECT') AS can_select,
			has_table_privilege(current_user, c.oid, 'INSERT') AS can_insert,
			has_table_privilege(current_user, c.oid, 'UPDATE') AS can_update,
			has_table_privilege(current_user, c.oid, 'DELETE') AS can_delete,
			has_table_privilege(current_user, c.oid, 'TRUNCATE') AS can_truncate
			FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
			WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') ORDER BY c.relname`);
		const policies = await client.query(`SELECT schemaname, tablename, policyname,
			permissive, roles, cmd, qual, with_check FROM pg_policies
			WHERE schemaname = 'public' ORDER BY tablename, policyname`);
		const tableRows = tables.rows.map(record);
		const scoped = tableRows.filter((table) => typeof table.table_name === 'string' &&
			(table.table_name === 'organizations' || table.table_name.startsWith('organization_')));
		const blocked = connected.rolsuper !== false || connected.rolbypassrls !== false || connected.neon_superuser_member !== false ||
			scoped.length === 0 || scoped.some((table) => table.rls_active_for_current_user !== true);
		console.log(JSON.stringify({ environment: 'development', identity: connected,
			roles: roles.rows.map(record), tables: tableRows, policies: policies.rows.map(record),
			databaseEnforcedIsolation: blocked ? 'BLOCKED' : 'REQUIRES_POLICY_REVIEW' }, null, 2));
		if (blocked) process.exitCode = 2;
	} finally {
		await client.query('ROLLBACK').catch(() => undefined);
		await client.end();
	}
}

void audit().catch(() => {
	console.error('Tenant security audit failed. Check approved development access and configuration.');
	process.exitCode = 1;
});
