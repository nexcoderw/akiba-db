import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';

export const integrationLock = Object.freeze([1095451202, 2]);
export const coordinatorName = 'akiba-development-integration-coordinator';

/** @param {unknown} value @returns {Record<string, unknown>} */
function record(value) {
	if (typeof value !== 'object' || value === null)
		throw new Error('Invalid development preflight result.');
	return Object.fromEntries(Object.entries(value));
}

/**
 * Check an already connected development coordinator before starting fixture writers.
 * This performs reads and a session advisory lock only; it never provisions database objects.
 * @param {import('pg').Client} client
 * @param {{databaseName: string, databaseUser: string}} config
 * @param {string} root
 */
export async function verifyDevelopmentSession(client, config, root) {
	const identity = await client.query(
		'SELECT current_database() AS name, current_user AS username, pg_backend_pid() AS pid',
	);
	/** @type {unknown} */
	const row = identity.rows[0];
	if (
		typeof row !== 'object' ||
		row === null ||
		!('name' in row) ||
		!('username' in row) ||
		!('pid' in row) ||
		row.name !== config.databaseName ||
		row.username !== config.databaseUser ||
		typeof row.pid !== 'number'
	) {
		throw new Error('Connected development identity differs from the approved target.');
	}
	const lock = await client.query('SELECT pg_try_advisory_lock($1, $2) AS acquired', [
		...integrationLock,
	]);
	if (record(lock.rows[0]).acquired !== true)
		throw new Error('Another development integration run holds the database lease.');
	const active = await client.query(
		"SELECT count(*)::integer AS count FROM pg_stat_activity WHERE datname = current_database() AND backend_type = 'client backend' AND pid <> pg_backend_pid()",
	);
	if (record(active.rows[0]).count !== 0)
		throw new Error(
			'Development integration requires an exclusive maintenance window. Stop application workers and other database clients.',
		);
	const history = await client.query(
		'SELECT migration_name, checksum, finished_at, rolled_back_at FROM public._prisma_migrations',
	);
	const directory = `${root}/prisma/migrations`;
	const migrations = readdirSync(directory, { withFileTypes: true }).filter((entry) =>
		entry.isDirectory(),
	);
	const applied = history.rows.map(record).filter((entry) => entry.rolled_back_at === null);
	if (applied.length !== migrations.length)
		throw new Error(
			'Development migration history is not synchronized. Review migration status before integration tests.',
		);
	for (const migration of migrations) {
		const checksum = createHash('sha256')
			.update(readFileSync(`${directory}/${migration.name}/migration.sql`))
			.digest('hex');
		if (
			!applied.some(
				(entry) =>
					entry.migration_name === migration.name &&
					entry.checksum === checksum &&
					entry.finished_at instanceof Date &&
					!Number.isNaN(entry.finished_at.getTime()),
			)
		) {
			throw new Error(
				'Development migration checksums or completion state do not match this checkout.',
			);
		}
	}
	return row.pid;
}

/**
 * Keep the long-running coordinator active and prove that its original session still owns the
 * lease. A failed check must stop fixture writers; it must never reacquire a lost lease.
 * @param {import('pg').Client} client
 * @param {number} expectedPid
 */
export async function verifyDevelopmentCoordinatorLease(client, expectedPid) {
	const result = await client.query(
		`SELECT pg_backend_pid() AS pid, EXISTS (
			SELECT 1 FROM pg_catalog.pg_locks
			WHERE pid = pg_backend_pid() AND locktype = 'advisory' AND granted
				AND mode = 'ExclusiveLock' AND classid = $1::oid AND objid = $2::oid
				AND objsubid = 2
		) AS held`,
		[...integrationLock],
	);
	const lease = record(result.rows[0]);
	return lease.pid === expectedPid && lease.held === true;
}
