import { randomUUID } from 'node:crypto';

import type { PrismaService } from '../../src/database/prisma.service.js';
import {
	assertDevelopmentDatabaseWasVerified,
	type VerifiedDevelopmentDatabase,
} from './development-database-safety.js';

const TRANSACTION_MAX_WAIT_MILLISECONDS = 30_000;
const TRANSACTION_TIMEOUT_MILLISECONDS = 60_000;

export class PlatformAdminTestFixtures {
	readonly #userIds = new Set<string>();
	readonly #passwordCredentialIds = new Set<string>();
	readonly #platformStaffIds = new Set<string>();
	readonly #platformAdminSessionIds = new Set<string>();
	readonly #platformTotpCredentialIds = new Set<string>();
	readonly #platformRecoveryCodeIds = new Set<string>();
	readonly #platformMfaChallengeIds = new Set<string>();
	readonly #platformRoleIds = new Set<string>();
	readonly #platformPermissionIds = new Set<string>();

	reserveUserId(): string {
		return this.reserve(this.#userIds);
	}

	reservePasswordCredentialId(): string {
		return this.reserve(this.#passwordCredentialIds);
	}

	reservePlatformStaffId(): string {
		return this.reserve(this.#platformStaffIds);
	}

	reservePlatformAdminSessionId(): string {
		return this.reserve(this.#platformAdminSessionIds);
	}

	reservePlatformTotpCredentialId(): string {
		return this.reserve(this.#platformTotpCredentialIds);
	}

	reservePlatformRecoveryCodeId(): string {
		return this.reserve(this.#platformRecoveryCodeIds);
	}

	reservePlatformMfaChallengeId(): string {
		return this.reserve(this.#platformMfaChallengeIds);
	}

	reservePlatformRoleId(): string {
		return this.reserve(this.#platformRoleIds);
	}

	reservePlatformPermissionId(): string {
		return this.reserve(this.#platformPermissionIds);
	}

	async cleanup(
		prisma: PrismaService,
		verifiedDatabase: VerifiedDevelopmentDatabase,
	): Promise<void> {
		assertDevelopmentDatabaseWasVerified(verifiedDatabase);

		const userIds = [...this.#userIds];
		const passwordCredentialIds = [...this.#passwordCredentialIds];
		const platformStaffIds = [...this.#platformStaffIds];
		const platformAdminSessionIds = [...this.#platformAdminSessionIds];
		const platformTotpCredentialIds = [...this.#platformTotpCredentialIds];
		const platformRecoveryCodeIds = [...this.#platformRecoveryCodeIds];
		const platformMfaChallengeIds = [...this.#platformMfaChallengeIds];
		const platformRoleIds = [...this.#platformRoleIds];
		const platformPermissionIds = [...this.#platformPermissionIds];

		if (
			userIds.length === 0 &&
			passwordCredentialIds.length === 0 &&
			platformStaffIds.length === 0 &&
			platformAdminSessionIds.length === 0 &&
			platformTotpCredentialIds.length === 0 &&
			platformRecoveryCodeIds.length === 0 &&
			platformMfaChallengeIds.length === 0 &&
			platformRoleIds.length === 0 &&
			platformPermissionIds.length === 0
		) {
			return;
		}

		await prisma.$transaction(
			async (transaction) => {
				if (platformAdminSessionIds.length > 0 || platformStaffIds.length > 0) {
					await transaction.platformAdminSession.deleteMany({
						where: {
							OR: [
								{ id: { in: platformAdminSessionIds } },
								{ platformStaffId: { in: platformStaffIds } },
							],
						},
					});
				}
				if (platformTotpCredentialIds.length > 0 || platformStaffIds.length > 0) {
					await transaction.platformTotpCredential.deleteMany({
						where: {
							OR: [
								{ id: { in: platformTotpCredentialIds } },
								{ platformStaffId: { in: platformStaffIds } },
							],
						},
					});
				}
				if (platformRecoveryCodeIds.length > 0 || platformStaffIds.length > 0) {
					await transaction.platformRecoveryCode.deleteMany({
						where: {
							OR: [
								{ id: { in: platformRecoveryCodeIds } },
								{ platformStaffId: { in: platformStaffIds } },
							],
						},
					});
				}
				if (platformMfaChallengeIds.length > 0 || platformStaffIds.length > 0) {
					await transaction.platformMfaChallenge.deleteMany({
						where: {
							OR: [
								{ id: { in: platformMfaChallengeIds } },
								{ platformStaffId: { in: platformStaffIds } },
							],
						},
					});
				}
				if (platformStaffIds.length > 0) {
					await transaction.platformStaffRole.deleteMany({
						where: { platformStaffId: { in: platformStaffIds } },
					});
				}
				if (platformRoleIds.length > 0) {
					await transaction.platformStaffRole.deleteMany({
						where: { platformRoleId: { in: platformRoleIds } },
					});
					await transaction.platformRolePermission.deleteMany({
						where: { platformRoleId: { in: platformRoleIds } },
					});
				}
				if (platformPermissionIds.length > 0) {
					await transaction.platformRolePermission.deleteMany({
						where: { platformPermissionId: { in: platformPermissionIds } },
					});
				}
				if (passwordCredentialIds.length > 0 || userIds.length > 0) {
					await transaction.passwordCredential.deleteMany({
						where: {
							OR: [{ id: { in: passwordCredentialIds } }, { userId: { in: userIds } }],
						},
					});
				}
				if (platformStaffIds.length > 0 || userIds.length > 0) {
					await transaction.platformStaff.deleteMany({
						where: {
							OR: [{ id: { in: platformStaffIds } }, { userId: { in: userIds } }],
						},
					});
				}
				if (platformRoleIds.length > 0) {
					await transaction.platformRole.deleteMany({
						where: { id: { in: platformRoleIds } },
					});
				}
				if (platformPermissionIds.length > 0) {
					await transaction.platformPermission.deleteMany({
						where: { id: { in: platformPermissionIds } },
					});
				}
				if (userIds.length > 0) {
					await transaction.user.deleteMany({ where: { id: { in: userIds } } });
				}
			},
			{
				maxWait: TRANSACTION_MAX_WAIT_MILLISECONDS,
				timeout: TRANSACTION_TIMEOUT_MILLISECONDS,
			},
		);

		this.#userIds.clear();
		this.#passwordCredentialIds.clear();
		this.#platformStaffIds.clear();
		this.#platformAdminSessionIds.clear();
		this.#platformTotpCredentialIds.clear();
		this.#platformRecoveryCodeIds.clear();
		this.#platformMfaChallengeIds.clear();
		this.#platformRoleIds.clear();
		this.#platformPermissionIds.clear();
	}

	private reserve(collection: Set<string>): string {
		const id = randomUUID();
		collection.add(id);
		return id;
	}
}
