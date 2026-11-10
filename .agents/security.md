# Security

## Purpose and scope

Protect credentials, database privileges, queries, and operational access.

## Mandatory engineering requirements

Use separate least-privilege runtime, migration, and read-only operational roles. Source credentials
from secret management, require TLS in hosted environments, parameterize SQL, rotate secrets, redact
errors/logs, review dependencies, and audit privileged actions. Production schema privileges belong
only to the migration role.

## Forbidden patterns

No committed secrets, superuser runtime accounts, credentials in commands or logs, unsafe raw SQL,
dynamic identifier interpolation, public database exposure, or production data in local tests.

## Correct example

`akiba_app` receives DML on approved schemas but cannot create or alter tables; `akiba_migrator` is used
only during an approved migration window.

## Common mistakes

Embedding passwords in `.npmrc`, logging a full connection URL, or granting broad privileges to fix a
single migration problem.

## Review checklist

- Secrets, roles, network path, TLS, SQL parameterization, and logging are safe.
- New permissions are minimal and documented.
