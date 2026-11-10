import { randomUUID } from 'node:crypto';

import type { PrismaService } from '../../src/database/prisma.service.js';
import {
	assertDevelopmentDatabaseWasVerified,
	type VerifiedDevelopmentDatabase,
} from './development-database-safety.js';

const TRANSACTION_OPTIONS = { maxWait: 30_000, timeout: 60_000 } as const;

/** Tracks only identifiers reserved by one test and deletes children before their parents. */
export class OrganizationMembershipTestFixtures {
	readonly #membershipIds = new Set<string>();
	readonly #roleIds = new Set<string>();

	reserveMembershipId(verifiedDatabase: VerifiedDevelopmentDatabase): string {
		assertDevelopmentDatabaseWasVerified(verifiedDatabase);
		const id = randomUUID();
		this.#membershipIds.add(id);
		return id;
	}

	reserveRoleId(verifiedDatabase: VerifiedDevelopmentDatabase): string {
		assertDevelopmentDatabaseWasVerified(verifiedDatabase);
		const id = randomUUID();
		this.#roleIds.add(id);
		return id;
	}

	async cleanup(
		prisma: PrismaService,
		verifiedDatabase: VerifiedDevelopmentDatabase,
	): Promise<void> {
		assertDevelopmentDatabaseWasVerified(verifiedDatabase);
		const membershipIds = [...this.#membershipIds];
		const roleIds = [...this.#roleIds];
		if (membershipIds.length === 0 && roleIds.length === 0) return;

		await prisma.$transaction(async (transaction) => {
			await transaction.organizationMembershipRole.deleteMany({
				where: {
					OR: [
						{ organizationMembershipId: { in: membershipIds } },
						{ organizationRoleId: { in: roleIds } },
					],
				},
			});
			if (roleIds.length > 0) {
				await transaction.organizationRole.deleteMany({ where: { id: { in: roleIds } } });
			}
			if (membershipIds.length > 0) {
				await transaction.organizationMembership.deleteMany({
					where: { id: { in: membershipIds } },
				});
			}
		}, TRANSACTION_OPTIONS);

		this.#membershipIds.clear();
		this.#roleIds.clear();
	}
}
