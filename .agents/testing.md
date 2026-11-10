# Testing

## Purpose and scope

Verify configuration, lifecycle, constraints, migrations, transactions, exports and isolation claims.

## Mandatory engineering requirements

Keep default/unit tests offline. Preserve PostgreSQL integration suites with synthetic, UUID-scoped
fixtures, failure cases, transactions, races and parent-ordered cleanup. Integration uses only the
approved development Neon branch through the guarded serial runner. Verify pooled/direct identity,
live database/user, an exclusive session advisory lease and exact completed migration checksums before
any fixture write. Refuse startup when other database clients exist; the operator must keep application
workers and other writers stopped for the run. Each suite verifies the live coordinator before gaining
fixture cleanup capability. Fail, never silently skip, missing prerequisites.

The managed owner is intentionally used; these tests cannot demonstrate least-privilege/RLS isolation.
Never claim a database test ran without executed results. Preserve useful blocked tests and explain
missing credentials, connectivity, exclusive access or migration prerequisites accurately.

## Forbidden patterns

No production or production-derived data, extra database environments, database comments/markers,
custom users, schema-changing tests, table-wide cleanup, parallel test processes or granting privileges
to make a failure disappear. No snapshots of real customer data or mocked constraint enforcement.

## Correct example

Within a development maintenance window, the runner holds its direct-session advisory lease while
serial suites create fictional Kimihurura records and clean only reserved UUIDs. A second runner fails.

## Common mistakes

Running Jest integration projects directly, trusting only NODE_ENV, accepting unsynchronized migration
history, assuming an advisory lease stops uncooperative application connections, or claiming owner-role
constraint tests prove tenant read isolation.

## Review checklist

- Offline tests and live database tests remain separate and meaningful.
- Approved development target, live identity, lease and migration history verified before writes.
- Scoped cleanup, rollback, partial failures, concurrency and connection closure remain covered.
