import { spawnSync } from 'node:child_process';

import { loadNeonEnvironment, repositoryRoot } from './neon-environment.mjs';

const [selected, action, ...extra] = process.argv.slice(2);

if (
	!['development', 'production'].includes(selected ?? '') ||
	!['status', 'diff', 'review', 'check', 'deploy'].includes(action ?? '') ||
	extra.length ||
	(selected === 'production' && ['diff', 'review'].includes(action ?? ''))
) {
	console.error('Use a supported migration script without additional arguments.');
	process.exit(1);
}

try {
	const config = loadNeonEnvironment(/** @type {'development' | 'production'} */ (selected));
	const environment = {
		...process.env,
		NODE_ENV: config.selected,
		DATABASE_URL: config.databaseUrl,
		DIRECT_DATABASE_URL: config.directDatabaseUrl,
	};
	/** @param {string[]} args @param {boolean} [diagnostic] */
	const run = (args, diagnostic = false) => {
		const result = spawnSync(process.execPath, ['node_modules/prisma/build/index.js', ...args], {
			cwd: repositoryRoot,
			env: environment,
			stdio: diagnostic ? ['ignore', process.stderr, process.stderr] : 'inherit',
		});
		return result.status ?? 1;
	};
	if (action === 'diff' || action === 'review' || action === 'check') {
		// Review is read-only and permits examining an authored pending migration before deploy.
		// Ordinary drift checks still require synchronized history. The operator reviews status first.
		if (action !== 'review') {
			const status = run(['migrate', 'status'], true);
			if (status !== 0) process.exit(status);
		}
		process.exit(
			run([
				'migrate',
				'diff',
				'--from-config-datasource',
				'--to-schema',
				'prisma/schema.prisma',
				action === 'check' ? '--exit-code' : '--script',
			]),
		);
	}
	process.exit(run(['migrate', action ?? 'status']));
} catch (error) {
	console.error(error instanceof Error ? error.message : 'Database environment validation failed.');
	process.exit(1);
}
