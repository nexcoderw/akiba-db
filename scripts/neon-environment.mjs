import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { parse } from 'dotenv';

export const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));

/** @typedef {'development' | 'production'} DatabaseEnvironment */
/** @typedef {{directHost: string, database: string, user: string}} ApprovedTarget */
/** @typedef {Record<DatabaseEnvironment, ApprovedTarget>} ApprovedTargets */

/** Read only non-secret, operator-reviewed branch endpoint identities. */
export function readApprovedTargets() {
	/** @type {unknown} */
	const value = JSON.parse(
		readFileSync(new URL('../neon.environments.json', import.meta.url), 'utf8'),
	);
	return parseApprovedTargets(value);
}

/** @param {unknown} value @returns {ApprovedTargets} */
export function parseApprovedTargets(value) {
	if (typeof value !== 'object' || value === null || Object.keys(value).length !== 2) {
		throw new Error(
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
		if (
			typeof entry !== 'object' ||
			entry === null ||
			!('directHost' in entry) ||
			typeof entry.directHost !== 'string' ||
			!/^ep-[a-z0-9-]+\.[a-z0-9.-]+\.neon\.tech$/u.test(entry.directHost) ||
			entry.directHost.includes('-pooler.') ||
			!('database' in entry) ||
			typeof entry.database !== 'string' ||
			entry.database.trim() === '' ||
			!('user' in entry) ||
			typeof entry.user !== 'string' ||
			entry.user.trim() === ''
		) {
			throw new Error(
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
		throw new Error('Development and production must use distinct approved Neon endpoints.');
	}
	return { development: targets.development, production: targets.production };
}

/** @param {string | undefined} value @param {string} name */
function parseConnection(value, name) {
	if (!value?.trim()) throw new Error(`${name} is required; no connection fallback is permitted.`);
	let url;
	try {
		url = new URL(value);
	} catch {
		throw new Error(`${name} must be a valid PostgreSQL URL.`);
	}
	if (
		!['postgres:', 'postgresql:'].includes(url.protocol) ||
		url.hash ||
		(url.port && url.port !== '5432')
	) {
		throw new Error(`${name} must use PostgreSQL on the standard Neon port without a fragment.`);
	}
	const allowed = new Set(['sslmode', 'channel_binding', 'connect_timeout', 'application_name']);
	const seen = new Set();
	for (const [key] of url.searchParams) {
		if (!allowed.has(key) || seen.has(key))
			throw new Error(`${name} contains unsupported or duplicate connection options.`);
		seen.add(key);
	}
	if (!['require', 'verify-ca', 'verify-full'].includes(url.searchParams.get('sslmode') ?? '')) {
		throw new Error(`${name} must require TLS.`);
	}
	if (
		url.searchParams.has('channel_binding') &&
		url.searchParams.get('channel_binding') !== 'require'
	) {
		throw new Error(`${name} must require channel binding when configured.`);
	}
	try {
		return {
			url,
			database: decodeURIComponent(url.pathname.slice(1)),
			user: decodeURIComponent(url.username),
			password: decodeURIComponent(url.password),
		};
	} catch {
		throw new Error(`${name} contains invalid URL encoding.`);
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
		throw new Error(`NODE_ENV must be ${selected} for this command.`);
	const approved = parseApprovedTargets(targets)[selected];
	const pooled = parseConnection(environment.DATABASE_URL, 'DATABASE_URL');
	const direct = parseConnection(environment.DIRECT_DATABASE_URL, 'DIRECT_DATABASE_URL');
	const pooledHost = approved.directHost.replace('.', '-pooler.');
	if (pooled.url.hostname !== pooledHost || direct.url.hostname !== approved.directHost) {
		throw new Error(`Connection hosts do not match the approved ${selected} Neon endpoint.`);
	}
	if (
		[pooled, direct].some(
			(connection) =>
				connection.database !== approved.database || connection.user !== approved.user,
		) ||
		pooled.password === '' ||
		pooled.password !== direct.password
	) {
		throw new Error(
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
	targets = readApprovedTargets(),
) {
	if (environment.NODE_ENV !== undefined && environment.NODE_ENV !== selected) {
		throw new Error(`Refusing ${selected} command under a different NODE_ENV.`);
	}
	if (selected === 'production' && environment.NODE_ENV !== 'production') {
		throw new Error('Production commands require an explicitly injected NODE_ENV=production.');
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
		throw new Error('The selected environment file has a conflicting NODE_ENV.');
	}
	const hasInjectedUrl =
		environment.DATABASE_URL !== undefined || environment.DIRECT_DATABASE_URL !== undefined;
	if (hasInjectedUrl && (!environment.DATABASE_URL || !environment.DIRECT_DATABASE_URL)) {
		throw new Error(
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
		throw new Error('Injected development connections conflict with .env.local.');
	}
	return validateNeonEnvironment(
		selected,
		{ ...file, ...environment, NODE_ENV: selected },
		targets,
	);
}
