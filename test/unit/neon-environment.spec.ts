import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
	loadNeonEnvironment,
	NeonEnvironmentError,
	neonCommandErrorMessage,
	parseApprovedTargets,
	validateNeonEnvironment,
} from '../../scripts/neon-environment.mjs';
import { approvedTargets, neonEnvironment } from './neon-environment-fixtures.js';

describe('Neon branch selection', () => {
	it('reports the unapproved branch through safe command diagnostics', () => {
		try {
			parseApprovedTargets({
				development: approvedTargets.development,
				production: { ...approvedTargets.production, directHost: '' },
			});
			throw new Error('Expected the missing production approval to be rejected.');
		} catch (error: unknown) {
			expect(error).toBeInstanceOf(NeonEnvironmentError);
			expect(neonCommandErrorMessage(error)).toBe(
				'Approve the production Neon direct hostname, default database and managed owner first.',
			);
		}
	});

	it.each(['ENOTFOUND', '28P01', '42501', 'unrecognized-code'])(
		'redacts provider messages and connection details for %s',
		(code) => {
			const failure = Object.assign(
				new Error('postgresql://user:synthetic-secret@private.invalid/db'),
				{ code, detail: 'SQL and credential details must stay private' },
			);
			const message = neonCommandErrorMessage(failure);
			expect(message).not.toMatch(/postgresql|synthetic-secret|private\.invalid|SQL/u);
			expect(message).not.toContain(code);
		},
	);

	it('does not echo unknown error codes or untyped connection failures', () => {
		for (const failure of [
			new Error('synthetic-secret'),
			{ code: 'synthetic-secret', message: 'synthetic-secret' },
			'synthetic-secret',
			null,
		]) {
			expect(neonCommandErrorMessage(failure)).toBe(
				'Database command failed. Check protected connection settings and database availability.',
			);
		}
	});

	it.each(['development', 'production'] as const)(
		'accepts matching pooled/direct connections for %s',
		(selected) => {
			expect(
				validateNeonEnvironment(selected, neonEnvironment(selected), approvedTargets),
			).toMatchObject({ selected, databaseName: 'neondb', databaseUser: 'neondb_owner' });
		},
	);

	it.each(['development', 'production'] as const)(
		'rejects the other branch mislabeled as %s',
		(selected) => {
			const other = selected === 'development' ? 'production' : 'development';
			expect(() =>
				validateNeonEnvironment(
					selected,
					{ ...neonEnvironment(other), NODE_ENV: selected },
					approvedTargets,
				),
			).toThrow('do not match');
		},
	);

	it('requires distinct approved endpoints and fails closed until provisioned', () => {
		expect(() =>
			parseApprovedTargets({
				development: { ...approvedTargets.development, directHost: '' },
				production: approvedTargets.production,
			}),
		).toThrow('Approve');
		expect(() =>
			parseApprovedTargets({
				development: approvedTargets.development,
				production: approvedTargets.development,
			}),
		).toThrow('distinct');
	});

	it.each([
		{ NODE_ENV: 'production' },
		{ DATABASE_URL: undefined },
		{ DIRECT_DATABASE_URL: undefined },
		{ DATABASE_URL: neonEnvironment().DIRECT_DATABASE_URL },
		{ DIRECT_DATABASE_URL: neonEnvironment('production').DIRECT_DATABASE_URL },
		{ DIRECT_DATABASE_URL: neonEnvironment().DIRECT_DATABASE_URL?.replace('neondb?', 'another?') },
		{
			DIRECT_DATABASE_URL: neonEnvironment().DIRECT_DATABASE_URL?.replace(
				'neondb_owner:',
				'another:',
			),
		},
		{
			DIRECT_DATABASE_URL: neonEnvironment().DIRECT_DATABASE_URL?.replace(
				'synthetic-password',
				'different',
			),
		},
		{ DATABASE_URL: neonEnvironment().DATABASE_URL?.replace('sslmode=require', 'sslmode=disable') },
		{ DATABASE_URL: `${neonEnvironment().DATABASE_URL ?? ''}&host=production.example.com` },
		{ DATABASE_URL: `${neonEnvironment().DATABASE_URL ?? ''}&sslmode=require` },
	])('rejects missing, mixed or redirected credentials without exposing them', (override) => {
		expect(() =>
			validateNeonEnvironment(
				'development',
				{ ...neonEnvironment(), ...override },
				approvedTargets,
			),
		).toThrow();
		try {
			validateNeonEnvironment(
				'development',
				{ ...neonEnvironment(), ...override },
				approvedTargets,
			);
		} catch (error: unknown) {
			expect(String(error)).not.toContain('synthetic-password');
		}
	});

	it('loads exactly the selected file and supports injected production secrets without a file', () => {
		const root = mkdtempSync(join(tmpdir(), 'akiba-environment-'));
		try {
			const local = neonEnvironment();
			writeFileSync(
				join(root, '.env.local'),
				`NODE_ENV=development\nDATABASE_URL="${local.DATABASE_URL ?? ''}"\nDIRECT_DATABASE_URL="${local.DIRECT_DATABASE_URL ?? ''}"\n`,
			);
			expect(loadNeonEnvironment('development', {}, root, approvedTargets).databaseUrl).toBe(
				local.DATABASE_URL,
			);
			expect(
				loadNeonEnvironment('production', neonEnvironment('production'), root, approvedTargets)
					.selected,
			).toBe('production');
			expect(() => loadNeonEnvironment('production', {}, root, approvedTargets)).toThrow(
				'explicitly injected',
			);
			expect(() =>
				loadNeonEnvironment('development', neonEnvironment('production'), root, approvedTargets),
			).toThrow('different NODE_ENV');
			expect(() =>
				loadNeonEnvironment(
					'development',
					{ ...neonEnvironment('production'), NODE_ENV: 'development' },
					root,
					approvedTargets,
				),
			).toThrow('conflict');
			expect(() =>
				loadNeonEnvironment(
					'development',
					{ DIRECT_DATABASE_URL: local.DIRECT_DATABASE_URL },
					root,
					approvedTargets,
				),
			).toThrow('both connection URLs');
			writeFileSync(join(root, '.env.local'), 'NODE_ENV=production\n');
			expect(() => loadNeonEnvironment('development', {}, root, approvedTargets)).toThrow(
				'conflicting NODE_ENV',
			);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
