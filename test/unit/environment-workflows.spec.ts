import { readdir, readFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';

async function readRootFile(name: string): Promise<string> {
	return readFile(new URL(`../../${name}`, import.meta.url), 'utf8');
}

describe('two-branch Neon workflow', () => {
	it('provides exactly two environment examples with one pooled/direct pair each', async () => {
		const files = await readdir(new URL('../../', import.meta.url));
		expect(
			files.filter((file) => file.startsWith('.env') && file.endsWith('.example')).sort(),
		).toEqual(['.env.local.example', '.env.production.example']);
		for (const [file, selected] of [
			['.env.local.example', 'development'],
			['.env.production.example', 'production'],
		]) {
			if (file === undefined) throw new Error('Missing environment example.');
			const values = parseEnv(await readRootFile(file));
			expect(Object.keys(values).sort()).toEqual([
				'DATABASE_URL',
				'DIRECT_DATABASE_URL',
				'NODE_ENV',
			]);
			expect(values.NODE_ENV).toBe(selected);
			const pooled = new URL(values.DATABASE_URL ?? '');
			const direct = new URL(values.DIRECT_DATABASE_URL ?? '');
			expect(pooled.pathname).toBe(direct.pathname);
			expect(pooled.username).toBe(direct.username);
			expect(pooled.password).toBe(direct.password);
			expect(pooled.hostname).not.toBe(direct.hostname);
			expect(pooled.searchParams.get('sslmode')).toBe('verify-full');
			expect(direct.searchParams.get('sslmode')).toBe('verify-full');
		}
	});

	it('keeps default tests offline and exposes explicit guarded migration targets', async () => {
		const manifest: unknown = JSON.parse(await readRootFile('package.json'));
		expect(manifest).toMatchObject({
			scripts: {
				test: 'node --experimental-vm-modules ./node_modules/jest/bin/jest.js --config jest.config.cjs --selectProjects unit --runInBand',
				'test:integration': 'node scripts/run-integration-tests.mjs',
				'migration:diff': 'node scripts/database-command.mjs development diff',
				'migration:deploy': 'node scripts/database-command.mjs development deploy',
				'migration:production:deploy': 'node scripts/database-command.mjs production deploy',
			},
		});
		const config = await readRootFile('prisma.config.ts');
		expect(config).toContain('connection.directDatabaseUrl');
		expect(config).not.toContain('shadowDatabaseUrl');
		const ci = await readRootFile('.github/workflows/ci-cd.yml');
		expect(ci).not.toContain('DATABASE_URL:');
	});
});
