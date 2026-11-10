import { spawn } from 'node:child_process';

import pg from 'pg';

import {
	coordinatorName,
	verifyDevelopmentCoordinatorLease,
	verifyDevelopmentSession,
} from './development-session.mjs';
import { loadNeonEnvironment, repositoryRoot } from './neon-environment.mjs';

/** @type {import('pg').Client | undefined} */
let coordinator;
/** @type {import('node:child_process').ChildProcess | undefined} */
let child;
/** @type {ReturnType<typeof setInterval> | undefined} */
let heartbeat;
const state = { lostConnection: false, heartbeatInFlight: false, finished: false };
const connectionWasLost = () => state.lostConnection;
function coordinatorLost() {
	if (state.lostConnection || state.finished) return;
	state.lostConnection = true;
	console.error('Development integration coordinator lost its verified lease.');
	child?.kill('SIGTERM');
}

try {
	if (process.argv.length !== 2)
		throw new Error(
			'Integration tests always run serially through the guarded development runner.',
		);
	const config = loadNeonEnvironment('development');
	const directUrl = new URL(config.directDatabaseUrl);
	directUrl.searchParams.set('application_name', coordinatorName);
	coordinator = new pg.Client({
		connectionString: directUrl.toString(),
		connectionTimeoutMillis: 10_000,
		keepAlive: true,
	});
	coordinator.on('error', coordinatorLost);
	await coordinator.connect();
	const pid = await verifyDevelopmentSession(coordinator, config, repositoryRoot);
	if (connectionWasLost()) throw new Error('The development integration coordinator disconnected.');
	const verifiedCoordinator = coordinator;
	heartbeat = setInterval(() => {
		if (state.heartbeatInFlight || connectionWasLost() || state.finished) return;
		state.heartbeatInFlight = true;
		void verifyDevelopmentCoordinatorLease(verifiedCoordinator, pid)
			.then((held) => {
				if (!held) coordinatorLost();
			})
			.catch(() => {
				coordinatorLost();
			})
			.finally(() => {
				state.heartbeatInFlight = false;
			});
	}, 30_000);
	child = spawn(
		process.execPath,
		[
			'--experimental-vm-modules',
			'node_modules/jest/bin/jest.js',
			'--config',
			'jest.config.cjs',
			'--selectProjects',
			'integration',
			'--runInBand',
		],
		{
			cwd: repositoryRoot,
			env: {
				...process.env,
				NODE_ENV: 'development',
				DATABASE_URL: config.databaseUrl,
				DIRECT_DATABASE_URL: config.directDatabaseUrl,
				AKIBA_INTEGRATION_COORDINATOR_PID: String(pid),
			},
			stdio: 'inherit',
		},
	);
	if (connectionWasLost()) child.kill('SIGTERM');
	process.once('SIGINT', () => child?.kill('SIGINT'));
	process.once('SIGTERM', () => child?.kill('SIGTERM'));
	/** @type {Promise<number>} */
	const completion = new Promise((resolve, reject) => {
		child?.once('error', reject);
		child?.once('exit', (code) => {
			resolve(code ?? 1);
		});
	});
	const status = await completion;
	state.finished = true;
	process.exitCode = connectionWasLost() ? 1 : status;
} catch (error) {
	// Driver errors may expose connection details; only authored guard messages are reported.
	const message =
		error instanceof Error && !('code' in error)
			? error.message
			: 'Development database preflight failed. Check the protected connection and migration configuration.';
	console.error(message);
	process.exitCode = 1;
} finally {
	if (heartbeat !== undefined) clearInterval(heartbeat);
	await coordinator?.end();
}
