import { readFile } from 'node:fs/promises';

const schema = () => readFile(new URL('../../prisma/schema.prisma', import.meta.url), 'utf8');
const migration = () =>
	readFile(
		new URL(
			'../../prisma/migrations/20261111123000_organization_authorization_foundation/migration.sql',
			import.meta.url,
		),
		'utf8',
	);

describe('organization authorization persistence contract', () => {
	it('keeps organization role grants scoped by composite tenant key', async () => {
		const source = await schema();
		const rolePermission = /model OrganizationRolePermission \{[\s\S]*?\n\}/u.exec(source)?.[0];
		expect(rolePermission).toContain(
			'@@id([organizationId, organizationRoleId, organizationPermissionId]',
		);
		expect(rolePermission).toMatch(
			/@relation\(fields: \[organizationId, organizationRoleId\], references: \[organizationId, id\], onDelete: Restrict/u,
		);
		expect(rolePermission).not.toContain('PlatformPermission');
		const sql = await migration();
		expect(sql).toMatch(
			/FOREIGN KEY\s*\(organization_id, organization_role_id\) REFERENCES public\.organization_roles\(organization_id, id\)/u,
		);
		expect(sql).toMatch(
			/CREATE UNIQUE INDEX organization_roles_organization_name_key\s+ON public\.organization_roles\(organization_id, name\)/u,
		);
	});

	it('constrains and audits membership/role mutations without storing credentials', async () => {
		const source = await schema();
		const audit = /model OrganizationAuthorizationAuditEvent \{[\s\S]*?\n\}/u.exec(source)?.[0];
		expect(audit).toMatch(/references: \[organizationId, id, userId\], onDelete: Restrict/u);
		expect(audit).toMatch(/targetMembership\s+OrganizationMembership\?\s+@relation/u);
		expect(audit).not.toMatch(/token|password|email|secret/iu);
		const sql = await migration();
		expect(sql).toContain('organization_authorization_audit_immutable');
		expect(sql).toContain('organization_authorization_audit_no_truncate');
		expect(sql).toContain('organization_roles_system_identity_check');
		expect(sql).toContain('authorization_version > 0');
	});
});
