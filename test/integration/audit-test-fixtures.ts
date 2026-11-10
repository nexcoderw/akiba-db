import { randomUUID } from 'node:crypto';

import type { PrismaService } from '../../src/database/prisma.service.js';
import {
	assertDevelopmentDatabaseWasVerified,
	type VerifiedDevelopmentDatabase,
} from './development-database-safety.js';

interface OrganizationAuditFixture {
	readonly id: string;
	readonly organizationId: string;
	readonly actorPlatformStaffId: string;
}

interface AuthorizationAuditFixture {
	readonly id: string;
	readonly targetPlatformStaffId: string;
	readonly targetPlatformRoleId: string;
	readonly correlationId: string;
}

const CLEANUP_TRANSACTION_OPTIONS = { maxWait: 15_000, timeout: 20_000 } as const;
const CLEANUP_TRANSACTION_ATTEMPTS = 3;

function isTransactionStartTimeout(error: unknown): boolean {
	if (typeof error !== 'object' || error === null) return false;
	const candidate = error as { readonly code?: unknown; readonly message?: unknown };
	return (
		candidate.code === 'P2028' &&
		typeof candidate.message === 'string' &&
		candidate.message.includes('Unable to start a transaction in the given time')
	);
}

async function waitBeforeRetry(attempt: number): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, attempt * 250));
}

/** Cleanup targets only reserved synthetic audit records in the verified development maintenance window. */
export class AuditTestFixtures {
	readonly #organizationEvents: OrganizationAuditFixture[] = [];
	readonly #authorizationEvents: AuthorizationAuditFixture[] = [];

	reserveOrganizationEvent(
		verified: VerifiedDevelopmentDatabase,
		organizationId: string,
		actorPlatformStaffId: string,
	): OrganizationAuditFixture {
		assertDevelopmentDatabaseWasVerified(verified);
		const fixture = { id: randomUUID(), organizationId, actorPlatformStaffId };
		this.#organizationEvents.push(fixture);
		return fixture;
	}

	reserveAuthorizationEvent(
		verified: VerifiedDevelopmentDatabase,
		targetPlatformStaffId: string,
		targetPlatformRoleId: string,
	): AuthorizationAuditFixture {
		assertDevelopmentDatabaseWasVerified(verified);
		const fixture = {
			id: randomUUID(),
			targetPlatformStaffId,
			targetPlatformRoleId,
			correlationId: randomUUID(),
		};
		this.#authorizationEvents.push(fixture);
		return fixture;
	}

	async cleanup(prisma: PrismaService, verified: VerifiedDevelopmentDatabase): Promise<void> {
		assertDevelopmentDatabaseWasVerified(verified);
		for (let attempt = 1; attempt <= CLEANUP_TRANSACTION_ATTEMPTS; attempt += 1) {
			try {
				await prisma.$transaction(async (transaction) => {
					if (this.#organizationEvents.length > 0) {
						await transaction.organizationAuditEvent.deleteMany({
							where: { OR: this.#organizationEvents.map((fixture) => ({ ...fixture })) },
						});
					}
					if (this.#authorizationEvents.length > 0) {
						await transaction.platformAuthorizationAuditEvent.deleteMany({
							where: { OR: this.#authorizationEvents.map((fixture) => ({ ...fixture })) },
						});
					}
				}, CLEANUP_TRANSACTION_OPTIONS);
				break;
			} catch (error) {
				if (attempt === CLEANUP_TRANSACTION_ATTEMPTS || !isTransactionStartTimeout(error)) {
					throw error;
				}
				await waitBeforeRetry(attempt);
			}
		}
		this.#organizationEvents.length = 0;
		this.#authorizationEvents.length = 0;
	}
}
