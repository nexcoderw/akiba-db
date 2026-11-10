# Database Engineering Rules

## Purpose and scope

These rules govern all human and automated work in `@nexcoderw/akiba-db`. Human instructions rank
first, then `AGENTS.md`/`CLAUDE.md`, this index, the topic rules below, and tool defaults. When rules
appear to conflict, choose the safer database, privacy, and migration interpretation and ask a human.

## Mandatory requirements

Read the topic rule before touching its area: `git.md`, `folder-structure.md`, `file-naming.md`,
`code-quality.md`, `typescript.md`, `comments.md`, `prettier.md`, `prisma.md`,
`database-design.md`, `migrations.md`, `tenant-isolation.md`, `security.md`, `environment.md`,
`package-management.md`, `performance.md`, `testing.md`, `documentation.md`, `error-handling.md`,
`privacy.md`, and `agent-workflow.md`. Database schema and migration ownership never moves to an API.

## Forbidden patterns

- HTTP controllers, transport DTOs, authentication endpoints, billing or membership workflows.
- Duplicate schemas in consumers, production `db push`, credentials, or unreviewed seed data.
- Bypassing a topic rule because a tool can perform the action.

## Correct example

An API feature needing a column first proposes a reviewed schema change here, then consumes a new
immutable package version after the migration is approved.

## Common mistakes

Treating this package as a deployable server, assuming Prisma supplies tenant authorization, or
running a convenient command prohibited by `agent-workflow.md`.

## Review checklist

- Relevant topic rules were read and followed.
- Work remains database-library scoped.
- Human approval and command boundaries remain explicit.
