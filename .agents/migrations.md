# Migrations

## Purpose and scope

Protect the sole, ordered history of Akiba database structures.

## Mandatory engineering requirements

Change `prisma/schema.prisma`, have a human generate a create-only migration, review SQL, test on an
isolated database, and commit it here. Use expand-and-contract for incompatible changes, backups for
high-risk work, and a human-controlled production deploy. Record rollback limitations and package/API
compatibility. Prefer forward fixes after deployment.

## Forbidden patterns

No production `prisma db push`, automatic startup migrations, editing applied SQL, destructive SQL
without explicit human approval, or migrations maintained by `akiba-api`.

## Correct example

Add a nullable column, deploy compatible readers/writers, backfill in controlled batches, enforce the
constraint later, then remove obsolete data in a future release.

## Common mistakes

Renaming through drop/create, trusting generated SQL without inspection, or releasing code before the
required expansion migration is deployed.

## Review checklist

- SQL, locks, runtime, backup, rollback/forward recovery, and deployment order were reviewed.
- Existing released clients remain compatible throughout the rollout.
