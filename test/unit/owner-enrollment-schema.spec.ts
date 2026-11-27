import { readFile } from 'node:fs/promises';

describe('owner enrollment and recipient acceptance schema', () => {
	async function model(name: string): Promise<string> {
		const schema = await readFile(new URL('../../prisma/schema.prisma', import.meta.url), 'utf8');
		const block = new RegExp(`model ${name} \\{[\\s\\S]*?\\n\\}`, 'u').exec(schema)?.[0];
		if (block === undefined) throw new Error(`Missing schema model: ${name}`);
		return block;
	}

	it('keeps enrollment separate from platform authentication and stores only erasable digests', async () => {
		const challenge = await model('OrganizationOwnerEnrollmentChallenge');
		expect(challenge).toMatch(/userId\s+String\?/u);
		expect(challenge).toMatch(/tokenDigest\s+String\?\s+@unique/u);
		expect(challenge).toMatch(/status\s+OrganizationOwnerEnrollmentStatus\s+@default\(PENDING\)/u);
		for (const timestamp of [
			'expiresAt',
			'mailboxVerifiedAt',
			'authenticatedAt',
			'stepUpVerifiedAt',
			'verifiedAt',
			'consumedAt',
			'revokedAt',
		]) {
			expect(challenge).toMatch(new RegExp(`${timestamp}\\s+DateTime\\??[^\\n]+Timestamptz`, 'u'));
		}
		expect(challenge).toMatch(/failedAttempts\s+Int\s+@default\(0\)/u);
		expect(challenge).toMatch(/maxAttempts\s+Int\s+@default\(5\)/u);
		const otpRelation = /^[ \t]*ownerEmailOtpChallenges[ \t]+OwnerEmailOtpChallenge\[\][ \t]*$/mu;
		expect(challenge).toMatch(otpRelation);
		const fields = challenge.replace(otpRelation, '');
		expect(fields).not.toMatch(/PlatformStaff|password|rawToken|otp|cookie|sessionId/iu);
		expect(challenge).toContain('@@index([expiresAt, id]');
	});

	it('binds audit membership and resolved challenge identity to the same recipient and organization', async () => {
		const audit = await model('OrganizationOwnerAcceptanceAuditEvent');
		expect(audit).toContain('fields: [organizationId, organizationMembershipId, actorUserId]');
		expect(audit).toContain('references: [organizationId, id, userId]');
		expect(audit).toContain(
			'fields: [organizationId, enrollmentChallengeId, ownerInvitationId, actorUserId]',
		);
		expect(audit).toContain('references: [organizationId, id, ownerInvitationId, userId]');
		expect(audit).toContain('fields: [organizationId, ownerInvitationId]');
		expect(audit).toContain('@@unique([organizationId, ownerInvitationId]');
		expect(audit).not.toMatch(/PlatformStaff|token|password|email|metadata\s+Json/iu);
		expect(audit.match(/onDelete: Restrict, onUpdate: Restrict/gu)).toHaveLength(5);
	});

	it('separates new enrollment from existing-user authentication without changing platform audits', async () => {
		const schema = await readFile(new URL('../../prisma/schema.prisma', import.meta.url), 'utf8');
		expect(schema).toContain('@map("new_user_enrollment")');
		expect(schema).toContain('@map("existing_user_authentication")');
		expect(schema).toContain('@map("owner_invitation_accepted")');
		const platformAudit = await model('OrganizationOwnershipAuditEvent');
		expect(platformAudit).toMatch(/actorPlatformStaffId\s+String/u);
		expect(platformAudit).not.toContain('actorUserId');
		const membership = await model('OrganizationMembership');
		expect(membership).toContain('@@unique([organizationId, id, userId]');
	});
});
