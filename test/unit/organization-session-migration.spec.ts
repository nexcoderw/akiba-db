import { readFile } from 'node:fs/promises';

describe('organization session binding migration', () => {
	it('ends legacy unbound credentials before requiring a tenant-bound session', async () => {
		const sql = await readFile(
			new URL(
				'../../prisma/migrations/20261111150000_bind_organization_sessions/migration.sql',
				import.meta.url,
			),
			'utf8',
		);
		const revoke = sql.indexOf('UPDATE public.owner_sessions');
		const constraint = sql.indexOf('ADD CONSTRAINT owner_sessions_binding_check');
		expect(revoke).toBeGreaterThan(0);
		expect(constraint).toBeGreaterThan(revoke);
		expect(sql).toContain("revocation_reason = 'tenant_binding_upgrade'");
		expect(sql).toContain('FOREIGN KEY (organization_id, membership_id, user_id)');
		expect(sql).toContain('FOREIGN KEY (organization_id, enrollment_challenge_id, user_id)');
		expect(sql).toContain('NEW.membership_id IS DISTINCT FROM OLD.membership_id');
		expect(sql).toContain(
			'NEW.enrollment_challenge_id IS DISTINCT FROM OLD.enrollment_challenge_id',
		);
	});
});
