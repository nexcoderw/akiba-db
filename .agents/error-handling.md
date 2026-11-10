# Error Handling

## Purpose and scope

Expose useful database failure categories without leaking sensitive implementation details.

## Mandatory engineering requirements

Fail configuration early. Preserve original errors internally, map known Prisma/PostgreSQL constraint
failures to stable database-layer categories only when consumers benefit, and let `akiba-api` decide HTTP
responses. Log correlation and safe metadata, never queries with secrets or personal data. Roll back
failed transactions and make retry decisions explicit and bounded.

## Forbidden patterns

No swallowed errors, blanket catch-and-rethrow, HTTP exceptions in this package, raw database messages
to users, infinite retries, or exposing connection URLs.

## Correct example

The package may report a stable unique-constraint category; the API chooses whether that becomes a
409 response based on its business context.

## Common mistakes

Converting every error to “database unavailable,” retrying constraint failures, or losing the error
cause needed for operations.

## Review checklist

- Error boundaries, rollback, retryability, logging, and consumer responsibility are clear.
- Messages contain no credentials or personal data.
