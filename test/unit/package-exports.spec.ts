import * as databasePackage from '../../src/index.js';

describe('public package exports', () => {
	it('exposes only the supported database API', () => {
		expect(typeof databasePackage.DatabaseModule).toBe('function');
		expect(typeof databasePackage.PrismaClient).toBe('function');
		expect(typeof databasePackage.PrismaService).toBe('function');
		expect(typeof databasePackage.TenantTransactionService).toBe('function');
		expect(typeof databasePackage.loadDatabaseConfig).toBe('function');
		expect(databasePackage.OrganizationStatus).toEqual({
			PENDING: 'PENDING',
			ACTIVE: 'ACTIVE',
			SUSPENDED: 'SUSPENDED',
			ARCHIVED: 'ARCHIVED',
		});
		expect(databasePackage.OrganizationMembershipStatus).toEqual({
			PENDING: 'PENDING',
			ACTIVE: 'ACTIVE',
			SUSPENDED: 'SUSPENDED',
			REVOKED: 'REVOKED',
		});
		expect(databasePackage.OrganizationOwnerInvitationStatus).toEqual({
			PENDING_DELIVERY: 'PENDING_DELIVERY',
			SENT: 'SENT',
			ACCEPTED: 'ACCEPTED',
			REVOKED: 'REVOKED',
		});
		expect(databasePackage.OrganizationOwnershipAuditAction).toEqual({
			INVITATION_CREATED: 'INVITATION_CREATED',
			INVITATION_REVOKED: 'INVITATION_REVOKED',
			INVITATION_DELIVERY_QUEUED: 'INVITATION_DELIVERY_QUEUED',
		});
		expect(databasePackage.OrganizationAuditAction).toEqual({
			CREATE: 'CREATE',
			UPDATE: 'UPDATE',
			ACTIVATE: 'ACTIVATE',
			SUSPEND: 'SUSPEND',
			ARCHIVE: 'ARCHIVE',
		});
		expect(databasePackage.PlatformAuthorizationAuditAction).toEqual({
			PROVISION_ORGANIZATION_MANAGER: 'PROVISION_ORGANIZATION_MANAGER',
		});
		expect(databasePackage.PlatformAuthorizationAuditOutcome).toEqual({
			GRANTED: 'GRANTED',
			ALREADY_GRANTED: 'ALREADY_GRANTED',
		});
	});

	it('exports only the retained foundation model names through Prisma', () => {
		expect(Object.keys(databasePackage.Prisma.ModelName).sort()).toEqual(
			[
				'IdentitySecurityAuditEvent',
				'Organization',
				'User',
				'UserEmailVerificationChallenge',
				'OrganizationMembership',
				'OrganizationRole',
				'OrganizationMembershipRole',
				'OrganizationOwnerInvitation',
				'OrganizationOwnerEnrollmentChallenge',
				'OrganizationOwnerAcceptanceAuditEvent',
				'OrganizationOwnerInvitationDelivery',
				'OrganizationOwnershipAuditEvent',
				'PasswordCredential',
				'PlatformStaff',
				'PlatformAdminSession',
				'OwnerSession',
				'PlatformTotpCredential',
				'PlatformRecoveryCode',
				'PlatformMfaChallenge',
				'PlatformRole',
				'PlatformPermission',
				'PlatformStaffRole',
				'PlatformRolePermission',
				'OrganizationAuditEvent',
				'PlatformAuthorizationAuditEvent',
			].sort(),
		);
	});
});
