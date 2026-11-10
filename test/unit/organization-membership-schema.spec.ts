import { readFile } from 'node:fs/promises';

describe('organization membership schema contract', () => {
	async function schema(): Promise<string> {
		return readFile(new URL('../../prisma/schema.prisma', import.meta.url), 'utf8');
	}

	it('defines an explicit organization membership lifecycle for the global user identity', async () => {
		const source = await schema();
		const status = /enum OrganizationMembershipStatus \{[\s\S]*?\n\}/u.exec(source)?.[0];
		const membership = /model OrganizationMembership \{[\s\S]*?\n\}/u.exec(source)?.[0];

		expect(status).toBeDefined();
		for (const value of ['pending', 'active', 'suspended', 'revoked']) {
			expect(status).toContain(`@map("${value}")`);
		}
		expect(status).toContain('@@map("organization_membership_status")');
		expect(membership).toMatch(
			/id\s+String\s+@id\(map: "organization_memberships_pkey"\)[^\n]+@db\.Uuid/u,
		);
		expect(membership).toMatch(/status\s+OrganizationMembershipStatus\s+@default\(PENDING\)/u);
		expect(membership).toContain(
			'@@unique([organizationId, userId], map: "organization_memberships_organization_user_key")',
		);
		expect(membership).toContain(
			'@@unique([organizationId, id], map: "organization_memberships_organization_id_key")',
		);
		for (const field of ['createdAt', 'updatedAt', 'activatedAt', 'suspendedAt', 'revokedAt']) {
			expect(membership).toMatch(
				new RegExp(`${field}\\s+DateTime\\??[^\\n]+@db\\.Timestamptz\\(6\\)`, 'u'),
			);
		}
		expect(membership).not.toMatch(/email|password|displayName|platformStaff/iu);
	});

	it('keeps organization roles tenant-owned and reserves owner through reviewed SQL checks', async () => {
		const source = await schema();
		const role = /model OrganizationRole \{[\s\S]*?\n\}/u.exec(source)?.[0];

		expect(role).toMatch(/organizationId\s+String[^\n]+@db\.Uuid/u);
		expect(role).toMatch(/key\s+String\s+@db\.VarChar\(63\)/u);
		expect(role).toMatch(/name\s+String\s+@db\.Citext/u);
		expect(role).toMatch(/description\s+String\?\s+@db\.VarChar\(500\)/u);
		expect(role).toMatch(/isSystem\s+Boolean\s+@default\(false\)/u);
		expect(role).toContain(
			'@@unique([organizationId, key], map: "organization_roles_organization_key_key")',
		);
		expect(role).toContain(
			'@@unique([organizationId, id], map: "organization_roles_organization_id_key")',
		);
		expect(role).not.toMatch(/PlatformRole|PlatformPermission/u);
	});

	it('enforces same-organization assignments through two composite relations', async () => {
		const source = await schema();
		const assignment = /model OrganizationMembershipRole \{[\s\S]*?\n\}/u.exec(source)?.[0];

		expect(assignment).toContain(
			'@@id([organizationId, organizationMembershipId, organizationRoleId]',
		);
		expect(assignment).toMatch(
			/@relation\(fields: \[organizationId, organizationMembershipId\],[^\n]+references: \[organizationId, id\],[^\n]+onDelete: Restrict,[^\n]+onUpdate: Restrict/u,
		);
		expect(assignment).toMatch(
			/@relation\(fields: \[organizationId, organizationRoleId\],[^\n]+references: \[organizationId, id\],[^\n]+onDelete: Restrict,[^\n]+onUpdate: Restrict/u,
		);
		expect(assignment).toContain(
			'@@index([organizationId, organizationRoleId, organizationMembershipId]',
		);
		expect(assignment).not.toMatch(/onDelete: Cascade|onUpdate: Cascade/u);
	});

	it('adds only relationship collections to existing identity and organization roots', async () => {
		const source = await schema();
		const organization = /model Organization \{[\s\S]*?\n\}/u.exec(source)?.[0];
		const user = /model User \{[\s\S]*?\n\}/u.exec(source)?.[0];

		expect(organization).toMatch(/memberships\s+OrganizationMembership\[\]/u);
		expect(organization).toMatch(/roles\s+OrganizationRole\[\]/u);
		expect(user).toMatch(/organizationMemberships\s+OrganizationMembership\[\]/u);
		expect(user).not.toMatch(/organizationId|organizationRole/u);
	});
});
