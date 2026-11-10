import { readFile } from 'node:fs/promises';

const migrationUrl = new URL(
	'../../prisma/migrations/20261015105926_harden_organization_owner_invitations/migration.sql',
	import.meta.url,
);

describe('organization owner invitation hardening migration', () => {
	async function migration(): Promise<string> {
		return readFile(migrationUrl, 'utf8');
	}

	it('commits every reviewed invitation and audit integrity object', async () => {
		const source = await migration();

		expect(source).toMatch(/^BEGIN;/u);
		expect(source).toMatch(/COMMIT;\s*$/u);
		expect(source).toContain("SET LOCAL lock_timeout = '10s'");
		expect(source).toContain("SET LOCAL statement_timeout = '60s'");
		for (const name of [
			'organization_owner_invitations_email_check',
			'organization_owner_invitations_display_name_nonblank_check',
			'organization_owner_invitations_lifecycle_check',
			'organization_owner_invitations_timestamp_order_check',
			'organization_ownership_audit_events_request_check',
			'organization_ownership_audit_events_metadata_check',
			'organization_owner_invitations_outstanding_email_key',
			'organization_ownership_audit_events_org_action_time_idx',
			'organization_owner_invitation_identity_guard',
			'organization_ownership_audit_stamp',
		]) {
			expect(source).toContain(name);
		}
	});

	it('keeps recipient identity immutable and audit persistence database-controlled', async () => {
		const source = await migration();

		expect(source).toMatch(/NEW\.organization_id IS DISTINCT FROM OLD\.organization_id/u);
		expect(source).toMatch(/NEW\.invited_email IS DISTINCT FROM OLD\.invited_email/u);
		expect(source).toMatch(
			/NEW\.invited_by_platform_staff_id IS DISTINCT FROM OLD\.invited_by_platform_staff_id/u,
		);
		expect(source).toContain('NEW.recorded_at := clock_timestamp()');
		expect(source).toContain("WHERE status IN ('pending_delivery', 'sent')");
	});

	it('removes implicit PUBLIC access without embedding environment role grants', async () => {
		const source = await migration();

		expect(source).toMatch(
			/REVOKE ALL ON TABLE[\s\S]+organization_owner_invitations[\s\S]+organization_ownership_audit_events[\s\S]+FROM PUBLIC/u,
		);
		expect(source).toMatch(
			/REVOKE ALL ON TYPE[\s\S]+organization_owner_invitation_status[\s\S]+organization_ownership_audit_action[\s\S]+FROM PUBLIC/u,
		);
		expect(source).not.toMatch(/\bGRANT\b/u);
		expect(source).not.toMatch(/\bakiba_(?:app|test)\b/u);
	});
});
