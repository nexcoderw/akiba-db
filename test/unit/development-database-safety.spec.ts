import { jest } from '@jest/globals';

import type { PrismaService } from '../../src/database/prisma.service.js';
import {
	assertConnectedDevelopmentDatabaseIsSafe,
	assertDevelopmentDatabaseWasVerified,
	loadDevelopmentDatabaseConfig,
	verifyDevelopmentDatabaseSafety,
	verifyTestTablePrivileges,
} from '../integration/development-database-safety.js';
import { approvedTargets, neonEnvironment } from './neon-environment-fixtures.js';

type RawQuery = (query: TemplateStringsArray, ...values: unknown[]) => Promise<unknown>;

describe('development integration safety', () => {
	it('accepts the guarded development target while production approval is pending', () => {
		const targets = {
			development: approvedTargets.development,
			production: { ...approvedTargets.production, directHost: '' },
		};
		expect(loadDevelopmentDatabaseConfig(neonEnvironment(), targets)).toMatchObject({
			databaseName: 'neondb',
			databaseUser: 'neondb_owner',
			coordinatorPid: 12345,
		});
	});

	it('requires the guarded runner and rejects production before a connection opens', () => {
		expect(() =>
			loadDevelopmentDatabaseConfig(neonEnvironment('production'), approvedTargets),
		).toThrow('NODE_ENV');
		expect(() =>
			loadDevelopmentDatabaseConfig(
				{ ...neonEnvironment(), AKIBA_INTEGRATION_COORDINATOR_PID: undefined },
				approvedTargets,
			),
		).toThrow('npm run test:integration');
		expect(() => {
			assertDevelopmentDatabaseWasVerified(undefined);
		}).toThrow('has not completed');
	});

	it('grants fixture access only after live identity and lease verification', () => {
		const config = loadDevelopmentDatabaseConfig(neonEnvironment(), approvedTargets);
		const identity = {
			databaseName: 'neondb',
			databaseUser: 'neondb_owner',
			coordinatorAlive: true,
		};
		expect(() => {
			assertDevelopmentDatabaseWasVerified(
				assertConnectedDevelopmentDatabaseIsSafe(config, identity),
			);
		}).not.toThrow();
		for (const override of [
			{ coordinatorAlive: false },
			{ databaseName: 'another' },
			{ databaseUser: 'another' },
		]) {
			const mutation = jest.fn();
			expect(() =>
				mutation(assertConnectedDevelopmentDatabaseIsSafe(config, { ...identity, ...override })),
			).toThrow('could not be verified');
			expect(mutation).not.toHaveBeenCalled();
		}
	});

	it('parameterizes coordinator checks and rejects an absent live lease', async () => {
		const queryRaw = jest
			.fn<RawQuery>()
			.mockResolvedValue([
				{ database_name: 'neondb', database_user: 'neondb_owner', coordinator_alive: false },
			]);
		const prisma = { $queryRaw: queryRaw } as unknown as PrismaService;
		await expect(
			verifyDevelopmentDatabaseSafety(
				prisma,
				loadDevelopmentDatabaseConfig(neonEnvironment(), approvedTargets),
			),
		).rejects.toThrow('could not be verified');
		expect(queryRaw).toHaveBeenCalledTimes(1);
		expect(queryRaw.mock.calls[0]).toContain(12345);
	});
	it('verifies every required table privilege in one database round trip', async () => {
		const queryRaw = jest.fn<RawQuery>().mockResolvedValue([
			{
				table_name: 'organization_memberships',
				privileges: 'SELECT,INSERT,UPDATE,DELETE',
				allowed: true,
			},
			{
				table_name: 'organization_roles',
				privileges: 'SELECT,INSERT,UPDATE,DELETE',
				allowed: true,
			},
		]);
		const prisma = { $queryRaw: queryRaw } as unknown as PrismaService;

		await verifyTestTablePrivileges(prisma, [
			{
				tableName: 'organization_memberships',
				privileges: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
			},
			{
				tableName: 'organization_roles',
				privileges: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
			},
		]);

		expect(queryRaw).toHaveBeenCalledTimes(1);
		const serializedRequirements = queryRaw.mock.calls[0]?.[1];
		expect(typeof serializedRequirements).toBe('string');
		expect(JSON.parse(serializedRequirements as string)).toEqual([
			{
				table_name: 'organization_memberships',
				privileges: 'SELECT,INSERT,UPDATE,DELETE',
			},
			{
				table_name: 'organization_roles',
				privileges: 'SELECT,INSERT,UPDATE,DELETE',
			},
		]);
	});

	it('reports the exact denied table from a batched privilege check', async () => {
		const queryRaw = jest.fn<RawQuery>().mockResolvedValue([
			{
				table_name: 'organization_roles',
				privileges: 'SELECT,INSERT,UPDATE,DELETE',
				allowed: false,
			},
		]);
		const prisma = { $queryRaw: queryRaw } as unknown as PrismaService;

		await expect(
			verifyTestTablePrivileges(prisma, [
				{
					tableName: 'organization_roles',
					privileges: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
				},
			]),
		).rejects.toThrow('missing SELECT,INSERT,UPDATE,DELETE on public.organization_roles');
		expect(queryRaw).toHaveBeenCalledTimes(1);
	});
});
