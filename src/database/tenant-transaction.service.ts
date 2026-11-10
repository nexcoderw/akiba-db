import { AsyncLocalStorage } from 'node:async_hooks';

import { Injectable } from '@nestjs/common';

import type { Prisma } from '../generated/prisma/client.js';
import type { TenantContext } from '../types/tenant-context.js';
import { PrismaService } from './prisma.service.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export type TenantTransactionCallback<TResult> = (
	transaction: Prisma.TransactionClient,
) => Promise<TResult>;

/**
 * Runs tenant-owned operations in a transaction with PostgreSQL session context set locally.
 * The API must authenticate and authorize the organization and optional branch before calling this
 * service; UUID validation verifies identifier shape, not access. The operation starts only after
 * both settings are initialized. Future RLS policies must read them with
 * `current_setting(name, true)` and deny access when organization context is absent.
 *
 * PostgreSQL clears these transaction-local values on commit or rollback, preventing pooled
 * connections from carrying tenant context into later transactions. Nested calls fail before a second
 * transaction opens; callers must reuse the existing callback client instead of starting a new scope.
 */
@Injectable()
export class TenantTransactionService {
	private readonly execution = new AsyncLocalStorage<boolean>();
	constructor(private readonly prisma: PrismaService) {}

	async run<TResult>(
		context: TenantContext,
		operation: TenantTransactionCallback<TResult>,
		options?: Readonly<{ maxWait: number; timeout: number }>,
	): Promise<TResult> {
		if (this.execution.getStore() === true) {
			throw new Error('Nested tenant transactions are not supported.');
		}
		// Capture once before scheduling; a caller mutating its object cannot change validated scope.
		const { organizationId, branchId } = context;
		this.assertUuid(organizationId, 'organizationId');
		if (branchId !== undefined) this.assertUuid(branchId, 'branchId');
		const budget = options === undefined ? undefined : { ...options };
		return this.execution.run(true, () =>
			this.prisma.$transaction(async (transaction) => {
				await transaction.$queryRaw`
				SELECT set_config('app.current_organization_id', ${organizationId}, true)
			`;
				await transaction.$queryRaw`
				SELECT set_config('app.current_branch_id', ${branchId ?? ''}, true)
			`;
				return operation(transaction);
			}, budget),
		);
	}

	private assertUuid(value: string, field: keyof TenantContext): void {
		if (!UUID_PATTERN.test(value)) {
			throw new Error(`${field} must be a valid UUID.`);
		}
	}
}
