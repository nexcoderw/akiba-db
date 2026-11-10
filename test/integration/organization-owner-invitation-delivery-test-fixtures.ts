import { randomUUID } from 'node:crypto';

import type { PrismaService } from '../../src/database/prisma.service.js';
import {
	assertDevelopmentDatabaseWasVerified,
	type VerifiedDevelopmentDatabase,
} from './development-database-safety.js';

const transactionOptions = { maxWait: 10_000, timeout: 20_000 } as const;

/** Tracks only delivery identifiers reserved by one test and deletes those rows explicitly. */
export class OrganizationOwnerInvitationDeliveryTestFixtures {
	readonly #deliveryIds = new Set<string>();

	reserveDeliveryId(verifiedDatabase: VerifiedDevelopmentDatabase): string {
		assertDevelopmentDatabaseWasVerified(verifiedDatabase);
		const id = randomUUID();
		this.#deliveryIds.add(id);
		return id;
	}

	async cleanup(
		prisma: PrismaService,
		verifiedDatabase: VerifiedDevelopmentDatabase,
	): Promise<void> {
		assertDevelopmentDatabaseWasVerified(verifiedDatabase);
		const deliveryIds = [...this.#deliveryIds];
		if (deliveryIds.length === 0) return;

		await prisma.$transaction(async (transaction) => {
			await transaction.organizationOwnerInvitationDelivery.deleteMany({
				where: { id: { in: deliveryIds } },
			});
		}, transactionOptions);

		this.#deliveryIds.clear();
	}
}
