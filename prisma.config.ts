import { defineConfig } from 'prisma/config';

import { loadNeonEnvironment } from './scripts/neon-environment.mjs';

// Schema-only commands are offline and require no fabricated datasource or secrets.
const offline = process.argv.some((argument) =>
	['generate', 'format', 'validate', 'version', '--version', '--help', '-h'].includes(argument),
);
const command = process.argv.indexOf('migrate');
const action = command < 0 ? undefined : process.argv[command + 1];

if (!offline && !['status', 'diff', 'deploy'].includes(action ?? '')) {
	throw new Error('Only reviewed status, diff and deploy workflows are supported.');
}
if (
	!offline &&
	action === 'diff' &&
	(!process.argv.includes('--from-config-datasource') ||
		!process.argv.includes('--to-schema') ||
		process.argv.some(
			(argument) =>
				(argument.startsWith('--from-') && argument !== '--from-config-datasource') ||
				(argument.startsWith('--to-') && argument !== '--to-schema'),
		))
) {
	throw new Error('Diffs must compare the selected datasource to the canonical schema.');
}
if (!offline && process.env.NODE_ENV !== 'development' && process.env.NODE_ENV !== 'production') {
	throw new Error('Select an explicit development or production migration script.');
}
const connection = offline
	? undefined
	: loadNeonEnvironment(process.env.NODE_ENV === 'production' ? 'production' : 'development');

export default defineConfig({
	schema: 'prisma/schema.prisma',
	migrations: {
		path: 'prisma/migrations',
	},
	...(connection === undefined ? {} : { datasource: { url: connection.directDatabaseUrl } }),
});
