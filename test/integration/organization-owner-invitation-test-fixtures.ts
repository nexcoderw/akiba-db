import { randomUUID } from 'node:crypto';

import type { PrismaService } from '../../src/database/prisma.service.js';
import {
	assertDevelopmentDatabaseWasVerified,
	type VerifiedDevelopmentDatabase,
} from './development-database-safety.js';

const TRANSACTION_OPTIONS = { maxWait: 30_000, timeout: 60_000 } as const;

/** Tracks only invitation/audit identifiers reserved by one test and deletes children first. */
export class OrganizationOwnerInvitationTestFixtures {
	readonly #invitationIds = new Set<string>();
	readonly #auditEventIds = new Set<string>();

	reserveInvitationId(verifiedDatabase: VerifiedDevelopmentDatabase): string {
		assertDevelopmentDatabaseWasVerified(verifiedDatabase);
		const id = randomUUID();
		this.#invitationIds.add(id);
		return id;
	}

	reserveAuditEventId(verifiedDatabase: VerifiedDevelopmentDatabase): string {
		assertDevelopmentDatabaseWasVerified(verifiedDatabase);
		const id = randomUUID();
		this.#auditEventIds.add(id);
		return id;
	}

	async cleanup(
		prisma: PrismaService,
		verifiedDatabase: VerifiedDevelopmentDatabase,
	): Promise<void> {
		assertDevelopmentDatabaseWasVerified(verifiedDatabase);
		const invitationIds = [...this.#invitationIds];
		const auditEventIds = [...this.#auditEventIds];
		if (invitationIds.length === 0 && auditEventIds.length === 0) return;

		await prisma.$transaction(async (transaction) => {
			if (auditEventIds.length > 0 || invitationIds.length > 0) {
				await transaction.organizationOwnershipAuditEvent.deleteMany({
					where: {
						OR: [{ id: { in: auditEventIds } }, { ownerInvitationId: { in: invitationIds } }],
					},
				});
			}
			if (invitationIds.length > 0) {
				await transaction.organizationOwnerInvitation.deleteMany({
					where: { id: { in: invitationIds } },
				});
			}
		}, TRANSACTION_OPTIONS);

		this.#auditEventIds.clear();
		this.#invitationIds.clear();
	}
}
