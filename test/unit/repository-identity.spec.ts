import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = new URL('../../', import.meta.url);
const obsoleteIdentity = /g[y]m|fit[n]ess|work[o]ut|tra[i]ner/iu;

describe('Akiba repository identity', () => {
	it('keeps authored files and filenames free of obsolete project identity', async () => {
		const files = execFileSync(
			'git',
			['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
			{
				cwd: fileURLToPath(root),
				encoding: 'utf8',
			},
		)
			.split('\0')
			.filter((name) => name !== '' && existsSync(new URL(name, root)));
		const matches: string[] = [];
		for (const name of files) {
			const source = await readFile(new URL(name, root), 'utf8');
			// Third-party integrity hashes and metadata are not authored project identity.
			const content = name === 'package-lock.json' ? source.split('"packages":')[0] : source;
			if (obsoleteIdentity.test(name) || obsoleteIdentity.test(content ?? '')) matches.push(name);
		}
		expect(files.length).toBeGreaterThan(0);
		expect(matches).toEqual([]);
	});

	it('keeps the library and lockfile identity aligned with the Akiba repository', async () => {
		const manifest: unknown = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
		const lock: unknown = JSON.parse(await readFile(new URL('package-lock.json', root), 'utf8'));
		expect(manifest).toMatchObject({
			name: '@nexcoderw/akiba-db',
			version: '0.2.0',
			repository: { url: 'git+https://github.com/nexcoderw/akiba-db.git' },
		});
		expect(lock).toMatchObject({
			name: '@nexcoderw/akiba-db',
			version: '0.2.0',
			packages: { '': { name: '@nexcoderw/akiba-db', version: '0.2.0' } },
		});
	});
});
