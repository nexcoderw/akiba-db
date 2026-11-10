# Environment

## Purpose and scope

Use exactly two persistent Neon branches: development and production, each with its existing default
database and managed owner. Pooled and direct URLs are two connection methods to the same target.

## Mandatory engineering requirements

Provide only `.env.local.example` and `.env.production.example`; actual files remain ignored. Runtime
uses `DATABASE_URL`; administrative workflows use `DIRECT_DATABASE_URL` for the same database/owner.
Load only the selected environment file. Accept complete injected production secrets without a file,
require explicit production selection, reject mixed credentials and verify the selected approved endpoint
in `neon.environments.json` before connected tools run. A blank production hostname does not block an
approved development command; production commands fail closed until their own endpoint is approved.
When both endpoints are approved, they must be distinct.
Use UTC storage and `Africa/Kigali` only for presentation/scheduling. Never log URLs or passwords.

## Forbidden patterns

No additional persistent environments, database provisioning, custom roles/users, connection fallbacks,
production-derived development fixtures, environment guessing or credentials in tracked files. Do not
mistake a branch label, database name or NODE_ENV alone for proof of the selected target.

## Correct example

The development pooled/direct pair matches one operator-reviewed Neon endpoint, database and managed
owner; the independently approved production endpoint differs. Approval contains no credentials.

## Common mistakes

Mixing production URLs with a development label, copying credentials into the endpoint registry, or
assuming Prisma loads `.env.local` automatically.

## Review checklist

- Exactly two environment templates and two approved persistent branch targets.
- Missing/mismatched inputs fail before connecting; production never loads local development values.
- Endpoint ownership is verified by the operator; offline schema checks require no connection.
