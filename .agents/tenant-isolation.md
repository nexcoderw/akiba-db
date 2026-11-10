# Tenant Isolation

## Purpose and scope

Prevent data access across the Platform → Organization → Branch hierarchy.

## Mandatory engineering requirements

Every tenant-owned record carries an organization foreign key; branch-owned records also carry a
branch relationship consistent with that organization. Put organization first in scoped indexes and
uniques. API authorization establishes tenant context. Use `TenantTransactionService` for future RLS
paths; settings must be transaction-local and policies must fail closed when context is missing.
Privileged platform operations require separate, explicit interfaces and audit trails.

## Forbidden patterns

No optional organization filters, unrestricted “all tenants” helpers, request-level `SET` on pooled
connections, client-supplied tenant trust, or assumption that Prisma applies tenancy automatically.

## Correct example

Find a Kimihurura branch by `{ organizationId, branchId }` inside the authenticated organization’s
transaction, even when `branchId` is globally unique.

## Common mistakes

Scoping writes but not reads, forgetting nested relation filters, or allowing a branch foreign key
that points to another organization.

## Review checklist

- Every tenant query and constraint includes organization context.
- Tests prove missing/wrong tenant context cannot return or modify records.

## Neon owner limitation

The two-branch deployment uses the existing managed owner and creates no custom PostgreSQL users.
No current migration enables RLS or creates tenant policies. Ownership and BYPASSRLS can defeat row
filtering; FORCE RLS alone does not constrain BYPASSRLS. Preserve trusted API scoping and transactional
context, and do not describe this foundation as enforcing complete tenant isolation.
