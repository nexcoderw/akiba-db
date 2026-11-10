import { readFile } from 'node:fs/promises';

describe('global identity security storage contract', () => {
	it('retains one global identity and one credential with explicit lifecycle versions', async () => {
		const source = await readFile(new URL('../../prisma/schema.prisma', import.meta.url), 'utf8');
		const user = /model User \{[\s\S]*?\n\}/u.exec(source)?.[0];
		const credential = /model PasswordCredential \{[\s\S]*?\n\}/u.exec(source)?.[0];
		expect(user).toContain('identityVersion');
		expect(user).toContain('@db.Citext');
		expect(user).not.toContain('organizationId');
		expect(credential).toMatch(/userId\s+String\s+@unique/u);
		expect(credential).toMatch(/normalization\s+String\s+@default\("raw"\)/u);
		expect(credential).toContain('disabledAt');
		expect(credential).toMatch(/version\s+Int\s+@default\(1\)/u);
		expect(source).toMatch(/DISABLED\s+@map\("disabled"\)/u);
	});

	it('binds digest-only mailbox proofs to an identity version and an expiration', async () => {
		const source = await readFile(new URL('../../prisma/schema.prisma', import.meta.url), 'utf8');
		const proof = /model UserEmailVerificationChallenge \{[\s\S]*?\n\}/u.exec(source)?.[0];
		expect(proof).toContain('identityVersion');
		expect(proof).toContain('targetEmail');
		expect(proof).toMatch(/tokenDigest\s+String\s+@unique/u);
		expect(proof).toContain('expiresAt');
		expect(proof).toContain('consumedAt');
		expect(proof).not.toMatch(/^\s+token\s+/mu);
	});

	it('adds forward-only checks and audit immutability without rewriting credentials', async () => {
		const source = await readFile(
			new URL(
				'../../prisma/migrations/20261110170000_identity_credential_foundation/migration.sql',
				import.meta.url,
			),
			'utf8',
		);
		expect(source).toContain('VALIDATE CONSTRAINT users_email_identity_check');
		expect(source).toContain("normalization IN ('raw', 'nfc')");
		expect(source).toContain('ON DELETE RESTRICT ON UPDATE RESTRICT');
		expect(source).toContain('actor_user_id IS NOT NULL');
		expect(source).toContain('NEW.email_verified_at := NULL');
		expect(source).toContain('NEW.identity_version := GREATEST');
		expect(source).toContain('BEFORE UPDATE OR DELETE ON public.identity_security_audit_events');
		expect(source).toContain('BEFORE TRUNCATE ON public.identity_security_audit_events');
		expect(source).not.toMatch(
			/^\s*(?:DROP TABLE|TRUNCATE|UPDATE public\.password_credentials SET password_hash)\b/mu,
		);
	});
});
