# Performance

## Purpose and scope

Keep database access predictable as organizations and branches grow.

## Mandatory engineering requirements

Use bounded pagination, tenant-leading indexes, selective projections, set-based operations, short
transactions, measured pool limits, and query-plan evidence before optimization. Prefer cursor
pagination for large mutable collections. Analyze high-impact migrations and queries using realistic
synthetic cardinality.

## Forbidden patterns

No unbounded `findMany`, N+1 loops, `SELECT *` in raw SQL, long external calls inside transactions,
unmeasured indexes, offset pagination at large depth, or per-request Prisma clients.

## Correct example

List Remera organization memberships using an organization/cursor compound index and a documented
maximum page size.

## Common mistakes

Adding separate indexes whose useful prefixes duplicate a compound index, or increasing pool size
without checking total connections across replicas.

## Review checklist

- Query shape, cardinality, index order, page bound, transaction duration, and pool budget are known.
- Performance claims include measurements or plans, not intuition alone.
