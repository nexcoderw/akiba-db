import { readFile } from 'node:fs/promises';

import { jest } from '@jest/globals';
import { Test, type TestingModule } from '@nestjs/testing';

import { DatabaseModule } from '../../src/database/database.module.js';
import { PrismaService } from '../../src/database/prisma.service.js';
import { TenantTransactionService } from '../../src/database/tenant-transaction.service.js';
import type { Prisma } from '../../src/generated/prisma/client.js';
import {
	loadDevelopmentDatabaseConfig,
	verifyDevelopmentDatabaseSafety,
} from './development-database-safety.js';

interface TenantSettings {
	readonly organizationId: string | null;
	readonly branchId: string | null;
}

const ORGANIZATION_A_ID = '11111111-1111-4111-8111-111111111111';
const ORGANIZATION_B_ID = '22222222-2222-4222-8222-222222222222';
const BRANCH_A_ID = '33333333-3333-4333-8333-333333333333';
const BRANCH_B_ID = '44444444-4444-4444-8444-444444444444';
const POOL_SIZE = 2;
const TRANSACTION_MAX_WAIT_MILLISECONDS = 10_000;
const TRANSACTION_TIMEOUT_MILLISECONDS = 15_000;

jest.setTimeout(30_000);

function createRendezvous(participantCount: number): () => Promise<void> {
	let arrivals = 0;
	let release: (() => void) | undefined;
	const allArrived = new Promise<void>((resolve) => {
		release = resolve;
	});

	return async () => {
		arrivals += 1;
		if (arrivals === participantCount) {
			release?.();
		}
		await allArrived;
	};
}

async function readTenantSettings(transaction: Prisma.TransactionClient): Promise<TenantSettings> {
	const rows = await transaction.$queryRaw<
		{ organization_id: string | null; branch_id: string | null }[]
	>`
		SELECT
			NULLIF(current_setting('app.current_organization_id', true), '') AS organization_id,
			NULLIF(current_setting('app.current_branch_id', true), '') AS branch_id
	`;
	const row = rows[0];
	if (row === undefined) {
		throw new Error('PostgreSQL did not return tenant settings.');
	}

	return { organizationId: row.organization_id, branchId: row.branch_id };
}

async function readEveryPooledConnection(prisma: PrismaService): Promise<TenantSettings[]> {
	const rendezvous = createRendezvous(POOL_SIZE);
	const readConnection = (): Promise<TenantSettings> =>
		prisma.$transaction(
			async (transaction) => {
				await rendezvous();
				return readTenantSettings(transaction);
			},
			{
				maxWait: TRANSACTION_MAX_WAIT_MILLISECONDS,
				timeout: TRANSACTION_TIMEOUT_MILLISECONDS,
			},
		);

	return Promise.all([readConnection(), readConnection()]);
}

const developmentDatabase = loadDevelopmentDatabaseConfig();

describe('database integration', () => {
	let module: TestingModule;
	let prisma: PrismaService;
	let tenantTransactions: TenantTransactionService;

	beforeAll(async () => {
		module = await Test.createTestingModule({
			imports: [
				DatabaseModule.forRoot({
					databaseUrl: developmentDatabase.databaseUrl,
					poolMax: POOL_SIZE,
					connectionTimeoutMilliseconds: 5_000,
				}),
			],
		}).compile();
		await module.init();
		prisma = module.get(PrismaService);
		await verifyDevelopmentDatabaseSafety(prisma, developmentDatabase);
		tenantTransactions = module.get(TenantTransactionService);
	});

	afterAll(async () => {
		await module.close();
	});

	it('connects to the approved development PostgreSQL database', async () => {
		await expect(prisma.$queryRaw`SELECT 1`).resolves.toEqual([{ '?column?': 1 }]);
	});

	it('replays migrations to exactly the retained foundation tables', async () => {
		const schema = await readFile(new URL('../../prisma/schema.prisma', import.meta.url), 'utf8');
		const expectedTables = [...schema.matchAll(/^model \w+ \{([\s\S]*?)^\}/gmu)].map((match) => {
			const table = /@@map\("([^"]+)"\)/u.exec(match[1] ?? '')?.[1];
			if (table === undefined) throw new Error('Every foundation model must map its table name.');
			return table;
		});
		const tables = await prisma.$queryRaw<{ table_name: string }[]>`
			SELECT table_name FROM information_schema.tables
			WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
				AND table_name <> '_prisma_migrations'
			ORDER BY table_name
		`;
		expect(expectedTables).toHaveLength(23);
		expect(tables.map(({ table_name }) => table_name)).toEqual(expectedTables.sort());
	});

	it('makes organization context available inside its transaction', async () => {
		await expect(
			tenantTransactions.run({ organizationId: ORGANIZATION_A_ID }, readTenantSettings),
		).resolves.toEqual({ organizationId: ORGANIZATION_A_ID, branchId: null });
	});

	it('makes branch context available inside its transaction', async () => {
		await expect(
			tenantTransactions.run(
				{ organizationId: ORGANIZATION_A_ID, branchId: BRANCH_A_ID },
				readTenantSettings,
			),
		).resolves.toEqual({ organizationId: ORGANIZATION_A_ID, branchId: BRANCH_A_ID });
	});

	it('clears tenant context from pooled connections after successful completion', async () => {
		await tenantTransactions.run({ organizationId: ORGANIZATION_A_ID, branchId: BRANCH_A_ID }, () =>
			Promise.resolve(undefined),
		);

		await expect(readEveryPooledConnection(prisma)).resolves.toEqual([
			{ organizationId: null, branchId: null },
			{ organizationId: null, branchId: null },
		]);
	});

	it('clears tenant context from pooled connections after rollback', async () => {
		const rollbackError = new Error('intentional integration-test rollback');

		await expect(
			tenantTransactions.run(
				{ organizationId: ORGANIZATION_A_ID, branchId: BRANCH_A_ID },
				async (transaction) => {
					await expect(readTenantSettings(transaction)).resolves.toEqual({
						organizationId: ORGANIZATION_A_ID,
						branchId: BRANCH_A_ID,
					});
					throw rollbackError;
				},
			),
		).rejects.toBe(rollbackError);
		await expect(readEveryPooledConnection(prisma)).resolves.toEqual([
			{ organizationId: null, branchId: null },
			{ organizationId: null, branchId: null },
		]);
	});

	it('replaces a previous organization context in a later transaction', async () => {
		await tenantTransactions.run({ organizationId: ORGANIZATION_A_ID }, readTenantSettings);

		await expect(
			tenantTransactions.run({ organizationId: ORGANIZATION_B_ID }, readTenantSettings),
		).resolves.toEqual({ organizationId: ORGANIZATION_B_ID, branchId: null });
	});

	it('keeps simultaneous tenant transactions isolated', async () => {
		const rendezvous = createRendezvous(POOL_SIZE);
		const runTenant = (organizationId: string, branchId: string): Promise<TenantSettings> =>
			tenantTransactions.run({ organizationId, branchId }, async (transaction) => {
				await rendezvous();
				return readTenantSettings(transaction);
			});

		await expect(
			Promise.all([
				runTenant(ORGANIZATION_A_ID, BRANCH_A_ID),
				runTenant(ORGANIZATION_B_ID, BRANCH_B_ID),
			]),
		).resolves.toEqual([
			{ organizationId: ORGANIZATION_A_ID, branchId: BRANCH_A_ID },
			{ organizationId: ORGANIZATION_B_ID, branchId: BRANCH_B_ID },
		]);
	});
	it('rejects a nested tenant scope and clears the rolled back outer context', async () => {
		await expect(tenantTransactions.run({ organizationId: ORGANIZATION_A_ID }, () =>
			tenantTransactions.run({ organizationId: ORGANIZATION_B_ID }, readTenantSettings),
		)).rejects.toThrow('Nested tenant transactions');
		await expect(readEveryPooledConnection(prisma)).resolves.toEqual([
			{ organizationId: null, branchId: null },
			{ organizationId: null, branchId: null },
		]);
		await expect(tenantTransactions.run({ organizationId: ORGANIZATION_B_ID }, readTenantSettings))
			.resolves.toEqual({ organizationId: ORGANIZATION_B_ID, branchId: null });
	});

});
