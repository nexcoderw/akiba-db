# Security

## Purpose and scope

Protect credentials, tenant boundaries, database integrity and operational access on Neon.

## Mandatory engineering requirements

Use the existing Neon-managed owner as explicitly selected for the two-branch architecture. Do not
provision custom runtime, administrative or test roles. This is an acknowledged privilege-separation
limitation: ownership and Neon administrative privileges can bypass RLS; FORCE RLS does not constrain
BYPASSRLS. Never claim owner-based tests prove tenant authorization or production readiness.

Preserve parameterized SQL, restrictive relations, audit integrity, transaction-local tenant context,
TLS, protected secrets, redacted errors, dependency review and human-controlled production deployment.
The API must establish trusted authorization and scope every tenant operation. No role simplification
may silently remove a policy or weaken a constraint. Inspect live privileges/policies before making
claims about effective isolation; database credentials never go to end users.

## Forbidden patterns

No committed secrets, unsafe raw SQL, dynamic identifiers, public exposure, production data in tests,
unscoped tenant queries, fabricated security verification or implicit administrator grants. No custom
role provisioning or blanket grants to bypass a failure.

## Correct example

Document that the managed-owner connection preserves SQL constraints and tenant context but is not a
least-privilege isolation boundary. Require a dedicated reviewed authorization/RLS design before traffic.

## Common mistakes

Treating enabled RLS as effective for an owner/BYPASSRLS connection, logging connection strings or
assuming the endpoint registry proves Neon branch ownership without operator verification.

## Review checklist

- Privilege limitations and unverified live state are explicit.
- Credentials, TLS, SQL, tenant context, integrity and audit controls remain protected.
