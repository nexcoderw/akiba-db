-- Forward-only CHECK expansion. No Prisma model or generated-client change is required.
-- Human review must confirm development status/drift and the migration lock window before deploy.
BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE public.identity_security_audit_events
  DROP CONSTRAINT identity_security_audit_events_actor_check,
  ADD CONSTRAINT identity_security_audit_events_actor_check CHECK (
    (actor_kind IN ('platform', 'bootstrap') AND actor_platform_staff_id IS NOT NULL AND actor_user_id IS NULL)
    OR (actor_kind IN ('enrollment', 'email_verification', 'authentication')
      AND actor_user_id IS NOT NULL AND actor_user_id = user_id AND actor_platform_staff_id IS NULL)
  ),
  DROP CONSTRAINT identity_security_audit_events_action_check,
  ADD CONSTRAINT identity_security_audit_events_action_check CHECK (action IN (
    'identity_created', 'email_verified', 'email_changed', 'password_created', 'password_changed',
    'password_rehashed', 'credential_disabled', 'account_suspended', 'account_reactivated',
    'account_disabled', 'credential_compromised',
    'platform_primary_authenticated', 'platform_mfa_rejected', 'platform_session_issued',
    'platform_session_revoked', 'platform_challenge_revoked'
  )),
  ADD CONSTRAINT identity_security_audit_events_authentication_check CHECK (
    (actor_kind = 'authentication') = (action IN (
      'platform_primary_authenticated', 'platform_mfa_rejected', 'platform_session_issued',
      'platform_session_revoked', 'platform_challenge_revoked'
    ))
  );

-- Existing restrictive foreign keys, append-only triggers and PUBLIC revocations are retained.
COMMIT;
