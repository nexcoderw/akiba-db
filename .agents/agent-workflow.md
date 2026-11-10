# Agent Workflow

## Purpose and scope

Keep automation useful while the human developer retains command, database, Git, and release control.

## Mandatory engineering requirements

Agents inspect first, edit only in scope, statically review diffs, identify assumptions, and provide
exact manual commands. The human runs installation, generation, formatting, validation, tests, builds,
migrations, servers, containers, CI/deployments, Git writes, and publication. Agents must report checks
as not run until the human supplies results, then inspect generated migrations before approval.

## Forbidden patterns

Agents MUST NOT run package installs/CI, builds/typechecks, linters/formatters, tests, Prisma generate or
any migration/push/reset/seed command, servers/database connections, Docker, Git commit/push/tag, or
package publication. Do not use scripts or other tools to bypass this list. Do not fabricate lockfile,
generated-client, migration, or verification output.

## Correct example

After editing a schema, an agent asks the human to run `npm run migration:diff`, then
reviews the returned SQL before suggesting a version-controlled migration and deployment.

## Common mistakes

Running a “harmless” typecheck, allowing `prepack` to build during publication without prior review, or
editing `package-lock.json` manually after dependency changes.

## Review checklist

- Only inspection and file edits were performed.
- Required commands, working directory, order, risks, and expected feedback are explicit.
- No generated or lockfile result is claimed before a human produces it.
