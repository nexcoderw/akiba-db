# Environment

## Purpose and scope

Keep local, test, staging, and production configuration explicit and isolated.

## Mandatory engineering requirements

Runtime requires `DATABASE_URL`; migration commands may use `DIRECT_DATABASE_URL`, and development may
use `SHADOW_DATABASE_URL`. Tests require a disposable `TEST_DATABASE_URL`, a dedicated restricted
database user, and a human-provisioned `TEST_DATABASE_MARKER` verified through the live connection
before writes. Validate at startup, use `.env.example` only for fake examples, and keep production
values in managed secrets. Use UTC database time and `Africa/Kigali` only for business
presentation/scheduling.

## Forbidden patterns

No defaults that connect to shared or production databases, checked-in `.env`, environment guessing,
reusing a production database as a shadow/test database, automatically creating a test safety marker,
or treating different URL strings as proof of isolation.

## Correct example

Local Kimihurura Supplies examples use fake credentials, a restricted test role, and an independently
marked `akiba_test` database.

## Common mistakes

Using a pooled URL for DDL, relying on Node to auto-load `.env`, sharing runtime and test roles, or
silently falling back after a missing variable or database marker.

## Review checklist

- Each variable’s consumer and environment are documented.
- Missing or invalid required settings fail before traffic is accepted.
- Test execution verifies the connected database marker and effective role privileges before writes.
