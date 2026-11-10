# Testing

## Purpose and scope

Verify configuration, lifecycle, constraints, migrations, transactions, exports, and isolation.

## Mandatory engineering requirements

Keep fast unit tests separate from integration tests. Integration tests use a disposable PostgreSQL
database through `TEST_DATABASE_URL`, run migrations first, verify a human-provisioned database marker
before writes, isolate state, and close connections. A different URL alone does not prove isolation.
Cleanup must target explicitly tracked fixture identifiers and preserve unrelated records; table-wide
cleanup is forbidden. Test both success and failure paths, tenant A versus tenant B,
uniqueness/foreign keys, rollback, and package exports. Never claim a check ran without captured
human-provided results.

## Forbidden patterns

No production/shared databases, privileged test users, real personal data, order-dependent tests,
mocked constraint tests, blanket snapshots, unrestricted cleanup, or silent integration success when
the database was not configured and independently verified.

## Correct example

Verify the disposable database marker, insert fictional Kimihurura Supplies tenants with reserved
fixture IDs, and prove Kimihurura context cannot access Remera records belonging to another organization.

## Common mistakes

Testing only Prisma validation instead of PostgreSQL enforcement, trusting URL string inequality,
granting the test user schema privileges, or deleting rows not created by the current fixture set.

## Review checklist

- Unit and integration scope is appropriate; fixtures are fictional and explicitly tracked.
- Marker verification happens before writes, using a non-administrative test role.
- Isolation, scoped cleanup, partial failures, repeatability, and connection lifecycle are covered.
