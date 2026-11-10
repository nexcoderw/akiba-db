# Akiba Database

Akiba Database (`@nexcoderw/akiba-db`) is the PostgreSQL and Prisma foundation for Akiba, an
international, multi-organization inventory management SaaS platform. The
[akiba-db repository](https://github.com/nexcoderw/akiba-db) owns the canonical schema, ordered
migrations, generated client configuration and a NestJS database library. It is a foundation for an
enterprise platform; it does not yet provide complete tenant isolation or an inventory domain.

The future `akiba-api` backend owns authentication flows, effective authorization, tenant resolution,
HTTP endpoints and business operations. It will consume an exact released package version through the
root export, without copying schemas, generating its own client or running migrations at startup.

## Scope and implemented capabilities

The current schema contains 23 reusable foundation models:

| Area                    | Implemented persistence                                                                                                                 |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Global identity         | `User`, `PasswordCredential`                                                                                                            |
| Platform administration | `PlatformStaff`, `PlatformRole`, `PlatformPermission`, `PlatformStaffRole`, `PlatformRolePermission`                                    |
| Platform authentication | `PlatformAdminSession`, `PlatformTotpCredential`, `PlatformRecoveryCode`, `PlatformMfaChallenge`                                        |
| Organization registry   | `Organization` with unique slug and pending, active, suspended and archived states                                                      |
| Organization access     | `OrganizationMembership`, `OrganizationRole`, `OrganizationMembershipRole`                                                              |
| Owner onboarding        | `OrganizationOwnerInvitation`, `OrganizationOwnerInvitationDelivery`, `OrganizationOwnerEnrollmentChallenge`                            |
| Organization sessions   | `OwnerSession` bound to a global identity                                                                                               |
| Audit                   | `OrganizationAuditEvent`, `PlatformAuthorizationAuditEvent`, `OrganizationOwnershipAuditEvent`, `OrganizationOwnerAcceptanceAuditEvent` |

Organization memberships represent user access eligibility. Organization roles are tenant-owned and
role assignments use composite foreign keys to prevent cross-organization links. They are independent
of platform roles and permissions. Organization permission definitions and role-permission mappings
are **not implemented**. Creating a user, organization, role or invitation grants no authorization.

The library implements validated immutable runtime configuration, a shared Prisma connection pool,
Nest initialization/shutdown hooks and `TenantTransactionService`. The transaction helper parameterizes
`app.current_organization_id` and `app.current_branch_id` with transaction-local `set_config` calls.
Commit and rollback clear context before pooled connections are reused. UUID checks validate shape;
they do not authenticate an actor or prove access.

There are no seed scripts, seeded administrators, default grants, Docker configuration, API endpoints,
frontend or inventory models. Warehouses, products, suppliers, customers, stock movements, purchasing,
sales, domain ownership and full tenant authorization are planned separately.

## Technology and requirements

- Node.js `^20.19.0 || ^22.12.0 || >=24.0.0`, npm 10 or newer; CI uses Node.js 22.
- TypeScript 5 with strict NodeNext ESM and declaration output.
- Prisma 7, the `prisma-client` generator, `@prisma/adapter-pg` and `pg`.
- PostgreSQL with the `citext` and `btree_gist` extensions available to the migration role. The latter
  remains in the inherited migration chain even though current models do not require it.
- NestJS 11, `reflect-metadata` and RxJS as peers in the consuming application.
- Jest/ts-jest for unit and PostgreSQL integration tests; ESLint and Prettier for authored sources.
- GitHub Packages authentication for publishing or installing the private scoped library. Public
  dependency installation uses the committed npm lockfile. Keep registry tokens outside the repository.

## Repository architecture

```text
.agents/                 mandatory engineering rules
.github/workflows/       package verification; no deployment job
prisma/schema.prisma     canonical PostgreSQL models and enums
prisma/migrations/       immutable history and forward migrations
prisma.config.ts         development/production migration configuration
prisma.test.config.ts    explicitly selected disposable migration target
src/config/             environment validation
src/database/           Nest module, Prisma lifecycle, tenant transactions
src/types/              tenant context contract
src/generated/prisma/   ignored Prisma-generated TypeScript
src/index.ts            public package exports
test/unit/              configuration, contracts, identity and migration checks
test/integration/       restricted-role PostgreSQL tests and scoped fixtures
```

Generated sources compile together with authored sources into ignored `dist/`. Only `dist/` and this
README ship in the package. The public root exports configuration, the Nest module, Prisma and tenant
services, tenant types and the generated Prisma client/types/enums. Consumers must not deep-import
private paths. Durable package guidance lives here; agent-only conventions remain in `.agents/`.

## Installation and environment configuration

Run commands from `api/db` in this workspace, or from the root of a standalone `akiba-db` clone:

```bash
npm ci
cp .env.local.example .env.local
cp .env.migrations.local.example .env.migrations.local
cp .env.test.local.example .env.test.local
```

Replace every placeholder with independently provisioned values. These copies do not create databases,
users, TLS certificates or grants. Local TLS settings must match the PostgreSQL server; never carry an
insecure local override into hosted environments. Keep all actual `.env*` files ignored.

| Variable                         | Consumer and purpose                                                                                                                                    |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                   | Runtime application role; required by `loadDatabaseConfig`. Production Prisma CLI also uses this name, with a separately supplied migration credential. |
| `DATABASE_POOL_MAX`              | Optional runtime pool limit per process; default `10`. Budget across all replicas.                                                                      |
| `DATABASE_CONNECTION_TIMEOUT_MS` | Optional positive runtime connection timeout; default `10000`.                                                                                          |
| `DIRECT_DATABASE_URL`            | Local migration DDL role and direct connection, preferred over `DATABASE_URL`. In test configuration, a passwordless reference target only.             |
| `SHADOW_DATABASE_URL`            | Separate disposable development shadow database that Prisma may reset. Never a valuable or shared database.                                             |
| `TEST_MIGRATION_DATABASE_URL`    | Migration role for an independently disposable test database; consumed only by `prisma.test.config.ts`.                                                 |
| `TEST_DATABASE_URL`              | Restricted integration-test role on the disposable test database.                                                                                       |
| `TEST_DATABASE_MARKER`           | UUID provisioned by a human for that exact disposable database and verified against its database comment before fixture writes.                         |
| `NODE_ENV`                       | Production CLI uses `.env.production`; other migration commands load `.env.migrations.local`. Test scripts use `test`.                                  |

The library never loads dotenv files automatically. The API loads its runtime environment and calls
`loadDatabaseConfig` before accepting traffic. The CLI loads its dedicated environment without
sourcing shell commands. Production CLI ignores `DIRECT_DATABASE_URL` and `SHADOW_DATABASE_URL`; pass
migration-role credentials as `DATABASE_URL` through a protected environment, never the API process.

## Local development and Prisma commands

Provision separate `akiba_dev`, `akiba_shadow` and `akiba_test` databases and distinct least-privilege
runtime (`akiba_app`), migration (`akiba_migrator`) and test (`akiba_test`) roles. A database owner must
provision extensions and grants deliberately. Examples are fictional and create no default passwords.

Schema-only checks require a syntactically valid CLI URL but do not connect to PostgreSQL:

```bash
npm run prisma:format
npm run prisma:validate
npm run prisma:generate
npm run typecheck
npm run build
```

For a reviewed, dedicated local development database, inspect status and deploy committed migrations:

```bash
npm run migration:status
npm run migration:deploy
```

To prepare a **future** schema change, edit the canonical schema, then create SQL for review:

```bash
npm run migration:create -- --name describe_schema_change
```

`migration:create` runs `prisma migrate dev --create-only`: it still needs a development connection
and a disposable shadow database and may offer a reset when drift exists. Never use it against an
unknown or production database. Review generated SQL, locks, constraints, privileges and compatibility
before testing or deploying. Never use production `db push` or automatic startup migrations.

## Migration strategy and recovery

Persistent deployment status could not be verified during this cleanup. The existing production
workflow and historical repair migrations are reasons to treat all inherited migration SQL as
potentially applied. All 25 inherited SQL files and `migration_lock.toml` remain byte-for-byte unchanged;
`test/unit/migration-history-checksums.json` records their checksums. No baseline, squash, reset,
checksum rewrite or live database operation is part of the cleanup.

`20261110120000_retire_legacy_commercial_models` is a manually authored, forward-only migration that
removes eight obsolete commercial tables, their constraints/indexes/triggers, nine enum types and eight
trigger functions. These are customer plan registrations, associated financial records and delivery
records, rather than organization access memberships. Their original object definitions and names
remain **only in immutable migration history and the retirement SQL**, as required for safe replay.
They are absent from the active Prisma schema, client API and business tests.

Before deployment, the database owner must confirm the target and migration status, stop old writers,
review dependencies and take a backup with a tested restore path. The migration takes exclusive locks
with a 10-second lock timeout and 60-second statement timeout. It locks all eight tables before
checking them, disables RLS filtering for the emptiness check (or fails if the role cannot bypass it),
and **refuses to proceed if any table contains even one row**, including audit or financial evidence.
It uses restrictive drops, retains shared extensions and leaves identity, authorization, onboarding,
session and security-audit objects intact. Unexpected dependencies cause a transaction rollback.

A populated target requires a separate human-approved archival and retention plan before retirement.
Do not truncate records, bypass the guard or weaken audit protections. An unused new database can
replay the complete chain, including retirement; retaining the chain prevents checksum conflicts on
existing environments. A new baseline can be considered only after deployment inventory proves it safe.

If retirement fails, its DDL rolls back. Investigate the reported data, lock or dependency problem;
Prisma may record a failed migration that the database owner must inspect and resolve as rolled back
before retrying unchanged SQL. Do not mark unapplied changes as applied. After success, prefer a forward
fix. Restoring old client code alone cannot restore dropped tables. Coordinate compatible clients and
an approved database restore or forward repair; do not deploy old commercial clients afterward.

The package identity is now `@nexcoderw/akiba-db@0.2.0`. Removing generated models is a breaking contract
change from the inherited pre-1.0 library. Publish only after migration review and verification, and
pin the exact version in `akiba-api`. No package publication or Git push occurs automatically.

## Validation and testing

Run after installation and client generation:

```bash
npm run prisma:validate
npm run format:check
npm run lint
npm run typecheck
npm run test:unit
npm run build
node --input-type=module -e "await import('./dist/index.js')"
npm pack --dry-run --ignore-scripts
```

Unit coverage includes configuration validation/redaction, module exports, parameterized tenant
transactions and initialization failures, foundation schema contracts, onboarding repair SQL,
database test safety, branding, immutable migration checksums and the guarded retirement contract.
The identity audit includes hidden tracked files, new nonignored files and filenames. It inspects npm
project metadata while excluding unrelated third-party integrity hashes and dependency metadata.

CI runs schema validation, generation, formatting, linting, type checking, unit tests, build and compiled
export loading. It does not connect to a database, publish packages or deploy migrations. PostgreSQL
integration tests require independent provisioning and are not silently counted as passing in CI.

### Disposable PostgreSQL integration tests

A human database owner must independently verify a disposable target, create a unique marker UUID,
and set the comment on **that database only**, using the same UUID in `.env.test.local`:

```sql
COMMENT ON DATABASE akiba_test IS
  'akiba:disposable-integration-test:00000000-0000-4000-8000-000000000000';
```

The UUID shown is a placeholder, not a reusable marker. The suite never creates a marker or provisions
its own trust. A database copied from another target needs a new marker. Never use production-derived
data. The rebranded marker prefix deliberately requires re-provisioning an existing disposable target.

Use a test role with `NOSUPERUSER`, `NOCREATEDB`, `NOCREATEROLE`, `NOREPLICATION` and `NOBYPASSRLS`;
it must not own the database/tables or inherit schema creation or migration privileges. The owner
reviews effective grants including `PUBLIC` and inherited roles. The restricted test connection must
have no DDL rights and must differ from runtime/migration/shadow identities. Test-only provisioning:

```sql
REVOKE CREATE ON DATABASE akiba_test FROM PUBLIC, akiba_test;
REVOKE CREATE ON SCHEMA public FROM PUBLIC, akiba_test;
GRANT CONNECT ON DATABASE akiba_test TO akiba_test;
GRANT USAGE ON SCHEMA public TO akiba_test;
```

After reviewing the target and migration SQL, deploy using the separate test migration credential:

```bash
npm run migration:test:deploy
```

Then, through the disposable database owner's connection, grant only the test tables used by the
suite. These teardown privileges are exclusively for disposable tests, never runtime accounts:

```sql
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  public.users, public.password_credentials, public.platform_staff,
  public.platform_roles, public.platform_permissions, public.platform_staff_roles,
  public.platform_role_permissions, public.platform_admin_sessions,
  public.platform_totp_credentials, public.platform_recovery_codes,
  public.platform_mfa_challenges, public.organizations, public.organization_memberships,
  public.organization_roles, public.organization_membership_roles,
  public.organization_owner_invitations, public.organization_ownership_audit_events,
  public.organization_owner_invitation_deliveries,
  public.organization_owner_enrollment_challenges,
  public.organization_owner_acceptance_audit_events, public.owner_sessions,
  public.organization_audit_events, public.platform_authorization_audit_events
TO akiba_test;
```

Run the suites:

```bash
npm run test:integration
npm test
```

Local scripts load `.env.local` and `.env.test.local` using Node's env-file support. Alternatively,
`npm run test:integration:managed` uses an explicitly injected environment with no dotenv files.
Never inject the migration credential into a test runner.

The guard verifies the connected database name, role, exact database comment and effective
administrative privileges before fixture writes or cleanup. URL comparisons reject common aliases,
shared targets, reused roles and obvious production names, but those heuristics do not prove isolation.
Tests fail when configuration or provisioning is missing. Fixture cleanup targets only reserved UUIDs,
handles partial setup and preserves unrelated sentinel records. Integration coverage exercises actual
constraints, competing writes, onboarding integrity, rollback, pooled tenant context and the final
migrated table set; it is not proof of RLS authorization.

## Security boundaries and planned work

- **Tenant isolation is incomplete.** No migration enables PostgreSQL RLS or creates policies. Composite
  tenant foreign keys protect many relationships, but ordinary queries can access multiple tenants if
  their connection privileges permit it. `TenantTransactionService` prepares context only. The future
  API must authenticate, authorize live organization/user/membership state and scope every read/write,
  nested relation and raw query. A subdomain or caller-supplied UUID is never authorization.
- **Tenant resolution is planned.** Unique lowercase slugs, reserved-name checks and lifecycle states
  exist. `admin.akiba.com`, `musomesa.akiba.com` and `companyb.akiba.com` illustrate planned routing.
  Verified domain ownership, DNS/certificate handling, collision policy and trusted hostname resolution
  need dedicated implementation. Branch context is retained as a utility; no Branch model exists.
- **Authorization is partial persistence.** Platform permissions are explicitly mapped through roles;
  organization custom roles and assignments exist without a permission catalog or grants. Superadmin
  bootstrap, trusted system roles and platform operations require explicit approval, separate
  interfaces and auditing. `isSystem`, `owner`, active status or login alone confer no effective access.
- **Authentication flows belong to the API.** Stored password hashes, session digests, encrypted TOTP
  factors, recovery-code digests and MFA challenge attempts are infrastructure, not working login,
  logout, MFA or account recovery. Implement approved hashing, replay prevention, conditional one-time
  consumption, revocation and fresh authorization checks before exposing traffic.
- **Onboarding remains security-sensitive.** Delivery records contain erasable encrypted token and
  email snapshots, worker leases, bounded retries and uncertain provider outcomes. Encryption keys
  stay outside PostgreSQL. Never blindly resend an uncertain delivery. Enrollment proof must bind the
  exact recipient/invitation/organization and consume atomically with membership, role and audit writes.
  Successful provider acceptance is not proof of email delivery or user identity.
- **Grants are an operational prerequisite.** This package supplies one configured connection and
  does not provision deployment roles. Separate platform identity access, tenant runtime DML,
  read-only operations and DDL privileges. Runtime accounts must not own tables, create schema objects,
  bypass RLS or modify/delete audit history. Audit timestamps/operator identities have SQL protection;
  append-only access also depends on reviewed grants and is not universally trigger-enforced.
- **Sensitive data requires lifecycle policy.** Require hosted TLS and encryption at rest; keep secrets
  in managed storage, parameterize queries, redact connection URLs and personal data, and review
  retention/erasure for credentials, sessions, encrypted delivery material, audit events and backups.
  Soft deletion is not erasure. Store timestamps in UTC; use `Africa/Kigali` only for display/scheduling.

The next database phase should define the organization permission catalog and grants, trusted
superadmin provisioning, live authorization invariants, tenant-safe relationship rules and fail-closed
RLS policies tested under actual non-owner roles. Keep platform and organization privilege boundaries
explicit. Add domain ownership and tenant resolution separately, then introduce inventory models in
reviewed increments after isolation and authorization are established.

## Consuming from akiba-api and release control

Install an exact published version after setting up GitHub Packages authentication:

```bash
npm install --save-exact @nexcoderw/akiba-db@0.2.0
```

Register the module once and enable Nest shutdown hooks in the API:

```typescript
import { Module } from '@nestjs/common';
import { DatabaseModule, loadDatabaseConfig } from '@nexcoderw/akiba-db';

@Module({
  imports: [DatabaseModule.forRoot(loadDatabaseConfig())],
})
export class AppModule {}
```

The API owns environment loading and must enable `app.enableShutdownHooks()` during bootstrap. Use one
pool per process. Do not run migrations or client generation inside the API. For a tenant operation,
prove organization access before calling the transaction service and use only the supplied transaction
client with explicit organization scope. Keep network calls outside transactions.

The inherited SSH production deployment script and job were removed because their host, OS user,
paths and release cleanup belonged to a different deployment. Future Akiba deployment requires an
explicit target, protected approval, least-privilege credentials, reviewed SQL, backup and restore
verification. Package checks alone do not authorize a production migration.

Automated contributors must read [AGENTS.md](AGENTS.md), [.agents/README.md](.agents/README.md) and all
applicable topic rules. Their default workflow restricts command execution and Git writes unless a
human task explicitly overrides it. This cleanup task authorizes verification; it does not authorize
production changes, publication, commits or pushes.
