import { jest } from '@jest/globals';
import { Test } from '@nestjs/testing';

import { PrismaService } from '../../src/database/prisma.service.js';
import { TenantTransactionService } from '../../src/database/tenant-transaction.service.js';

type RawQuery = (query: TemplateStringsArray, ...values: unknown[]) => Promise<unknown>;

async function createSubject(
	queryRaw: jest.Mock<RawQuery> = jest.fn<RawQuery>().mockResolvedValue([]),
) {
	const operationClient = { $queryRaw: queryRaw };
	const transaction = jest.fn(
		(
			callback: (client: typeof operationClient) => unknown,
			options?: Readonly<{ maxWait: number; timeout: number }>,
		) => {
			if ((options?.timeout ?? 0) < 0) {
				throw new Error('Transaction timeout cannot be negative.');
			}
			return Promise.resolve(callback(operationClient));
		},
	);
	const module = await Test.createTestingModule({
		providers: [
			TenantTransactionService,
			{ provide: PrismaService, useValue: { $transaction: transaction } },
		],
	}).compile();

	return {
		operationClient,
		queryRaw,
		service: module.get(TenantTransactionService),
		transaction,
	};
}

describe('TenantTransactionService', () => {
	it('rejects an invalid organization identifier before opening a transaction', async () => {
		const { service, transaction } = await createSubject();

		await expect(
			service.run({ organizationId: 'not-a-uuid' }, () => Promise.resolve(undefined)),
		).rejects.toThrow('organizationId must be a valid UUID.');
		expect(transaction).not.toHaveBeenCalled();
	});

	it('rejects an invalid branch identifier before opening a transaction', async () => {
		const { service, transaction } = await createSubject();

		await expect(
			service.run(
				{
					organizationId: '11111111-1111-4111-8111-111111111111',
					branchId: 'not-a-uuid',
				},
				() => Promise.resolve(undefined),
			),
		).rejects.toThrow('branchId must be a valid UUID.');
		expect(transaction).not.toHaveBeenCalled();
	});

	it('sets a valid organization and an empty branch before invoking the operation', async () => {
		const events: string[] = [];
		const queryRaw = jest.fn<RawQuery>((_query, value) => {
			if (typeof value !== 'string') {
				throw new Error('Expected a parameterized tenant value.');
			}
			events.push(value);
			return Promise.resolve([]);
		});
		const { operationClient, service } = await createSubject(queryRaw);
		const operation = jest.fn(() => {
			events.push('operation');
			return Promise.resolve('complete');
		});
		const organizationId = '11111111-1111-4111-8111-111111111111';

		await expect(service.run({ organizationId }, operation)).resolves.toBe('complete');
		expect(queryRaw).toHaveBeenCalledTimes(2);
		expect(queryRaw.mock.calls[0]?.[1]).toBe(organizationId);
		expect(queryRaw.mock.calls[1]?.[1]).toBe('');
		expect(events).toEqual([organizationId, '', 'operation']);
		expect(operation).toHaveBeenCalledWith(operationClient);
	});

	it('sets a valid branch before invoking the operation', async () => {
		const { queryRaw, service } = await createSubject();
		const organizationId = '11111111-1111-4111-8111-111111111111';
		const branchId = '22222222-2222-4222-8222-222222222222';

		await service.run({ organizationId, branchId }, () => Promise.resolve(undefined));

		expect(queryRaw.mock.calls[0]?.[1]).toBe(organizationId);
		expect(queryRaw.mock.calls[1]?.[1]).toBe(branchId);
	});

	it('passes a bounded transaction budget without changing tenant initialization', async () => {
		const { service, transaction, queryRaw } = await createSubject();
		const options = { maxWait: 5_000, timeout: 20_000 };

		await service.run(
			{ organizationId: '11111111-1111-4111-8111-111111111111' },
			() => Promise.resolve(undefined),
			options,
		);

		expect(transaction.mock.calls[0]?.[1]).toEqual(options);
		expect(queryRaw).toHaveBeenCalledTimes(2);
	});

	it('does not invoke the operation when tenant context initialization fails', async () => {
		const initializationError = new Error('context initialization failed');
		const queryRaw = jest.fn<RawQuery>().mockRejectedValue(initializationError);
		const { service } = await createSubject(queryRaw);
		const operation = jest.fn(() => Promise.resolve(undefined));

		await expect(
			service.run({ organizationId: '11111111-1111-4111-8111-111111111111' }, operation),
		).rejects.toBe(initializationError);
		expect(queryRaw).toHaveBeenCalledTimes(1);
		expect(operation).not.toHaveBeenCalled();
	});

	it('does not invoke the operation when branch context initialization fails', async () => {
		const initializationError = new Error('branch context initialization failed');
		const queryRaw = jest
			.fn<RawQuery>()
			.mockResolvedValueOnce([])
			.mockRejectedValueOnce(initializationError);
		const { service } = await createSubject(queryRaw);
		const operation = jest.fn(() => Promise.resolve(undefined));

		await expect(
			service.run(
				{
					organizationId: '11111111-1111-4111-8111-111111111111',
					branchId: '22222222-2222-4222-8222-222222222222',
				},
				operation,
			),
		).rejects.toBe(initializationError);
		expect(queryRaw).toHaveBeenCalledTimes(2);
		expect(operation).not.toHaveBeenCalled();
	});

	it('uses parameterized tagged queries for tenant values', async () => {
		const { queryRaw, service } = await createSubject();
		const organizationId = '11111111-1111-4111-8111-111111111111';
		const branchId = '22222222-2222-4222-8222-222222222222';

		await service.run({ organizationId, branchId }, () => Promise.resolve(undefined));

		const organizationTemplate = queryRaw.mock.calls[0]?.[0];
		const branchTemplate = queryRaw.mock.calls[1]?.[0];
		expect(organizationTemplate?.join('')).not.toContain(organizationId);
		expect(branchTemplate?.join('')).not.toContain(branchId);
		expect(queryRaw.mock.calls[0]?.[1]).toBe(organizationId);
		expect(queryRaw.mock.calls[1]?.[1]).toBe(branchId);
	});
	it('snapshots mutable input before the asynchronous operation begins', async () => {
		const { service, queryRaw, transaction } = await createSubject();
		transaction.mockImplementation(async (callback) => {
			await Promise.resolve();
			return callback({ $queryRaw: queryRaw });
		});
		const context = { organizationId: '11111111-1111-4111-8111-111111111111',
			branchId: '22222222-2222-4222-8222-222222222222' };
		const operation = service.run(context, () => Promise.resolve(undefined));
		context.organizationId = '33333333-3333-4333-8333-333333333333';
		context.branchId = '44444444-4444-4444-8444-444444444444';
		await operation;
		expect(queryRaw.mock.calls[0]?.[1]).toBe('11111111-1111-4111-8111-111111111111');
		expect(queryRaw.mock.calls[1]?.[1]).toBe('22222222-2222-4222-8222-222222222222');
	});

	it('rejects nested scopes and allows an independent operation after failure', async () => {
		const { service, transaction } = await createSubject();
		const context = { organizationId: '11111111-1111-4111-8111-111111111111' };
		await expect(service.run(context, () => service.run(context, () => Promise.resolve(undefined))))
			.rejects.toThrow('Nested tenant transactions');
		expect(transaction).toHaveBeenCalledTimes(1);
		await expect(service.run(context, () => Promise.resolve('next'))).resolves.toBe('next');
	});

	it('keeps asynchronous nesting protection independent across parallel operations', async () => {
		const { service } = await createSubject();
		const run = (organizationId: string): Promise<string> => service.run({ organizationId }, async () => {
			await Promise.resolve();
			return organizationId;
		});
		await expect(Promise.all([
			run('11111111-1111-4111-8111-111111111111'),
			run('22222222-2222-4222-8222-222222222222'),
		])).resolves.toEqual(['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222']);
	});

});
