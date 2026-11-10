import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';

import { jest } from '@jest/globals';
import type { Client } from 'pg';

import {
	verifyDevelopmentCoordinatorLease,
	verifyDevelopmentSession,
} from '../../scripts/development-session.mjs';
import { repositoryRoot } from '../../scripts/neon-environment.mjs';

type Query = (sql: string, values?: readonly unknown[]) => Promise<{ rows: unknown[] }>;

function clientWithPreflight(
	overrides: { identity?: object; acquired?: boolean; clients?: number; history?: object[] } = {},
) {
	const migrations = readdirSync(`${repositoryRoot}/prisma/migrations`, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => ({
			migration_name: entry.name,
			checksum: createHash('sha256')
				.update(readFileSync(`${repositoryRoot}/prisma/migrations/${entry.name}/migration.sql`))
				.digest('hex'),
			finished_at: new Date(),
			rolled_back_at: null,
		}));
	const query = jest
		.fn<Query>()
		.mockResolvedValueOnce({
			rows: [overrides.identity ?? { name: 'neondb', username: 'neondb_owner', pid: 12345 }],
		})
		.mockResolvedValueOnce({ rows: [{ acquired: overrides.acquired ?? true }] })
		.mockResolvedValueOnce({ rows: [{ count: overrides.clients ?? 0 }] })
		.mockResolvedValueOnce({ rows: overrides.history ?? migrations });
	return { query, client: { query } as unknown as Client };
}

const config = { databaseName: 'neondb', databaseUser: 'neondb_owner' };

describe('exclusive development integration preflight', () => {
	it('verifies completed migration checksums before authorizing the runner', async () => {
		const { client, query } = clientWithPreflight();
		await expect(verifyDevelopmentSession(client, config, repositoryRoot)).resolves.toBe(12345);
		expect(query).toHaveBeenCalledTimes(4);
		expect(query.mock.calls.map(([sql]) => sql).every((sql) => sql.startsWith('SELECT '))).toBe(
			true,
		);
	});

	it.each([
		{
			override: { identity: { name: 'other', username: 'neondb_owner', pid: 12345 } },
			message: 'identity differs',
		},
		{ override: { acquired: false }, message: 'Another development' },
		{ override: { clients: 1 }, message: 'exclusive maintenance window' },
		{ override: { history: [] }, message: 'not synchronized' },
	])('refuses unsafe preconditions: $message', async ({ override, message }) => {
		const { client } = clientWithPreflight(override);
		await expect(verifyDevelopmentSession(client, config, repositoryRoot)).rejects.toThrow(message);
	});

	it('keeps only the original lease-owning coordinator eligible', async () => {
		const query = jest.fn<Query>();
		const client = { query } as unknown as Client;
		query.mockResolvedValueOnce({ rows: [{ pid: 12345, held: true }] });
		await expect(verifyDevelopmentCoordinatorLease(client, 12345)).resolves.toBe(true);
		query.mockResolvedValueOnce({ rows: [{ pid: 12346, held: true }] });
		await expect(verifyDevelopmentCoordinatorLease(client, 12345)).resolves.toBe(false);
		query.mockResolvedValueOnce({ rows: [{ pid: 12345, held: false }] });
		await expect(verifyDevelopmentCoordinatorLease(client, 12345)).resolves.toBe(false);
		expect(query.mock.calls.every(([, values]) => values?.length === 2)).toBe(true);
	});
});
