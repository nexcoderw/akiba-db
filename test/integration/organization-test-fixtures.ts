import { randomUUID } from 'node:crypto';

import type { PrismaService } from '../../src/database/prisma.service.js';
import {
	assertDevelopmentDatabaseWasVerified,
	type VerifiedDevelopmentDatabase,
} from './development-database-safety.js';

export interface OrganizationFixture {
	readonly id: string;
	readonly slug: string;
}

/** Reserves identifiers before writes so cleanup can handle partially completed tests. */
export class OrganizationTestFixtures {
	readonly #records: OrganizationFixture[] = [];

	reserve(verifiedDatabase: VerifiedDevelopmentDatabase, slug?: string): OrganizationFixture {
		assertDevelopmentDatabaseWasVerified(verifiedDatabase);
		const id = randomUUID();
		const record = { id, slug: slug ?? `org-${id}` };
		return this.track(verifiedDatabase, record);
	}

	/** Also tracks Prisma-generated UUIDs before the surrounding transaction can commit. */
	track(
		verifiedDatabase: VerifiedDevelopmentDatabase,
		record: OrganizationFixture,
	): OrganizationFixture {
		assertDevelopmentDatabaseWasVerified(verifiedDatabase);
		this.#records.push(record);
		return record;
	}

	async cleanup(
		prisma: PrismaService,
		verifiedDatabase: VerifiedDevelopmentDatabase,
	): Promise<void> {
		assertDevelopmentDatabaseWasVerified(verifiedDatabase);
		if (this.#records.length === 0) return;
		// Match both reserved values, never a run prefix or the whole organization table.
		await prisma.organization.deleteMany({
			where: { OR: this.#records.map(({ id, slug }) => ({ id, slug })) },
		});
		this.#records.length = 0;
	}
}
