import { createHash, randomUUID } from 'node:crypto';

import { jest } from '@jest/globals';
import { Test, type TestingModule } from '@nestjs/testing';

import { DatabaseModule } from '../../src/database/database.module.js';
import { PrismaService } from '../../src/database/prisma.service.js';
import {
	OrganizationOwnerInvitationDeliveryStatus,
	OrganizationOwnerInvitationStatus,
	OrganizationOwnershipAuditAction,
	OrganizationStatus,
	PlatformStaffStatus,
	UserStatus,
	type Prisma,
} from '../../src/index.js';
import { OrganizationOwnerInvitationDeliveryTestFixtures } from './organization-owner-invitation-delivery-test-fixtures.js';
import { OrganizationOwnerInvitationTestFixtures } from './organization-owner-invitation-test-fixtures.js';
import { OrganizationTestFixtures } from './organization-test-fixtures.js';
import { PlatformAdminTestFixtures } from './platform-admin-test-fixtures.js';
import {
	loadTestDatabaseSafetyConfig,
	verifyTestDatabaseSafety,
	verifyTestTablePrivileges,
	type VerifiedTestDatabase,
} from './test-database-safety.js';

const safety = loadTestDatabaseSafetyConfig();
const transactionOptions = { maxWait: 10_000, timeout: 20_000 } as const;
const requiredChecks = [
	'organization_owner_invitation_deliveries_lifecycle_check',
	'organization_owner_invitation_deliveries_lease_check',
	'organization_owner_invitation_deliveries_retry_check',
	'organization_owner_invitation_deliveries_token_material_check',
	'organization_owner_invitation_deliveries_timestamp_order_check',
	'organization_owner_invitation_deliveries_bounded_text_check',
];

jest.setTimeout(60_000);

describe('organization owner invitation delivery foundation', () => {
	let module: TestingModule | undefined;
	let prisma: PrismaService;
	let verified: VerifiedTestDatabase | undefined;
	let organizations: OrganizationTestFixtures;
	let identities: PlatformAdminTestFixtures;
	let invitations: OrganizationOwnerInvitationTestFixtures;
	let deliveries: OrganizationOwnerInvitationDeliveryTestFixtures;
	const additionalDeliveryFixtures: OrganizationOwnerInvitationDeliveryTestFixtures[] = [];

	beforeAll(async () => {
		module = await Test.createTestingModule({
			imports: [
				DatabaseModule.forRoot({
					databaseUrl: safety.databaseUrl,
					poolMax: 4,
					connectionTimeoutMilliseconds: 10_000,
				}),
			],
		}).compile();
		await module.init();
		prisma = module.get(PrismaService);
		const safe = await verifyTestDatabaseSafety(prisma, safety);
		const [table] = await prisma.$queryRaw<{ name: string | null }[]>`
			SELECT to_regclass('public.organization_owner_invitation_deliveries')::text AS name
		`;
		const checks = await prisma.$queryRaw<{ name: string; definition: string }[]>`
			SELECT conname AS name, pg_get_constraintdef(oid) AS definition FROM pg_catalog.pg_constraint
			WHERE conrelid = to_regclass('public.organization_owner_invitation_deliveries')
				AND contype = 'c' AND convalidated
		`;
		const indexes = await prisma.$queryRaw<{ name: string }[]>`
			SELECT indexname AS name FROM pg_catalog.pg_indexes
			WHERE schemaname = 'public'
				AND tablename = 'organization_owner_invitation_deliveries'
		`;
		const triggers = await prisma.$queryRaw<{ name: string }[]>`
			SELECT tgname AS name FROM pg_catalog.pg_trigger
			WHERE tgrelid = to_regclass('public.organization_owner_invitation_deliveries')
				AND NOT tgisinternal AND tgenabled IN ('O', 'A')
		`;
		const [auditCheck] = await prisma.$queryRaw<{ definition: string }[]>`
			SELECT pg_get_constraintdef(oid) AS definition FROM pg_catalog.pg_constraint
			WHERE conrelid = to_regclass('public.organization_ownership_audit_events')
				AND conname = 'organization_ownership_audit_events_metadata_check' AND convalidated
		`;
		const missing: string[] = [];
		if (table === undefined || table.name === null) {
			missing.push('table public.organization_owner_invitation_deliveries');
		}
		missing.push(
			...requiredChecks
				.filter((name) => !checks.some((check) => check.name === name))
				.map((name) => `validated check ${name}`),
		);
		const tokenCheck = checks.find(
			({ name }) => name === 'organization_owner_invitation_deliveries_token_material_check',
		);
		if (tokenCheck !== undefined && !tokenCheck.definition.includes('4096')) {
			missing.push('reviewed 4096-byte ciphertext bound');
		}
		if (!triggers.some(({ name }) => name === 'owner_invitation_delivery_guard')) {
			missing.push('enabled trigger owner_invitation_delivery_guard');
		}
		if (!auditCheck?.definition.includes('invitation_delivery_queued')) {
			missing.push('validated ownership-audit metadata for invitation_delivery_queued');
		}
		for (const name of [
			'owner_invitation_deliveries_org_invitation_key',
			'organization_owner_invitation_deliveries_worker_claim_idx',
		]) {
			if (!indexes.some((index) => index.name === name)) missing.push(`index ${name}`);
		}
		if (missing.length > 0) {
			throw new Error(
				`Owner invitation delivery prerequisites are missing: ${missing.join('; ')}. ` +
					'Review and apply the Step 21 forward repair and disposable-test grants before ' +
					'integration tests. Migration status alone does not prove these protections exist; ' +
					'do not rewrite the foundation or bypass this preflight.',
			);
		}
		await verifyTestTablePrivileges(prisma, [
			{
				tableName: 'organization_owner_invitation_deliveries',
				privileges: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
			},
		]);
		verified = safe;
	});

	beforeEach(() => {
		organizations = new OrganizationTestFixtures();
		identities = new PlatformAdminTestFixtures();
		invitations = new OrganizationOwnerInvitationTestFixtures();
		deliveries = new OrganizationOwnerInvitationDeliveryTestFixtures();
		additionalDeliveryFixtures.length = 0;
	});

	afterEach(async () => {
		if (verified === undefined) return;
		for (const fixtures of [...additionalDeliveryFixtures, deliveries]) {
			await fixtures.cleanup(prisma, verified);
		}
		await invitations.cleanup(prisma, verified);
		await organizations.cleanup(prisma, verified);
		await identities.cleanup(prisma, verified);
	});

	afterAll(async () => {
		await module?.close();
	});

	function requireVerified(): VerifiedTestDatabase {
		if (verified === undefined)
			throw new Error('Invitation delivery test database is not verified.');
		return verified;
	}

	async function createOrganization(name = 'Kigali Strength Club'): Promise<string> {
		const fixture = organizations.reserve(requireVerified());
		await prisma.organization.create({
			data: { ...fixture, name, status: OrganizationStatus.ACTIVE, activatedAt: new Date() },
		});
		return fixture.id;
	}

	async function createActor(): Promise<string> {
		const userId = identities.reserveUserId();
		const actorId = identities.reservePlatformStaffId();
		await prisma.user.create({
			data: {
				id: userId,
				email: `delivery-actor-${userId}@example.com`,
				displayName: 'Aline Uwase',
				status: UserStatus.ACTIVE,
				emailVerifiedAt: new Date(),
				platformStaff: { create: { id: actorId, status: PlatformStaffStatus.ACTIVE } },
			},
		});
		return actorId;
	}

	async function createInvitation(organizationId: string, actorId: string): Promise<string> {
		const invitationId = invitations.reserveInvitationId(requireVerified());
		await prisma.organizationOwnerInvitation.create({
			data: {
				id: invitationId,
				organizationId,
				invitedEmail: `future-owner-${invitationId}@example.com`,
				invitedDisplayName: 'Future Organization Owner',
				invitedByPlatformStaffId: actorId,
			},
		});
		return invitationId;
	}

	function deliveryData(
		organizationId: string,
		ownerInvitationId: string,
		requestedByPlatformStaffId: string,
	): Prisma.OrganizationOwnerInvitationDeliveryUncheckedCreateInput & { readonly id: string } {
		const id = deliveries.reserveDeliveryId(requireVerified());
		const createdAt = new Date();
		return {
			id,
			organizationId,
			ownerInvitationId,
			requestedByPlatformStaffId,
			createdAt,
			nextAttemptAt: createdAt,
			providerIdempotencyKey: `owner-invitation-delivery:${id}`,
			tokenDigest: createHash('sha256').update(`fictional-token:${id}`).digest('hex'),
			tokenCiphertext: Buffer.from(`encrypted-fixture-${id}`),
			tokenInitializationVector: Buffer.alloc(12, 1),
			tokenAuthenticationTag: Buffer.alloc(16, 2),
			tokenEncryptionKeyId: 'test-key-2026-10',
			tokenEncryptionVersion: 1,
			tokenExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1_000),
		};
	}

	const clearedLease = { leaseAcquiredAt: null, leaseExpiresAt: null, claimedBy: null };
	function erasedToken(tokenErasedAt: Date) {
		return {
			tokenDigest: null,
			tokenCiphertext: null,
			tokenInitializationVector: null,
			tokenAuthenticationTag: null,
			tokenEncryptionKeyId: null,
			tokenEncryptionVersion: null,
			tokenErasedAt,
		};
	}

	async function createClaimedDelivery(
		data: ReturnType<typeof deliveryData>,
		claimedBy: string,
	): Promise<Date> {
		await prisma.organizationOwnerInvitationDelivery.create({ data });
		const claimedAt = new Date();
		await prisma.organizationOwnerInvitationDelivery.update({
			where: { id: data.id },
			data: {
				status: OrganizationOwnerInvitationDeliveryStatus.PROCESSING,
				attemptCount: { increment: 1 },
				nextAttemptAt: null,
				leaseAcquiredAt: claimedAt,
				leaseExpiresAt: new Date(claimedAt.getTime() + 60_000),
				claimedBy,
			},
		});
		return claimedAt;
	}

	function queuedAuditData(
		organizationId: string,
		ownerInvitationId: string,
		actorId: string,
	): Prisma.OrganizationOwnershipAuditEventUncheckedCreateInput & { readonly id: string } {
		return {
			id: invitations.reserveAuditEventId(requireVerified()),
			organizationId,
			ownerInvitationId,
			actorPlatformStaffId: actorId,
			action: OrganizationOwnershipAuditAction.INVITATION_DELIVERY_QUEUED,
			requestId: randomUUID(),
			previousInvitationStatus: OrganizationOwnerInvitationStatus.PENDING_DELIVERY,
			resultingInvitationStatus: OrganizationOwnerInvitationStatus.PENDING_DELIVERY,
			occurredAt: new Date(),
		};
	}

	it('persists one organization-scoped queued reservation and its administrator audit atomically', async () => {
		const organizationId = await createOrganization();
		const actorId = await createActor();
		const invitationId = await createInvitation(organizationId, actorId);
		const delivery = deliveryData(organizationId, invitationId, actorId);

		await prisma.$transaction(async (transaction) => {
			await transaction.organizationOwnerInvitationDelivery.create({ data: delivery });
			await transaction.organizationOwnershipAuditEvent.create({
				data: queuedAuditData(organizationId, invitationId, actorId),
			});
		}, transactionOptions);

		expect(
			await prisma.organizationOwnerInvitationDelivery.findUniqueOrThrow({
				where: { id: delivery.id },
			}),
		).toMatchObject({
			organizationId,
			ownerInvitationId: invitationId,
			requestedByPlatformStaffId: actorId,
			status: OrganizationOwnerInvitationDeliveryStatus.QUEUED,
			attemptCount: 0,
			maxAttempts: 3,
			providerMessageId: null,
			lastErrorCode: null,
		});
		expect(
			await prisma.organizationOwnerInvitation.findUniqueOrThrow({ where: { id: invitationId } }),
		).toMatchObject({ status: OrganizationOwnerInvitationStatus.PENDING_DELIVERY });
		expect(await prisma.organizationMembership.count({ where: { organizationId } })).toBe(0);
		expect(await prisma.organizationRole.count({ where: { organizationId } })).toBe(0);
	});

	it('rejects cross-organization delivery links and duplicate invitation reservations', async () => {
		const organizationId = await createOrganization();
		const otherOrganizationId = await createOrganization('Nyamirambo Supplies');
		const actorId = await createActor();
		const invitationId = await createInvitation(organizationId, actorId);

		await expect(
			prisma.organizationOwnerInvitationDelivery.create({
				data: deliveryData(otherOrganizationId, invitationId, actorId),
			}),
		).rejects.toMatchObject({ code: 'P2003' });

		const first = deliveryData(organizationId, invitationId, actorId);
		await prisma.organizationOwnerInvitationDelivery.create({ data: first });
		await expect(
			prisma.organizationOwnerInvitationDelivery.create({
				data: deliveryData(organizationId, invitationId, actorId),
			}),
		).rejects.toMatchObject({ code: 'P2002' });
	});

	it('allows exactly one concurrent worker to claim a queued delivery', async () => {
		const organizationId = await createOrganization();
		const actorId = await createActor();
		const invitationId = await createInvitation(organizationId, actorId);
		const delivery = deliveryData(organizationId, invitationId, actorId);
		await prisma.organizationOwnerInvitationDelivery.create({ data: delivery });
		const claimedAt = new Date();

		const claims = await Promise.all(
			['worker-a', 'worker-b'].map((claimedBy) =>
				prisma.organizationOwnerInvitationDelivery.updateMany({
					where: {
						id: delivery.id,
						status: OrganizationOwnerInvitationDeliveryStatus.QUEUED,
						nextAttemptAt: { lte: claimedAt },
						attemptCount: { lt: 3 },
					},
					data: {
						status: OrganizationOwnerInvitationDeliveryStatus.PROCESSING,
						attemptCount: { increment: 1 },
						nextAttemptAt: null,
						leaseAcquiredAt: claimedAt,
						leaseExpiresAt: new Date(claimedAt.getTime() + 60_000),
						claimedBy,
					},
				}),
			),
		);

		expect(claims.reduce((sum, claim) => sum + claim.count, 0)).toBe(1);
		expect(
			await prisma.organizationOwnerInvitationDelivery.findUniqueOrThrow({
				where: { id: delivery.id },
			}),
		).toMatchObject({
			status: OrganizationOwnerInvitationDeliveryStatus.PROCESSING,
			attemptCount: 1,
		});
	});

	it('recovers an expired worker lease as uncertain without scheduling another send', async () => {
		const organizationId = await createOrganization();
		const actorId = await createActor();
		const invitationId = await createInvitation(organizationId, actorId);
		const delivery = deliveryData(organizationId, invitationId, actorId);
		await prisma.organizationOwnerInvitationDelivery.create({ data: delivery });
		// Database time avoids depending on application/Neon clock skew for a short test lease.
		await prisma.$executeRaw`
			UPDATE public.organization_owner_invitation_deliveries
			SET status = 'processing', attempt_count = attempt_count + 1, next_attempt_at = NULL,
				lease_acquired_at = clock_timestamp(),
				lease_expires_at = clock_timestamp() + interval '50 milliseconds',
				claimed_by = 'expired-worker', updated_at = clock_timestamp()
			WHERE organization_id = ${organizationId}::uuid AND id = ${delivery.id}::uuid
				AND status = 'queued'
		`;
		await new Promise<void>((resolve) => setTimeout(resolve, 100));
		const [clock] = await prisma.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
		if (clock === undefined) throw new Error('Database clock is unavailable.');
		const now = clock.now;

		await expect(
			prisma.organizationOwnerInvitationDelivery.update({
				where: { id: delivery.id },
				data: {
					status: OrganizationOwnerInvitationDeliveryStatus.QUEUED,
					nextAttemptAt: now,
					...clearedLease,
				},
			}),
		).rejects.toThrow('invalid delivery transition');

		const recovered = await prisma.organizationOwnerInvitationDelivery.updateMany({
			where: {
				id: delivery.id,
				status: OrganizationOwnerInvitationDeliveryStatus.PROCESSING,
				leaseExpiresAt: { lt: now },
			},
			data: {
				status: OrganizationOwnerInvitationDeliveryStatus.UNCERTAIN,
				uncertainAt: now,
				lastErrorCode: 'WORKER_LEASE_EXPIRED',
				...clearedLease,
			},
		});

		expect(recovered.count).toBe(1);
		expect(
			await prisma.organizationOwnerInvitationDelivery.findUniqueOrThrow({
				where: { id: delivery.id },
			}),
		).toMatchObject({
			status: OrganizationOwnerInvitationDeliveryStatus.UNCERTAIN,
			attemptCount: 1,
			nextAttemptAt: null,
			leaseAcquiredAt: null,
			leaseExpiresAt: null,
			claimedBy: null,
		});
	});

	it('finalizes provider acceptance with the invitation transition and encrypted-token erasure', async () => {
		const organizationId = await createOrganization();
		const actorId = await createActor();
		const invitationId = await createInvitation(organizationId, actorId);
		const delivery = deliveryData(organizationId, invitationId, actorId);
		if (delivery.tokenDigest === null || delivery.tokenDigest === undefined) {
			throw new Error('The delivery fixture must contain a token digest.');
		}
		const tokenDigest = delivery.tokenDigest;
		await createClaimedDelivery(delivery, 'confirmation-worker');
		const sentAt = new Date();

		await prisma.$transaction(async (transaction) => {
			const transitioned = await transaction.organizationOwnerInvitation.updateMany({
				where: {
					id: invitationId,
					organizationId,
					status: OrganizationOwnerInvitationStatus.PENDING_DELIVERY,
				},
				data: {
					status: OrganizationOwnerInvitationStatus.SENT,
					tokenDigest,
					sentAt,
					expiresAt: delivery.tokenExpiresAt,
				},
			});
			if (transitioned.count !== 1) throw new Error('Invitation is no longer delivery eligible.');
			await transaction.organizationOwnerInvitationDelivery.update({
				where: { id: delivery.id },
				data: {
					status: OrganizationOwnerInvitationDeliveryStatus.CONFIRMED,
					providerMessageId: `resend-${delivery.id}`,
					confirmedAt: sentAt,
					nextAttemptAt: null,
					leaseAcquiredAt: null,
					leaseExpiresAt: null,
					claimedBy: null,
					tokenCiphertext: null,
					tokenInitializationVector: null,
					tokenAuthenticationTag: null,
					tokenEncryptionKeyId: null,
					tokenEncryptionVersion: null,
					tokenDigest: null,
					tokenErasedAt: sentAt,
				},
			});
		}, transactionOptions);

		expect(
			await prisma.organizationOwnerInvitation.findUniqueOrThrow({ where: { id: invitationId } }),
		).toMatchObject({
			status: OrganizationOwnerInvitationStatus.SENT,
			tokenDigest,
		});
		expect(
			await prisma.organizationOwnerInvitationDelivery.findUniqueOrThrow({
				where: { id: delivery.id },
			}),
		).toMatchObject({
			status: OrganizationOwnerInvitationDeliveryStatus.CONFIRMED,
			tokenCiphertext: null,
			tokenInitializationVector: null,
			tokenAuthenticationTag: null,
			tokenEncryptionKeyId: null,
			tokenEncryptionVersion: null,
			tokenDigest: null,
		});
	});

	it('prevents a revoked invitation from being finalized after a worker claim', async () => {
		const organizationId = await createOrganization();
		const actorId = await createActor();
		const invitationId = await createInvitation(organizationId, actorId);
		const delivery = deliveryData(organizationId, invitationId, actorId);
		await createClaimedDelivery(delivery, 'revocation-race-worker');
		const now = new Date();
		await prisma.organizationOwnerInvitation.update({
			where: { id: invitationId },
			data: { status: OrganizationOwnerInvitationStatus.REVOKED, revokedAt: now },
		});

		const transitioned = await prisma.organizationOwnerInvitation.updateMany({
			where: {
				id: invitationId,
				organizationId,
				status: OrganizationOwnerInvitationStatus.PENDING_DELIVERY,
			},
			data: {
				status: OrganizationOwnerInvitationStatus.SENT,
				tokenDigest: delivery.tokenDigest,
				sentAt: now,
				expiresAt: delivery.tokenExpiresAt,
			},
		});
		expect(transitioned.count).toBe(0);

		await prisma.organizationOwnerInvitationDelivery.update({
			where: { id: delivery.id },
			data: {
				status: OrganizationOwnerInvitationDeliveryStatus.UNCERTAIN,
				uncertainAt: now,
				lastErrorCode: 'INVITATION_NO_LONGER_ELIGIBLE',
				leaseAcquiredAt: null,
				leaseExpiresAt: null,
				claimedBy: null,
			},
		});
		expect(
			await prisma.organizationOwnerInvitation.findUniqueOrThrow({ where: { id: invitationId } }),
		).toMatchObject({
			status: OrganizationOwnerInvitationStatus.REVOKED,
			tokenDigest: null,
		});
	});

	it('records retryable failure and uncertain provider outcomes without blind resend', async () => {
		const organizationId = await createOrganization();
		const actorId = await createActor();
		const invitationId = await createInvitation(organizationId, actorId);
		const failed = deliveryData(organizationId, invitationId, actorId);
		await createClaimedDelivery(failed, 'known-failure-worker');
		const failedAt = new Date();
		await prisma.organizationOwnerInvitationDelivery.update({
			where: { id: failed.id },
			data: {
				status: OrganizationOwnerInvitationDeliveryStatus.FAILED,
				failedAt,
				lastErrorCode: 'PROVIDER_RATE_LIMITED',
				nextAttemptAt: new Date(failedAt.getTime() + 60_000),
				...clearedLease,
			},
		});
		expect(
			await prisma.organizationOwnerInvitationDelivery.findUniqueOrThrow({
				where: { id: failed.id },
			}),
		).toMatchObject({
			status: OrganizationOwnerInvitationDeliveryStatus.FAILED,
			attemptCount: 1,
			lastErrorCode: 'PROVIDER_RATE_LIMITED',
		});

		const uncertainInvitationId = await createInvitation(organizationId, actorId);
		const uncertain = deliveryData(organizationId, uncertainInvitationId, actorId);
		await createClaimedDelivery(uncertain, 'timeout-worker');
		await prisma.organizationOwnerInvitationDelivery.update({
			where: { id: uncertain.id },
			data: {
				status: OrganizationOwnerInvitationDeliveryStatus.UNCERTAIN,
				uncertainAt: new Date(),
				lastErrorCode: 'PROVIDER_TIMEOUT',
				nextAttemptAt: null,
				...clearedLease,
			},
		});
		expect(
			await prisma.organizationOwnerInvitationDelivery.findUniqueOrThrow({
				where: { id: uncertain.id },
			}),
		).toMatchObject({
			status: OrganizationOwnerInvitationDeliveryStatus.UNCERTAIN,
			nextAttemptAt: null,
			lastErrorCode: 'PROVIDER_TIMEOUT',
		});
	});

	it('rejects incomplete encrypted material and impossible lifecycle metadata', async () => {
		const organizationId = await createOrganization();
		const actorId = await createActor();
		const invitationId = await createInvitation(organizationId, actorId);
		const data = deliveryData(organizationId, invitationId, actorId);

		await expect(
			prisma.organizationOwnerInvitationDelivery.create({
				data: { ...data, tokenAuthenticationTag: null },
			}),
		).rejects.toThrow('organization_owner_invitation_deliveries_token_material_check');
		await expect(
			prisma.organizationOwnerInvitationDelivery.create({
				data: {
					...deliveryData(organizationId, invitationId, actorId),
					status: OrganizationOwnerInvitationDeliveryStatus.CONFIRMED,
					providerMessageId: null,
					confirmedAt: null,
				},
			}),
		).rejects.toThrow('invalid delivery reservation');
	});

	it('rolls back delivery preparation when its required administrator audit fails', async () => {
		const organizationId = await createOrganization();
		const actorId = await createActor();
		const invitationId = await createInvitation(organizationId, actorId);
		const delivery = deliveryData(organizationId, invitationId, actorId);

		await expect(
			prisma.$transaction(async (transaction) => {
				await transaction.organizationOwnerInvitationDelivery.create({ data: delivery });
				await transaction.organizationOwnershipAuditEvent.create({
					data: {
						...queuedAuditData(organizationId, invitationId, actorId),
						requestId: 'invalid request id',
					},
				});
			}, transactionOptions),
		).rejects.toThrow();

		expect(
			await prisma.organizationOwnerInvitationDelivery.findUnique({
				where: { id: delivery.id },
			}),
		).toBeNull();
	});

	it('accepts the reviewed maximum encrypted email snapshot without widening IV or tag bounds', async () => {
		const organizationId = await createOrganization();
		const actorId = await createActor();
		const invitationId = await createInvitation(organizationId, actorId);
		const data = deliveryData(organizationId, invitationId, actorId);
		const row = await prisma.organizationOwnerInvitationDelivery.create({
			data: { ...data, tokenCiphertext: new Uint8Array(4096) },
		});
		expect(row.tokenCiphertext?.byteLength).toBe(4096);
		expect(row.tokenInitializationVector?.byteLength).toBe(12);
		expect(row.tokenAuthenticationTag?.byteLength).toBe(16);
	});

	it('keeps reservation identity, crypto and retry policy immutable', async () => {
		const organizationId = await createOrganization();
		const actorId = await createActor();
		const invitationId = await createInvitation(organizationId, actorId);
		const delivery = deliveryData(organizationId, invitationId, actorId);
		await prisma.organizationOwnerInvitationDelivery.create({ data: delivery });
		const otherOrganizationId = await createOrganization('Kicukiro Training');
		const otherActorId = await createActor();
		const otherInvitationId = await createInvitation(organizationId, actorId);
		const changes: readonly {
			data: Prisma.OrganizationOwnerInvitationDeliveryUncheckedUpdateInput;
			rejection: string;
		}[] = [
			{
				data: { id: deliveries.reserveDeliveryId(requireVerified()) },
				rejection: 'immutable delivery reservation',
			},
			{
				data: { organizationId: otherOrganizationId },
				rejection: 'immutable delivery parent',
			},
			{
				data: { ownerInvitationId: otherInvitationId },
				rejection: 'immutable delivery reservation',
			},
			{
				data: { requestedByPlatformStaffId: otherActorId },
				rejection: 'immutable delivery reservation',
			},
			{
				data: { providerIdempotencyKey: `changed:${delivery.id}` },
				rejection: 'immutable delivery reservation',
			},
			{ data: { tokenDigest: 'f'.repeat(64) }, rejection: 'immutable delivery reservation' },
			{
				data: { tokenCiphertext: Buffer.alloc(43, 9) },
				rejection: 'immutable delivery reservation',
			},
			{
				data: { tokenExpiresAt: new Date(Date.now() + 60_000) },
				rejection: 'immutable delivery reservation',
			},
			{ data: { maxAttempts: 4 }, rejection: 'immutable delivery reservation' },
		];
		for (const { data, rejection } of changes) {
			await expect(
				prisma.organizationOwnerInvitationDelivery.update({ where: { id: delivery.id }, data }),
			).rejects.toThrow(rejection);
		}
	});

	it.each([
		{ tokenInitializationVector: Buffer.alloc(11) },
		{ tokenAuthenticationTag: Buffer.alloc(15) },
		{ tokenCiphertext: Buffer.alloc(4097) },
		{ tokenEncryptionVersion: 2 },
		{ tokenEncryptionKeyId: 'not a key id' },
		{ tokenDigest: 'not-a-hmac' },
	])('rejects malformed encrypted metadata %p', async (change) => {
		const organizationId = await createOrganization();
		const actorId = await createActor();
		const invitationId = await createInvitation(organizationId, actorId);
		await expect(
			prisma.organizationOwnerInvitationDelivery.create({
				data: { ...deliveryData(organizationId, invitationId, actorId), ...change },
			}),
		).rejects.toThrow('organization_owner_invitation_deliveries_token_material_check');
	});

	it('enforces attempt bounds, lease duration and typed identifiers', async () => {
		const organizationId = await createOrganization();
		const actorId = await createActor();
		const invitationId = await createInvitation(organizationId, actorId);
		const delivery = deliveryData(organizationId, invitationId, actorId);
		await expect(
			prisma.organizationOwnerInvitationDelivery.create({ data: { ...delivery, maxAttempts: 11 } }),
		).rejects.toThrow('organization_owner_invitation_deliveries_retry_check');
		await expect(
			prisma.organizationOwnerInvitationDelivery.create({
				data: { ...delivery, providerIdempotencyKey: 'invalid provider key' },
			}),
		).rejects.toThrow('organization_owner_invitation_deliveries_bounded_text_check');
		await prisma.organizationOwnerInvitationDelivery.create({ data: delivery });
		const claimedAt = new Date();
		await expect(
			prisma.organizationOwnerInvitationDelivery.update({
				where: { id: delivery.id },
				data: {
					status: OrganizationOwnerInvitationDeliveryStatus.PROCESSING,
					attemptCount: 1,
					nextAttemptAt: null,
					leaseAcquiredAt: claimedAt,
					leaseExpiresAt: new Date(claimedAt.getTime() + 360_000),
					claimedBy: 'too-long-lease',
				},
			}),
		).rejects.toThrow('organization_owner_invitation_deliveries_lease_check');
	});

	it('bounds token lifetime and refuses decreasing worker attempts', async () => {
		const organizationId = await createOrganization();
		const actorId = await createActor();
		const invitationId = await createInvitation(organizationId, actorId);
		const delivery = deliveryData(organizationId, invitationId, actorId);
		await expect(
			prisma.organizationOwnerInvitationDelivery.create({
				data: { ...delivery, tokenExpiresAt: new Date(Date.now() + 8 * 86_400_000) },
			}),
		).rejects.toThrow('organization_owner_invitation_deliveries_timestamp_order_check');
		await createClaimedDelivery(delivery, 'attempt-bound-worker');
		await expect(
			prisma.organizationOwnerInvitationDelivery.update({
				where: { id: delivery.id },
				data: { attemptCount: 0 },
			}),
		).rejects.toThrow('immutable delivery reservation');
	});

	it('rejects a direct confirmation without an atomically matching SENT invitation', async () => {
		const organizationId = await createOrganization();
		const actorId = await createActor();
		const invitationId = await createInvitation(organizationId, actorId);
		const delivery = deliveryData(organizationId, invitationId, actorId);
		await createClaimedDelivery(delivery, 'false-confirmation-worker');
		const now = new Date();
		await expect(
			prisma.organizationOwnerInvitationDelivery.update({
				where: { id: delivery.id },
				data: {
					status: OrganizationOwnerInvitationDeliveryStatus.CONFIRMED,
					providerMessageId: `resend-${delivery.id}`,
					confirmedAt: now,
					...clearedLease,
					...erasedToken(now),
				},
			}),
		).rejects.toThrow('delivery confirmation requires matching sent invitation');
		const invitation = await prisma.organizationOwnerInvitation.findUniqueOrThrow({
			where: { id: invitationId },
		});
		expect(invitation.status).toBe(OrganizationOwnerInvitationStatus.PENDING_DELIVERY);
		expect(invitation.tokenDigest).toBeNull();
	});

	it('refuses claims and direct resurrection after audited invitation revocation', async () => {
		const organizationId = await createOrganization();
		const actorId = await createActor();
		const invitationId = await createInvitation(organizationId, actorId);
		const delivery = deliveryData(organizationId, invitationId, actorId);
		await prisma.organizationOwnerInvitationDelivery.create({ data: delivery });
		const now = new Date();
		await prisma.$transaction(async (transaction) => {
			await transaction.organizationOwnerInvitation.update({
				where: { id: invitationId },
				data: { status: OrganizationOwnerInvitationStatus.REVOKED, revokedAt: now },
			});
			await transaction.organizationOwnershipAuditEvent.create({
				data: {
					...queuedAuditData(organizationId, invitationId, actorId),
					action: OrganizationOwnershipAuditAction.INVITATION_REVOKED,
					resultingInvitationStatus: OrganizationOwnerInvitationStatus.REVOKED,
				},
			});
		}, transactionOptions);
		await expect(
			prisma.organizationOwnerInvitationDelivery.update({
				where: { id: delivery.id },
				data: {
					status: OrganizationOwnerInvitationDeliveryStatus.PROCESSING,
					attemptCount: 1,
					nextAttemptAt: null,
					leaseAcquiredAt: now,
					leaseExpiresAt: new Date(now.getTime() + 60_000),
					claimedBy: 'revoked-claim-worker',
				},
			}),
		).rejects.toThrow('delivery cannot be claimed');
		await expect(
			prisma.organizationOwnerInvitation.update({
				where: { id: invitationId },
				data: { status: OrganizationOwnerInvitationStatus.PENDING_DELIVERY, revokedAt: null },
			}),
		).rejects.toThrow('invalid invitation identity or lifecycle change');
		await prisma.organizationOwnerInvitationDelivery.update({
			where: { id: delivery.id },
			data: {
				status: OrganizationOwnerInvitationDeliveryStatus.FAILED,
				nextAttemptAt: null,
				failedAt: new Date(),
				lastErrorCode: 'INVITATION_REVOKED',
				...erasedToken(new Date()),
			},
		});
	});

	it('retains uncertainty through cleanup and rejects attempts to enqueue it again', async () => {
		const organizationId = await createOrganization();
		const actorId = await createActor();
		const invitationId = await createInvitation(organizationId, actorId);
		const delivery = deliveryData(organizationId, invitationId, actorId);
		await createClaimedDelivery(delivery, 'uncertain-cleanup-worker');
		await prisma.organizationOwnerInvitationDelivery.update({
			where: { id: delivery.id },
			data: {
				status: OrganizationOwnerInvitationDeliveryStatus.UNCERTAIN,
				uncertainAt: new Date(),
				lastErrorCode: 'PROVIDER_TIMEOUT',
				...clearedLease,
			},
		});
		await expect(
			prisma.organizationOwnerInvitationDelivery.update({
				where: { id: delivery.id },
				data: {
					status: OrganizationOwnerInvitationDeliveryStatus.QUEUED,
					nextAttemptAt: new Date(),
					uncertainAt: null,
					lastErrorCode: null,
				},
			}),
		).rejects.toThrow('invalid delivery transition');
		await prisma.organizationOwnerInvitationDelivery.update({
			where: { id: delivery.id },
			data: erasedToken(new Date()),
		});
		const cleaned = await prisma.organizationOwnerInvitationDelivery.findUniqueOrThrow({
			where: { id: delivery.id },
		});
		expect(cleaned.status).toBe(OrganizationOwnerInvitationDeliveryStatus.UNCERTAIN);
		expect(cleaned.tokenCiphertext).toBeNull();
		expect(cleaned.lastErrorCode).toBe('PROVIDER_TIMEOUT');
	});

	it('keeps concurrent revocation authoritative even when provider finalization wins first', async () => {
		const organizationId = await createOrganization();
		const actorId = await createActor();
		const invitationId = await createInvitation(organizationId, actorId);
		const delivery = deliveryData(organizationId, invitationId, actorId);
		await createClaimedDelivery(delivery, 'concurrent-finalization-worker');

		async function lockParents(transaction: Prisma.TransactionClient): Promise<void> {
			await transaction.$queryRaw`
				SELECT id FROM public.organizations WHERE id = ${organizationId}::uuid FOR SHARE
			`;
			await transaction.$queryRaw`
				SELECT id FROM public.organization_owner_invitations
				WHERE organization_id = ${organizationId}::uuid AND id = ${invitationId}::uuid
				FOR UPDATE
			`;
		}
		const [confirmed] = await Promise.all([
			prisma.$transaction(async (transaction) => {
				await lockParents(transaction);
				const now = new Date();
				const sent = await transaction.organizationOwnerInvitation.updateMany({
					where: {
						id: invitationId,
						organizationId,
						status: OrganizationOwnerInvitationStatus.PENDING_DELIVERY,
					},
					data: {
						status: OrganizationOwnerInvitationStatus.SENT,
						tokenDigest: delivery.tokenDigest,
						expiresAt: delivery.tokenExpiresAt,
						sentAt: now,
					},
				});
				if (sent.count === 0) return false;
				const finalized = await transaction.organizationOwnerInvitationDelivery.updateMany({
					where: {
						id: delivery.id,
						organizationId,
						status: OrganizationOwnerInvitationDeliveryStatus.PROCESSING,
						claimedBy: 'concurrent-finalization-worker',
						leaseExpiresAt: { gt: now },
					},
					data: {
						status: OrganizationOwnerInvitationDeliveryStatus.CONFIRMED,
						confirmedAt: now,
						providerMessageId: `resend-${delivery.id}`,
						...clearedLease,
						...erasedToken(now),
					},
				});
				if (finalized.count !== 1) throw new Error('Fixture finalization lost its lease.');
				return true;
			}, transactionOptions),
			prisma.$transaction(async (transaction) => {
				await lockParents(transaction);
				const previous = await transaction.organizationOwnerInvitation.findUniqueOrThrow({
					where: { id: invitationId },
				});
				await transaction.organizationOwnerInvitation.update({
					where: { id: invitationId },
					data: {
						status: OrganizationOwnerInvitationStatus.REVOKED,
						tokenDigest: null,
						revokedAt: new Date(),
					},
				});
				await transaction.organizationOwnershipAuditEvent.create({
					data: {
						...queuedAuditData(organizationId, invitationId, actorId),
						action: OrganizationOwnershipAuditAction.INVITATION_REVOKED,
						previousInvitationStatus: previous.status,
						resultingInvitationStatus: OrganizationOwnerInvitationStatus.REVOKED,
					},
				});
			}, transactionOptions),
		]);
		if (!confirmed) {
			await prisma.organizationOwnerInvitationDelivery.update({
				where: { id: delivery.id },
				data: {
					status: OrganizationOwnerInvitationDeliveryStatus.UNCERTAIN,
					uncertainAt: new Date(),
					lastErrorCode: 'INVITATION_NO_LONGER_ELIGIBLE',
					...clearedLease,
				},
			});
		}
		const finalInvitation = await prisma.organizationOwnerInvitation.findUniqueOrThrow({
			where: { id: invitationId },
		});
		expect(finalInvitation.status).toBe(OrganizationOwnerInvitationStatus.REVOKED);
		expect(finalInvitation.tokenDigest).toBeNull();
		expect(await prisma.organizationMembership.count({ where: { organizationId } })).toBe(0);
	});

	it('keeps terminal known failures erased and prevents resurrection', async () => {
		const organizationId = await createOrganization();
		const actorId = await createActor();
		const invitationId = await createInvitation(organizationId, actorId);
		const delivery = deliveryData(organizationId, invitationId, actorId);
		await prisma.organizationOwnerInvitationDelivery.create({ data: delivery });
		await prisma.organizationOwnerInvitationDelivery.update({
			where: { id: delivery.id },
			data: {
				status: OrganizationOwnerInvitationDeliveryStatus.FAILED,
				failedAt: new Date(),
				lastErrorCode: 'DELIVERY_CANCELLED',
				nextAttemptAt: null,
				...erasedToken(new Date()),
			},
		});
		await expect(
			prisma.organizationOwnerInvitationDelivery.update({
				where: { id: delivery.id },
				data: {
					status: OrganizationOwnerInvitationDeliveryStatus.QUEUED,
					failedAt: null,
					lastErrorCode: null,
					nextAttemptAt: new Date(),
				},
			}),
		).rejects.toThrow('immutable delivery reservation');
	});

	it('rejects queue-audit metadata describing a different invitation transition', async () => {
		const organizationId = await createOrganization();
		const actorId = await createActor();
		const invitationId = await createInvitation(organizationId, actorId);
		await expect(
			prisma.organizationOwnershipAuditEvent.create({
				data: {
					...queuedAuditData(organizationId, invitationId, actorId),
					resultingInvitationStatus: OrganizationOwnerInvitationStatus.SENT,
				},
			}),
		).rejects.toThrow('organization_ownership_audit_events_metadata_check');
	});

	it('keeps delivery persistence unavailable through PUBLIC', async () => {
		const grants = await prisma.$queryRaw<{ count: number }[]>`
			SELECT count(*)::integer AS count FROM pg_catalog.pg_class AS relation
			CROSS JOIN LATERAL aclexplode(
				coalesce(relation.relacl, acldefault('r', relation.relowner))
			) AS grant_entry
			WHERE relation.oid = 'public.organization_owner_invitation_deliveries'::regclass
				AND grant_entry.grantee = 0
		`;
		expect(grants).toEqual([{ count: 0 }]);
		const publicObjects = await prisma.$queryRaw<{ count: number }[]>`
			SELECT count(*)::integer AS count FROM (
				SELECT grant_entry.grantee FROM pg_catalog.pg_type AS enum_type
				CROSS JOIN LATERAL aclexplode(
					coalesce(enum_type.typacl, acldefault('T', enum_type.typowner))
				) AS grant_entry
				WHERE enum_type.oid = 'public.organization_owner_invitation_delivery_status'::regtype
				UNION ALL
				SELECT grant_entry.grantee FROM pg_catalog.pg_proc AS routine
				CROSS JOIN LATERAL aclexplode(
					coalesce(routine.proacl, acldefault('f', routine.proowner))
				) AS grant_entry
				WHERE routine.oid = 'public.guard_owner_invitation_delivery()'::regprocedure
			) AS effective_grants WHERE grantee = 0
		`;
		expect(publicObjects).toEqual([{ count: 0 }]);
	});

	it('cleans only reserved delivery rows and preserves an unrelated sentinel', async () => {
		const organizationId = await createOrganization();
		const actorId = await createActor();
		const invitationId = await createInvitation(organizationId, actorId);
		const tracked = deliveryData(organizationId, invitationId, actorId);
		await prisma.organizationOwnerInvitationDelivery.create({ data: tracked });

		const sentinelOrganizationId = await createOrganization('Remera Training Centre');
		const sentinelInvitationId = await createInvitation(sentinelOrganizationId, actorId);
		const sentinelFixtures = new OrganizationOwnerInvitationDeliveryTestFixtures();
		additionalDeliveryFixtures.push(sentinelFixtures);
		const sentinelId = sentinelFixtures.reserveDeliveryId(requireVerified());
		await prisma.organizationOwnerInvitationDelivery.create({
			data: {
				...deliveryData(sentinelOrganizationId, sentinelInvitationId, actorId),
				id: sentinelId,
				providerIdempotencyKey: `owner-invitation-delivery:${sentinelId}`,
				tokenDigest: createHash('sha256').update(`fictional-token:${sentinelId}`).digest('hex'),
			},
		});

		await deliveries.cleanup(prisma, requireVerified());
		expect(
			await prisma.organizationOwnerInvitationDelivery.findUnique({
				where: { id: sentinelId },
			}),
		).not.toBeNull();
	});
});
