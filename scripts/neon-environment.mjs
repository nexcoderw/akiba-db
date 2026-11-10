import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { parse } from 'dotenv';

export const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));

/** @typedef {'development' | 'production'} DatabaseEnvironment */
/** @typedef {{directHost: string, database: string, user: string}} ApprovedTarget */
/** @typedef {Record<DatabaseEnvironment, ApprovedTarget>} ApprovedTargets */

/** Only repository-authored configuration messages may be shown by command error handlers. */
export class NeonEnvironmentError extends Error {
	/** @override */
	name = 'NeonEnvironmentError';
}

/** @type {Readonly<Record<string, string>>} */
const commandFailures = Object.freeze({
	ENOTFOUND: 'The database hostname could not be resolved. Check the selected Neon endpoint.',
	EAI_AGAIN: 'Database hostname resolution is temporarily unavailable. Try again later.',
	ECONNREFUSED: 'The database connection was refused. Check the endpoint and network access.',
	ECONNRESET: 'The database connection was interrupted. Try again after checking connectivity.',
	ETIMEDOUT: 'The database connection timed out. Check network access and endpoint availability.',
	'28P01': 'Database authentication failed. Check the selected environment credentials privately.',
	28000:
		'The database identity was rejected. Check the selected environment credentials privately.',
	42501:
		'The database identity lacks a required privilege. Review its grants without adding blanket access.',
});

/** @param {unknown} error @returns {string} */
export function neonCommandErrorMessage(error) {
	if (error instanceof NeonEnvironmentError) return error.message;
	if (
		typeof error === 'object' &&
		error !== null &&
		'code' in error &&
		typeof error.code === 'string' &&
		Object.hasOwn(commandFailures, error.code)
	) {
		return commandFailures[error.code] ?? 'Database command failed.';
	}
	return 'Database command failed. Check protected connection settings and database availability.';
}

/** Read only non-secret, operator-reviewed branch endpoint identities. */
/** @param {DatabaseEnvironment} [selected] */
export function readApprovedTargets(selected) {
	/** @type {unknown} */
	let value;
	try {
		value = JSON.parse(readFileSync(new URL('../neon.environments.json', import.meta.url), 'utf8'));
	} catch (error) {
		throw new NeonEnvironmentError('neon.environments.json must exist and contain valid JSON.', {
			cause: error,
		});
	}
	return parseApprovedTargets(value, selected);
}

/** @param {unknown} value @param {DatabaseEnvironment} [selected] @returns {ApprovedTargets} */
export function parseApprovedTargets(value, selected) {
	if (typeof value !== 'object' || value === null || Object.keys(value).length !== 2) {
		throw new NeonEnvironmentError(
			'Approve exactly development and production targets in neon.environments.json.',
		);
	}
	/** @type {Partial<ApprovedTargets>} */
	const targets = {};
	for (const name of /** @type {const} */ (['development', 'production'])) {
		const entry =
			name === 'development'
				? 'development' in value
					? value.development
					: undefined
				: 'production' in value
					? value.production
					: undefined;
		// An unapproved production endpoint cannot direct a development connection.
		// Retain the registry shape; production selection still requires its own approved host.
		const pendingProduction =
			selected === 'development' &&
			name === 'production' &&
			typeof entry === 'object' &&
			entry !== null &&
			'directHost' in entry &&
			entry.directHost === '';
		if (
			typeof entry !== 'object' ||
			entry === null ||
			!('directHost' in entry) ||
			typeof entry.directHost !== 'string' ||
			(!pendingProduction && !/^ep-[a-z0-9-]+\.[a-z0-9.-]+\.neon\.tech$/u.test(entry.directHost)) ||
			entry.directHost.includes('-pooler.') ||
			!('database' in entry) ||
			typeof entry.database !== 'string' ||
			entry.database.trim() === '' ||
			!('user' in entry) ||
			typeof entry.user !== 'string' ||
			entry.user.trim() === ''
		) {
			throw new NeonEnvironmentError(
				`Approve the ${name} Neon direct hostname, default database and managed owner first.`,
			);
		}
		targets[name] = { directHost: entry.directHost, database: entry.database, user: entry.user };
	}
	if (
		!targets.development ||
		!targets.production ||
		targets.development.directHost === targets.production.directHost
	) {
		throw new NeonEnvironmentError(
			'Development and production must use distinct approved Neon endpoints.',
		);
	}
	return { development: targets.development, production: targets.production };
}

/** @param {string | undefined} value @param {string} name */
function parseConnection(value, name) {
	if (!value?.trim())
		throw new NeonEnvironmentError(`${name} is required; no connection fallback is permitted.`);
	let url;
	try {
		url = new URL(value);
	} catch {
		throw new NeonEnvironmentError(`${name} must be a valid PostgreSQL URL.`);
	}
	if (
		!['postgres:', 'postgresql:'].includes(url.protocol) ||
		url.hash ||
		(url.port && url.port !== '5432')
	) {
		throw new NeonEnvironmentError(
			`${name} must use PostgreSQL on the standard Neon port without a fragment.`,
		);
	}
	const allowed = new Set(['sslmode', 'channel_binding', 'connect_timeout', 'application_name']);
	const seen = new Set();
	for (const [key] of url.searchParams) {
		if (!allowed.has(key) || seen.has(key))
			throw new NeonEnvironmentError(
				`${name} contains unsupported or duplicate connection options.`,
			);
		seen.add(key);
	}
	if (!['require', 'verify-ca', 'verify-full'].includes(url.searchParams.get('sslmode') ?? '')) {
		throw new NeonEnvironmentError(`${name} must require TLS.`);
	}
	if (
		url.searchParams.has('channel_binding') &&
		url.searchParams.get('channel_binding') !== 'require'
	) {
		throw new NeonEnvironmentError(`${name} must require channel binding when configured.`);
	}
	try {
		return {
			url,
			database: decodeURIComponent(url.pathname.slice(1)),
			user: decodeURIComponent(url.username),
			password: decodeURIComponent(url.password),
		};
	} catch {
		throw new NeonEnvironmentError(`${name} contains invalid URL encoding.`);
	}
}

/**
 * Reject mislabeled or mixed branch credentials before any database connection.
 * The approved hostname registry is a reviewed trust boundary, not a Neon API attestation.
 * @param {DatabaseEnvironment} selected
 * @param {NodeJS.ProcessEnv} environment
 * @param {ApprovedTargets} targets
 */
export function validateNeonEnvironment(selected, environment, targets) {
	if (environment.NODE_ENV !== selected)
		throw new NeonEnvironmentError(`NODE_ENV must be ${selected} for this command.`);
	const approved = parseApprovedTargets(targets, selected)[selected];
	const pooled = parseConnection(environment.DATABASE_URL, 'DATABASE_URL');
	const direct = parseConnection(environment.DIRECT_DATABASE_URL, 'DIRECT_DATABASE_URL');
	const pooledHost = approved.directHost.replace('.', '-pooler.');
	if (pooled.url.hostname !== pooledHost || direct.url.hostname !== approved.directHost) {
		throw new NeonEnvironmentError(
			`Connection hosts do not match the approved ${selected} Neon endpoint.`,
		);
	}
	if (
		[pooled, direct].some(
			(connection) =>
				connection.database !== approved.database || connection.user !== approved.user,
		) ||
		pooled.password === '' ||
		pooled.password !== direct.password
	) {
		throw new NeonEnvironmentError(
			'Pooled and direct URLs must use the approved default database and the same managed-owner credentials.',
		);
	}
	return Object.freeze({
		selected,
		databaseUrl: environment.DATABASE_URL ?? '',
		directDatabaseUrl: environment.DIRECT_DATABASE_URL ?? '',
		databaseName: approved.database,
		databaseUser: approved.user,
	});
}

/**
 * Load exactly one environment file. Injected complete credentials are supported without a file;
 * conflicting local/injected development values fail instead of silently changing targets.
 * @param {DatabaseEnvironment} selected
 * @param {NodeJS.ProcessEnv} [environment]
 * @param {string} [root]
 * @param {ApprovedTargets} [targets]
 */
export function loadNeonEnvironment(
	selected,
	environment = process.env,
	root = repositoryRoot,
	targets = readApprovedTargets(selected),
) {
	if (environment.NODE_ENV !== undefined && environment.NODE_ENV !== selected) {
		throw new NeonEnvironmentError(`Refusing ${selected} command under a different NODE_ENV.`);
	}
	if (selected === 'production' && environment.NODE_ENV !== 'production') {
		throw new NeonEnvironmentError(
			'Production commands require an explicitly injected NODE_ENV=production.',
		);
	}
	/** @type {Record<string, string>} */
	let file = {};
	try {
		file = parse(
			readFileSync(`${root}/${selected === 'production' ? '.env.production' : '.env.local'}`),
		);
	} catch (error) {
		if (!(
			typeof error === 'object' &&
			error !== null &&
			'code' in error &&
			error.code === 'ENOENT'
		))
			throw error;
	}
	if (file.NODE_ENV !== undefined && file.NODE_ENV !== selected) {
		throw new NeonEnvironmentError('The selected environment file has a conflicting NODE_ENV.');
	}
	const hasInjectedUrl =
		environment.DATABASE_URL !== undefined || environment.DIRECT_DATABASE_URL !== undefined;
	if (hasInjectedUrl && (!environment.DATABASE_URL || !environment.DIRECT_DATABASE_URL)) {
		throw new NeonEnvironmentError(
			'Inject both connection URLs together; partial credential sources are forbidden.',
		);
	}
	if (
		selected === 'development' &&
		hasInjectedUrl &&
		['DATABASE_URL', 'DIRECT_DATABASE_URL'].some(
			(key) => file[key] !== undefined && file[key] !== environment[key],
		)
	) {
		throw new NeonEnvironmentError('Injected development connections conflict with .env.local.');
	}
	return validateNeonEnvironment(
		selected,
		{ ...file, ...environment, NODE_ENV: selected },
		targets,
	);
}
