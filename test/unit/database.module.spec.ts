import { DatabaseModule } from '../../src/database/database.module.js';
import { PrismaService } from '../../src/database/prisma.service.js';
import { TenantTransactionService } from '../../src/database/tenant-transaction.service.js';

describe('DatabaseModule', () => {
	it('exports the database services without controllers', () => {
		const module = DatabaseModule.forRoot({
			databaseUrl: 'postgresql://localhost/akiba',
			poolMax: 1,
			connectionTimeoutMilliseconds: 1_000,
		});

		expect(module.controllers).toBeUndefined();
		expect(module.exports).toEqual([PrismaService, TenantTransactionService]);
	});
});
