import { readFile } from 'node:fs/promises';

describe('first platform owner enrollment storage', () => {
	it('separates restricted setup proofs from operational platform sessions', async () => {
		const schema = await readFile(new URL('../../prisma/schema.prisma', import.meta.url), 'utf8');
		const model = /model PlatformOwnerEnrollment \{[\s\S]*?\n\}/u.exec(schema)?.[0];
		expect(model).toBeDefined();
		expect(model).toMatch(/platformStaffId\s+String\s+@unique/u);
		expect(model).toMatch(/tokenDigest\s+String\s+@unique/u);
		expect(model).toMatch(/sessionDigest\s+String\?\s+@unique/u);
		expect(model).toMatch(/encryptedSecret\s+Bytes\?/u);
		expect(model).not.toMatch(/^\s+(?:token|secret|recoveryCode|sessionToken)\s+/mu);
		expect(model).toContain('onDelete: Restrict, onUpdate: Restrict');
	});

	it('guards pending-owner identity, bounded attempts, envelope shape and reissue transitions', async () => {
		const sql = await readFile(new URL('../../prisma/migrations/20261119080000_platform_owner_enrollment/migration.sql', import.meta.url), 'utf8');
		for (const invariant of [
			'send_count BETWEEN 1 AND 3', 'failed_attempts BETWEEN 0 AND 5',
			'setup_version BETWEEN 0 AND 3', 'octet_length(initialization_vector) = 12',
			'octet_length(authentication_tag) = 16', 'identity.identity_version = NEW.identity_version',
			"role.key = 'platform.owner' AND role.is_system", 'OLD.consumed_at IS NOT NULL',
			'NEW.failed_attempts < OLD.failed_attempts', 'NEW.expires_at > OLD.expires_at',
		]) expect(sql).toContain(invariant);
		expect(sql).toContain('REVOKE ALL ON public.platform_owner_enrollments FROM PUBLIC');
		expect(sql).toContain('CREATE TRIGGER platform_owner_enrollment_guard');
		expect(sql).not.toMatch(/\b(?:TRUNCATE|DROP TABLE|DELETE FROM)\b/iu);
	});
});
