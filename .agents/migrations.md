# Migrations

## Purpose and scope

Protect Akiba's sole ordered migration history with a shadow-free Neon workflow.

## Mandatory engineering requirements

Use explicit development/production scripts with approved endpoint validation and the selected direct
connection. Check migration status and a clean schema diff before changing the schema. With development
history synchronized, compare the current development datasource to the desired canonical schema using
Prisma 7 `migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script`. Capture
successful SQL output, review it, and create a timestamped snake_case migration directory manually.
Preserve/add explicit SQL for checks, RLS, indexes, functions, triggers and other features the diff cannot
represent. Apply reviewed files using `migrate deploy`, then validate, generate and check drift again.

Use expand-and-contract, explicit backup/restore review, compatible clients and a protected human-
controlled production deployment. Keep applied SQL/checksums immutable and prefer forward recovery.
Status/diff checks do not prove manual SQL integrity or that a live deployment has been verified.

## Forbidden patterns

No database provisioning, schema resets, automatic startup migrations, production schema push, migration
history rewrites, unreviewed SQL execution or migrations owned by `akiba-api`. Do not compare migration
directories through commands requiring extra database resources. Never pipe draft SQL into execution.

## Correct example

Run `npm run migration:status`, draft a development datasource/schema diff, inspect destructive changes
and custom integrity SQL, commit the reviewed migration, then deploy it in a controlled development window.

## Common mistakes

Treating a clean Prisma diff as proof of RLS/trigger integrity, adding a migration after an unreviewed
manual change, or releasing new clients before required migrations are approved and applied.

## Review checklist

- Target selection, SQL, locks, backup, rollback/forward recovery and deployment order reviewed.
- No additional database environment, data loss or checksum changes introduced.
