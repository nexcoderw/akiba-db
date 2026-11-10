# Akiba Database

`@nexcoderw/akiba-db` is the canonical PostgreSQL schema, migration history and NestJS database library
for Akiba, an enterprise multi-tenant inventory SaaS foundation. The future `akiba-api` owns HTTP,
authentication flows, effective authorization and business operations. Consumers install an exact
package version and import its root API; they do not copy schemas or run migrations at application startup.

## Current foundation and scope

The schema retains 23 foundation models and 14 enums: global users and password credentials;
platform staff, roles and permissions; platform sessions, encrypted TOTP, recovery codes and MFA
challenges; organizations with unique slugs/lifecycle; organization access memberships, roles and
assignments; owner invitations, encrypted delivery, enrollment and acceptance records; owner sessions;
and organization/platform/ownership audits. SQL preserves restrictive relations, tenant-composite
foreign keys, scoped indexes, integrity checks, audit timestamps and onboarding guards.

`DatabaseModule`, `PrismaService`, `loadDatabaseConfig` and `TenantTransactionService` remain public.
Prisma has one lifecycle-managed pool per registered module. Tenant transactions parameterize
`app.current_organization_id` and `app.current_branch_id` locally to the transaction, clearing them
on commit/rollback. UUID validation is not authorization. There is no Branch model or RLS policy.

Inventory models, warehouses, stock movements, products, suppliers, sales, organization permission
mappings, verified custom domains and full tenant authorization remain planned. No seed, default
administrator, application server or frontend is supplied. Commercial customer plans, subscriptions,
payments and reminders were retired from the active schema in Task 001.

## Technology and layout

Use npm 10+ and Node.js `^20.19.0 || ^22.12.0 || >=24.0.0` (CI uses Node 22). Actual dependencies are
Prisma 7, `@prisma/adapter-pg`, `pg`, strict TypeScript/NodeNext ESM, NestJS 11 peers, Jest/ts-jest,
ESLint and Prettier. Neon supports standard PostgreSQL clients; the existing adapter is retained.
The historical chain requires PostgreSQL `citext` and `btree_gist` extension support.

```text
.agents/                      mandatory engineering rules
.github/workflows/            offline package verification
neon.environments.json        approved non-secret branch endpoint identities
prisma/schema.prisma          canonical models and enums
prisma/migrations/            immutable SQL history
prisma.config.ts              guarded direct datasource or offline schema commands
scripts/                      environment validation, migration and integration runners
src/config/                   immutable runtime configuration
src/database/                 Nest lifecycle and tenant transactions
src/types/                    database contracts
src/generated/prisma/         ignored Prisma-generated TypeScript
src/index.ts                  package root exports
test/unit/                    offline tests, schema/SQL and safety contracts
test/integration/             development-only PostgreSQL suites and scoped fixtures
```

Generation writes ignored client sources, then build compiles them and authored TypeScript to `dist/`
with declarations. Only `dist/` and README ship in the package. CLI scripts and branch approvals belong
to this repository, not the published runtime library. No dependency or adapter replacement is required.

## Exactly two Neon environments

Use the existing default database and Neon-managed owner in exactly two persistent branches:
`development` and `production`. Do not provision extra databases or custom PostgreSQL users/roles.
Keep development synthetic and independent of real organization data; never copy production rows into it.
No Neon console/API resource is created or modified by these scripts.

Only two templates are tracked:

- `.env.local.example` → ignored `.env.local` for development.
- `.env.production.example` → optional ignored `.env.production` for production.

Each contains `NODE_ENV`, `DATABASE_URL` and `DIRECT_DATABASE_URL`. The pooled URL serves runtime
queries; the direct URL serves administrative commands. They must use the **same database and managed
owner/password on the same branch**, not independent resources. Copy exact Neon connection strings;
placeholders do not provision anything. TLS is required. Optional Neon `channel_binding=require` is
accepted. Routing overrides and duplicate/unsupported URL options are rejected by repository tools.
Runtime also supports `DATABASE_POOL_MAX` (default 10 per process) and
`DATABASE_CONNECTION_TIMEOUT_MS` (default 10000); both must be positive integers.

```bash
# From api/db in this workspace, or the standalone repository root:
npm ci
cp .env.local.example .env.local
```

Fill the two URLs privately. Then an operator must verify each branch in Neon and fill
`neon.environments.json` with its direct hostname, default database and existing managed username.
Connected commands fail until both distinct endpoints are approved; a blank hostname means that branch
has not been approved. Pooled and direct hosts from one URL pair identify the same branch and cannot
fill both entries. This file contains identities, never passwords or complete connection URLs. It prevents
a production URL mislabeled as development (or the reverse) from being accepted. Protect review of
this trust configuration; it is not a live Neon API attestation and must be updated when endpoints change.

Development tools load only `.env.local`. Complete injected development credentials are also supported;
conflicting injected/local values fail. Production tools require an already injected
`NODE_ENV=production`, load only the optional `.env.production`, and accept a complete injected URL
pair without any physical file. Injected production credentials take precedence; partial pairs or
mixed identities fail. No connection URL fallback exists. The runtime library loads no dotenv files;
`akiba-api` must load its selected environment and validate before accepting traffic.

## Offline validation and client generation

No credentials, environment file, fabricated URL or live database is required:

```bash
npm run prisma:format
npm run prisma:validate
npm run prisma:generate
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
node --input-type=module -e "await import('@nexcoderw/akiba-db')"
```

`npm test` and `npm run test:unit` run only the offline unit project. CI validates/generates, checks
formatting/lint/types, runs unit tests, builds and loads compiled exports. CI has no database secrets,
provisioning, automatic migration, publication or deployment job.

## Shadow-free migration workflow

The installed Prisma 7.10 CLI supports a current-datasource-to-schema diff without provisioning another
database. All connected scripts validate the selected branch before invoking Prisma. Only reviewed
status, datasource/schema diff and deploy operations are supported by this configuration.

1. Start a controlled development window, confirm approved endpoints, and run status plus a drift
   check **before** editing the schema:

   ```bash
   npm run migration:status
   npm run migration:check
   ```

2. With history synchronized, edit `prisma/schema.prisma`, validate it, and draft SQL:

   ```bash
   npm run prisma:validate
   npm run --silent migration:diff > /tmp/akiba-change.sql
   ```

   Check the exit status before using the output. The wrapper verifies migration status first and
   routes its diagnostic output to stderr, keeping stdout for SQL. Internally it uses
   `prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script`.
   It does not execute the SQL. Review destructive statements, locks, data backfills and compatibility.

3. Manually create a new `prisma/migrations/<UTC timestamp>_<snake_case_description>/migration.sql`
   containing the reviewed SQL. Add/review custom SQL for CHECK constraints, partial indexes, RLS,
   functions, triggers and other features Prisma does not fully represent. A clean Prisma diff cannot
   certify those controls. Never pipe the draft into execution or rewrite applied SQL.

4. Apply only committed/reviewed migrations to development, then verify:

   ```bash
   npm run migration:deploy
   npm run migration:status
   npm run migration:check
   npm run prisma:validate
   npm run prisma:generate
   npm run test:integration
   ```

`migration:check` uses `--exit-code`: 0 means no Prisma-supported schema difference, 2 means a
difference, 1 means an error. It checks history status first. It is a schema comparison, not full
migration replay or complete manual-SQL drift detection. Review custom objects separately using
catalog queries and the retained integration tests. This two-environment workflow does not prove
fresh replay unless an independently authorized environment/resource is available; none is created.

### Production deployment and recovery

Use a protected deployment process with explicit human approval, target verification, compatible
clients, a restorable backup and SQL/lock review. Inject production secrets; do not put URLs in commands:

```bash
NODE_ENV=production npm run migration:production:status
NODE_ENV=production npm run migration:production:deploy
NODE_ENV=production npm run migration:production:status
NODE_ENV=production npm run migration:production:check
```

A pending migration makes status nonzero; inspect the pending list rather than treating this as drift
proof or bypassing a failed migration. Deployment applies tracked pending SQL using Prisma's normal
migration locking. The repository does not grant approval, invoke deployment automatically, reset
schema/data or provision PostgreSQL roles. Do not overlap migration operations with integration tests.
After failures, inspect the exact migration record and transaction outcome, then use reviewed forward
recovery. Never falsely resolve unapplied SQL as applied or change historical checksums.

All inherited migration SQL, including the Task 001 retirement, remains unchanged. The retirement is
still guarded: it locks all eight retired commercial tables and aborts if any rows exist, including
financial/audit records. Unexpected dependencies also abort. A populated target requires a separate
approved archival/retention plan; do not bypass its guard. Historical references to former disposable
validation infrastructure remain only in immutable SQL comments to avoid checksum conflicts.

## Integration tests on development

All ten useful integration suites are retained. Run them only during an **exclusive synthetic
development maintenance window** after stopping applications, workers and other clients:

```bash
npm run test:integration
```

The runner refuses production and unexpected arguments, validates the approved pooled/direct pair,
opens a direct coordinator session, checks actual database/user, acquires a session advisory lease,
refuses other existing client sessions and verifies every local migration's completed checksum. It
then launches Jest serially. Every suite verifies the live coordinator/lease through its actual Prisma
connection before fixture writes or cleanup. Direct Jest invocation lacks this coordinator and fails.
A second cooperating runner cannot start. Coordinator connection loss terminates the child runner.
The coordinator PID is transient process coordination, not persistent database data or a new configured
connection/marker. Nothing is provisioned, and migrations are never applied automatically by tests.

Fixture writes use reserved UUIDs and synthetic example-domain identities. Cleanup is restricted to
those exact fixtures and ordered through restrictive references; rollback, partial setup, concurrency
and sentinel-preservation coverage remains. These tests intentionally commit some temporary fixture
rows to test races and persistence, so they cannot all run inside one rollback transaction. A stopped
process can leave tracked synthetic records requiring deliberate, scoped recovery; never blanket-delete.

The advisory lease coordinates test runners, not uncooperative applications or administrators. Keep the
maintenance window exclusive for its entire duration; the startup session check cannot stop a later
application connection. If this cannot be ensured, keep the integration run blocked. Missing credentials,
endpoint approvals, access, synchronized migrations or exclusive access is a failure, never a silent skip.

## Tenant isolation and owner-role limitations

The managed Neon owner is used for both runtime and administrative connections as requested. No custom
role/user provisioning or replacement grants are introduced. Existing PUBLIC revokes, integrity
constraints, transaction handling, tenant-composite relationships and audit controls remain.

**Complete organization isolation is not implemented or verified.** No migration enables RLS, creates
policies or forces RLS. The current `TenantTransactionService` establishes context only; it does not
restrict a broad query. Ownership commonly bypasses RLS, and Neon managed administrative membership can
include BYPASSRLS. FORCE RLS does not constrain a BYPASSRLS identity. Default-owner use also permits DDL
and audit mutation beyond a least-privilege runtime account. These are acknowledged production-security
limitations, not fixed by simpler environment files or passing owner-based constraint tests.

Before enabling live tenant traffic, verify actual role attributes/memberships, table ownership,
`relrowsecurity`, `relforcerowsecurity` and `pg_policies`, then implement a reviewed enforceable
isolation design compatible with the chosen identity. `akiba-api` must authenticate and authorize live
user, membership, organization and permission state, scope every query/nested relation/write and audit
privileged work. A slug, subdomain, header, UUID or active status alone is not authorization. Subdomains
such as `musomesa.akiba.com` and platform routing at `admin.akiba.com` remain planned, including domain
ownership verification. Never expose owner credentials to a tenant or browser.

Password/session/MFA/enrollment rows are persistence, not complete authentication flows. Protect
password hashes, token digests, encrypted invitation/email material and MFA keys; consume one-time proof
atomically and reconcile uncertain provider outcomes without blind resend. Preserve TLS, managed
secrets, redacted logging, UTC timestamps, bounded queries and short transactions. Retention/erasure
policies for identities, encrypted delivery data, audits and backups still need dedicated review.

## Task 001 audit and remaining verification

| Requirement                                                                           | Status after repository inspection                    |
| ------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Akiba package/repository identity and authored branding                               | PASS                                                  |
| Commercial-domain removal from active schema/client                                   | PASS                                                  |
| Reusable organization, identity, roles, MFA, sessions, onboarding and audits retained | PASS                                                  |
| Tenant transaction context and composite relationship safeguards retained             | PASS                                                  |
| Schema/migration files preserved through Task 002                                     | PASS                                                  |
| Tenant isolation as a complete production security boundary                           | PARTIAL: no RLS or complete authorization enforcement |
| Migration replay, applied status and populated-target retirement                      | NOT VERIFIED without approved Neon access             |
| Actual Neon role ownership/privileges and production readiness                        | NOT VERIFIED                                          |

Unit, type, lint, build and package verification must be reported from executed results; this table
never substitutes for a live deployment audit. Task 002 changes no models, enums or migration SQL.
The next phase should first verify development migration/SQL integrity, then implement organization
permission mappings, trusted administrator provisioning and enforceable tenant authorization before
introducing inventory features.

## Consuming and contributing

After a separately verified release, `akiba-api` pins `@nexcoderw/akiba-db@0.2.0`, loads its runtime
pooled `DATABASE_URL`, registers `DatabaseModule.forRoot(loadDatabaseConfig())` once and enables Nest
shutdown hooks. Consumers receive generated client code and declarations without generation. Package
rollback cannot recreate retired tables; coordinate compatible clients and reviewed database recovery.

Read [AGENTS.md](AGENTS.md) and [.agents/README.md](.agents/README.md) before changes. Default agent
command/Git restrictions remain unless a human task explicitly authorizes verification. No commit,
push, publication, resource provisioning or production change is automatic.

Technical references: [Prisma 7 CLI](https://www.prisma.io/docs/orm/v7/reference/prisma-cli-reference),
[PostgreSQL/Neon compatibility](https://www.prisma.io/docs/orm/v7/core-concepts/supported-databases/postgresql),
[Neon connections](https://neon.com/docs/guides/prisma),
[Neon managed roles](https://neon.com/docs/manage/roles), and
[PostgreSQL row security](https://www.postgresql.org/docs/current/ddl-rowsecurity.html).

## Tenant security diagnostics

Human-only, read-only diagnostics on the existing approved development branch:

```bash
npm run security:tenant:audit
```

The command reuses the guarded pooled/direct environment approval, verifies the connected database
and managed user, opens a read-only transaction and reports role attributes/memberships, table owners,
RLS/FORCE RLS activation, policies and table privileges. It creates no role, database, schema or policy
and accepts no production target/arguments. Exit 2 means the observed configuration blocks a database
isolation claim; exit 1 means diagnostics failed. Even active RLS requires independent policy review.
No diagnostic result has been produced during implementation.

Configuration failures identify the missing approval or invalid setting without printing URLs or
passwords. Known connection failures report a safe category; raw driver messages remain private.
If production is still unapproved, supply its independently verified direct hostname before retrying;
never reuse the development hostname to satisfy the guard.

TenantTransactionService now captures validated IDs before scheduling and rejects nested calls in an
asynchronous chain. Reuse the existing callback client instead of opening another tenant scope.
Concurrent independent calls remain supported. These changes do not add RLS or authorize identities;
API membership and explicit query predicates remain mandatory. Existing live rollback/pool and
composite-relationship suites are retained under the guarded development runner. After human checks
and committing these fixes, update the API CI database revision before releasing either package.
