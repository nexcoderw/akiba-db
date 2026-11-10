import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const retirement = new URL(
	'../../prisma/migrations/20261110120000_retire_legacy_commercial_models/migration.sql',
	import.meta.url,
);

describe('Akiba migration foundation', () => {
	it('preserves the exact checksums of every inherited migration', async () => {
		const history: unknown = JSON.parse(
			await readFile(new URL('./migration-history-checksums.json', import.meta.url), 'utf8'),
		);
		if (typeof history !== 'object' || history === null)
			throw new Error('Invalid migration history.');
		expect(Object.keys(history)).toHaveLength(26);
		for (const [name, checksum] of Object.entries(history)) {
			const source = await readFile(new URL(`../../${name}`, import.meta.url));
			expect(createHash('sha256').update(source).digest('hex')).toBe(checksum);
		}
	});

	it('locks and checks every retired table before any removal, including audit history', async () => {
		const source = await readFile(retirement, 'utf8');
		const locked = /LOCK TABLE([\s\S]*?)IN ACCESS EXCLUSIVE MODE;/u.exec(source)?.[1];
		const dropped = /DROP TABLE([\s\S]*?)RESTRICT;/u.exec(source)?.[1];
		const tables = [...(dropped ?? '').matchAll(/public\.(\w+)/gu)].map((match) => match[1]);
		expect(tables).toHaveLength(8);
		for (const table of tables) {
			if (table === undefined) throw new Error('A retired table name is missing.');
			expect(locked).toContain(`public.${table}`);
			expect(source).toContain(`EXISTS (SELECT 1 FROM public.${table})`);
		}
		expect(source.indexOf('LOCK TABLE')).toBeLessThan(source.indexOf('DO $retirement_guard$'));
		expect(source.indexOf('END\n$retirement_guard$;')).toBeLessThan(source.indexOf('DROP TABLE'));
		expect(source).toContain("RAISE EXCEPTION 'Akiba retirement refused");
		expect(source).toContain('SET LOCAL row_security = off;');
		expect(source).toContain("SET LOCAL lock_timeout = '10s';");
		expect(source).toContain("SET LOCAL statement_timeout = '60s';");
		expect(source).toMatch(/\nBEGIN;[\s\S]+\nCOMMIT;\s*$/u);
		expect(source).not.toMatch(/^\s*(?:DELETE FROM|TRUNCATE|DROP EXTENSION)\b|^\s*CASCADE\s*;/imu);
	});
});
