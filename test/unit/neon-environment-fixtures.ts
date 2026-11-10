import type { ApprovedTargets } from '../../scripts/neon-environment.mjs';

export const approvedTargets: ApprovedTargets = {
	development: {
		directHost: 'ep-akiba-dev-a1.us-east-2.aws.neon.tech',
		database: 'neondb',
		user: 'neondb_owner',
	},
	production: {
		directHost: 'ep-akiba-prod-b2.us-east-2.aws.neon.tech',
		database: 'neondb',
		user: 'neondb_owner',
	},
};

export function neonEnvironment(
	selected: 'development' | 'production' = 'development',
): NodeJS.ProcessEnv {
	const host = approvedTargets[selected].directHost;
	return {
		NODE_ENV: selected,
		DATABASE_URL: `postgresql://neondb_owner:synthetic-password@${host.replace('.', '-pooler.')}/neondb?sslmode=require&channel_binding=require`,
		DIRECT_DATABASE_URL: `postgresql://neondb_owner:synthetic-password@${host}/neondb?sslmode=require&channel_binding=require`,
		AKIBA_INTEGRATION_COORDINATOR_PID: '12345',
	};
}
