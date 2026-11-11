import { readFile } from 'node:fs/promises';

describe('Prisma schema contract', () => {
	it('keeps Prisma 7 connection configuration outside the canonical schema', async () => {
		const schemaUrl = new URL('../../prisma/schema.prisma', import.meta.url);
		const schema = await readFile(schemaUrl, 'utf8');

		expect(schema).toMatch(/provider\s*=\s*"prisma-client"/u);
		expect(schema).toMatch(/output\s*=\s*"\.\.\/src\/generated\/prisma"/u);
		expect(schema).toMatch(/provider\s*=\s*"postgresql"/u);
		expect(schema).not.toMatch(/^\s*url\s*=/mu);
	});

	it('defines global identity and explicit platform authorization models', async () => {
		const schemaUrl = new URL('../../prisma/schema.prisma', import.meta.url);
		const schema = await readFile(schemaUrl, 'utf8');

		for (const model of [
			'User',
			'PasswordCredential',
			'PlatformStaff',
			'PlatformRole',
			'PlatformPermission',
			'PlatformStaffRole',
			'PlatformRolePermission',
			'PlatformAdminSession',
			'PlatformTotpCredential',
			'PlatformRecoveryCode',
			'PlatformMfaChallenge',
		]) {
			const modelBlock = new RegExp(`model ${model} \\{[\\s\\S]*?\\n\\}`, 'u').exec(schema)?.[0];
			expect(modelBlock).toBeDefined();
			expect(modelBlock).not.toContain('organizationId');
		}
		expect(schema).toMatch(/email\s+String\s+@unique\([^\n]+\)\s+@db\.Citext/u);
		expect(schema).not.toContain('isSuperAdmin');
	});

	it('stores only protected platform authentication material', async () => {
		const schemaUrl = new URL('../../prisma/schema.prisma', import.meta.url);
		const schema = await readFile(schemaUrl, 'utf8');
		const session = /model PlatformAdminSession \{[\s\S]*?\n\}/u.exec(schema)?.[0];
		const totp = /model PlatformTotpCredential \{[\s\S]*?\n\}/u.exec(schema)?.[0];
		const recoveryCode = /model PlatformRecoveryCode \{[\s\S]*?\n\}/u.exec(schema)?.[0];
		const challenge = /model PlatformMfaChallenge \{[\s\S]*?\n\}/u.exec(schema)?.[0];

		expect(session).toMatch(/tokenDigest\s+String\s+@unique/u);
		expect(session).toMatch(/mfaVerifiedAt\s+DateTime\s+@map/u);
		expect(session).toContain('revocationReason');
		expect(totp).toMatch(/platformStaffId\s+String\s+@unique/u);
		expect(totp).toMatch(/encryptedSecret\s+Bytes/u);
		expect(totp).toContain('lastAcceptedTimeStep BigInt?');
		expect(recoveryCode).toMatch(/codeDigest\s+String\s+@unique/u);
		expect(challenge).toMatch(/tokenDigest\s+String\s+@unique/u);
		expect(challenge).toContain('failedAttempts');
		expect(challenge).toContain('maxAttempts');
		expect(challenge).toMatch(/emailOtpDigest\s+String\?/u);
		expect(challenge).toMatch(/emailOtpExpiresAt\s+DateTime\?/u);
		expect(challenge).toMatch(/emailOtpSendCount\s+Int\s+@default\(0\)/u);
		expect(schema).not.toMatch(/^\s+(?:token|secret|recoveryCode)\s+/mu);
	});

	it('keeps owner sessions separate, opaque and membership or proof bound', async () => {
		const schemaUrl = new URL('../../prisma/schema.prisma', import.meta.url);
		const schema = await readFile(schemaUrl, 'utf8');
		const session = /model OwnerSession \{[\s\S]*?\n\}/u.exec(schema)?.[0];

		expect(session).toBeDefined();
		expect(session).toMatch(/userId\s+String\s+@map\("user_id"\)/u);
		expect(session).toMatch(/tokenDigest\s+String\s+@unique/u);
		expect(session).toMatch(/assurance\s+OwnerSessionAssurance/u);
		expect(session).toContain('authenticatedAt');
		expect(session).toContain('mfaVerifiedAt');
		expect(session).toContain('lastActivityAt');
		expect(session).toContain('idleExpiresAt');
		expect(session).toContain('absoluteExpiresAt');
		expect(session).toContain('revokedAt');
		expect(session).toContain('onDelete: Restrict, onUpdate: Restrict');
		expect(session).not.toContain('platformStaffId');
		expect(session).toContain('organizationId');
		expect(session).toContain('membershipId');
		expect(session).toContain('enrollmentChallengeId');
		expect(session).toContain('revocationReason');
		expect(session).not.toMatch(/^\s+token\s+/mu);
		expect(schema).toMatch(/ownerSessions\s+OwnerSession\[\]/u);
	});

	it('uses restrictive foreign keys for security-sensitive relationships', async () => {
		const schemaUrl = new URL('../../prisma/schema.prisma', import.meta.url);
		const schema = await readFile(schemaUrl, 'utf8');
		const restrictiveRelations = schema.match(/onDelete:\s*Restrict,\s*onUpdate:\s*Restrict/gu);

		expect(restrictiveRelations?.length).toBeGreaterThanOrEqual(10);
	});
});
