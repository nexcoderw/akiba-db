import { readFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';

async function readRootFile(name: string): Promise<string> {
	return await readFile(new URL(`../../${name}`, import.meta.url), 'utf8');
}

describe('database workflow environment boundaries', () => {
	it('separates development databases even when they share one endpoint', async () => {
		const runtime = parseEnv(await readRootFile('.env.local.example'));
		const migrations = parseEnv(await readRootFile('.env.migrations.local.example'));
		const tests = parseEnv(await readRootFile('.env.test.local.example'));
		const targets = [
			[runtime.DATABASE_URL, '/akiba_dev'],
			[migrations.DIRECT_DATABASE_URL, '/akiba_dev'],
			[migrations.SHADOW_DATABASE_URL, '/akiba_shadow'],
			[migrations.TEST_MIGRATION_DATABASE_URL, '/akiba_test'],
			[tests.TEST_DATABASE_URL, '/akiba_test'],
		];
		for (const [value, database] of targets) {
			if (value === undefined) throw new Error('A development database target is missing.');
			const url = new URL(value);
			expect(url.hostname).toBe('localhost');
			expect(url.pathname).toBe(database);
		}
		expect(migrations.DATABASE_URL).toBeUndefined();
	});

	it('keeps CLI and test credentials out of the runtime template', async () => {
		const runtime = parseEnv(await readRootFile('.env.local.example'));
		expect(Object.keys(runtime)).toEqual(['DATABASE_URL']);
	});

	it('separates migration credentials from restricted test connections', async () => {
		const migrations = parseEnv(await readRootFile('.env.migrations.local.example'));
		const tests = parseEnv(await readRootFile('.env.test.local.example'));
		expect(migrations.TEST_MIGRATION_DATABASE_URL).toBeDefined();
		expect(migrations.TEST_DATABASE_URL).toBeUndefined();
		expect(tests.TEST_MIGRATION_DATABASE_URL).toBeUndefined();
		expect(tests.DATABASE_URL).toBeUndefined();
		expect(tests.NODE_ENV).toBe('test');
		expect(tests.TEST_DATABASE_MARKER).toBeDefined();
		for (const name of ['DIRECT_DATABASE_URL', 'SHADOW_DATABASE_URL']) {
			const value = tests[name];
			if (value === undefined) throw new Error('A reference-only test target is missing.');
			expect(new URL(value).password).toBe('');
		}
	});

	it('loads dedicated files without sourcing shell syntax or loading DDL credentials in tests', async () => {
		const manifest: unknown = JSON.parse(await readRootFile('package.json'));
		expect(manifest).toMatchObject({
			scripts: {
				'migration:test:deploy': 'prisma migrate deploy --config prisma.test.config.ts',
				'test:integration':
					'node --env-file=.env.local --env-file=.env.test.local --experimental-vm-modules ./node_modules/jest/bin/jest.js --config jest.config.cjs --selectProjects integration --runInBand',
			},
		});
		const config = await readRootFile('prisma.test.config.ts');
		expect(config).toContain("env('TEST_MIGRATION_DATABASE_URL')");
		expect(config).not.toContain('shadowDatabaseUrl');
		expect(config).toContain("path: '.env.migrations.local'");
		const migrationConfig = await readRootFile('prisma.config.ts');
		expect(migrationConfig).toMatch(
			/path:\s*process\.env\.NODE_ENV\s*===\s*'production'\s*\?\s*'\.env\.production'\s*:\s*'\.env\.migrations\.local'/u,
		);
	});

	it('keeps production migrations on DATABASE_URL without a shadow database', async () => {
		const config = await readRootFile('prisma.config.ts');
		expect(config).toContain("const production = process.env.NODE_ENV === 'production'");
		expect(config).toMatch(
			/const migrationDatabaseUrl\s*=\s*production\s*\?\s*env\('DATABASE_URL'\)\s*:\s*\(process\.env\.DIRECT_DATABASE_URL\s*\?\?\s*env\('DATABASE_URL'\)\)/u,
		);
		expect(config).toMatch(
			/const shadowDatabaseUrl\s*=\s*production\s*\?\s*undefined\s*:\s*process\.env\.SHADOW_DATABASE_URL/u,
		);
	});
});
