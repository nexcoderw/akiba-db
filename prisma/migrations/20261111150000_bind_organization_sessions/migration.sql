BEGIN;

SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE public.owner_sessions
  ADD COLUMN organization_id uuid,
  ADD COLUMN membership_id uuid,
  ADD COLUMN enrollment_challenge_id uuid,
  ADD COLUMN revocation_reason varchar(40);

ALTER TABLE public.platform_admin_sessions
  ADD COLUMN revocation_reason varchar(40),
  ADD CONSTRAINT platform_admin_sessions_revocation_reason_check CHECK (
    revocation_reason IS NULL OR (
      revoked_at IS NOT NULL AND revocation_reason IN (
        'logout', 'remote', 'all_sessions', 'credential_change', 'expired', 'invalidated'
      )
    )
  );

-- Existing global sessions have no trustworthy selected membership. End them before
-- enforcing the new binding; the application must prompt those browsers to sign in.
UPDATE public.owner_sessions
SET revoked_at = GREATEST(clock_timestamp(), created_at),
    revocation_reason = 'tenant_binding_upgrade'
WHERE revoked_at IS NULL;

CREATE INDEX owner_sessions_membership_active_idx
  ON public.owner_sessions (organization_id, membership_id, revoked_at);

CREATE UNIQUE INDEX owner_enrollment_challenges_org_id_user_key
  ON public.organization_owner_enrollment_challenges (organization_id, id, user_id);

ALTER TABLE public.owner_sessions
  ADD CONSTRAINT owner_sessions_membership_fkey
  FOREIGN KEY (organization_id, membership_id, user_id)
  REFERENCES public.organization_memberships (organization_id, id, user_id)
  ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE public.owner_sessions
  ADD CONSTRAINT owner_sessions_enrollment_challenge_fkey
  FOREIGN KEY (organization_id, enrollment_challenge_id, user_id)
  REFERENCES public.organization_owner_enrollment_challenges (organization_id, id, user_id)
  ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE public.owner_sessions
  ADD CONSTRAINT owner_sessions_binding_check CHECK (
    (revoked_at IS NOT NULL OR (
      organization_id IS NOT NULL
      AND ((membership_id IS NOT NULL AND enrollment_challenge_id IS NULL)
        OR (membership_id IS NULL AND enrollment_challenge_id IS NOT NULL))
    ))
    AND (organization_id IS NOT NULL OR (membership_id IS NULL AND enrollment_challenge_id IS NULL))
    AND (revocation_reason IS NULL OR revoked_at IS NOT NULL)
    AND (revocation_reason IS NULL OR revocation_reason IN (
      'logout', 'remote', 'all_sessions', 'membership_change',
      'credential_change', 'expired', 'invalidated', 'rotated',
      'tenant_binding_upgrade'
    ))
  );

CREATE OR REPLACE FUNCTION public.guard_owner_session()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  current_user_status public.user_status;
BEGIN
  SELECT account.status INTO current_user_status
  FROM public.users AS account
  WHERE account.id = NEW.user_id
  FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'owner session user does not exist'
      USING ERRCODE = '23503', CONSTRAINT = 'owner_sessions_user_id_fkey';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF current_user_status <> 'active' OR NEW.revoked_at IS NOT NULL
      OR NEW.organization_id IS NULL
      OR ((NEW.membership_id IS NULL) = (NEW.enrollment_challenge_id IS NULL)) THEN
      RAISE EXCEPTION 'owner sessions require an active user and membership'
        USING ERRCODE = '23514', CONSTRAINT = 'owner_session_guard';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.revoked_at IS NOT NULL AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'revoked owner sessions are immutable'
      USING ERRCODE = '23514', CONSTRAINT = 'owner_session_guard';
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.user_id IS DISTINCT FROM OLD.user_id
    OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
    OR NEW.membership_id IS DISTINCT FROM OLD.membership_id
    OR NEW.enrollment_challenge_id IS DISTINCT FROM OLD.enrollment_challenge_id
    OR NEW.token_digest IS DISTINCT FROM OLD.token_digest
    OR NEW.assurance IS DISTINCT FROM OLD.assurance
    OR NEW.authenticated_at IS DISTINCT FROM OLD.authenticated_at
    OR NEW.mfa_verified_at IS DISTINCT FROM OLD.mfa_verified_at
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR NEW.absolute_expires_at IS DISTINCT FROM OLD.absolute_expires_at
  THEN
    RAISE EXCEPTION 'owner session identity and authentication evidence are immutable'
      USING ERRCODE = '23514', CONSTRAINT = 'owner_session_guard';
  END IF;

  IF OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL THEN
    IF NEW.last_activity_at IS DISTINCT FROM OLD.last_activity_at
      OR NEW.idle_expires_at IS DISTINCT FROM OLD.idle_expires_at THEN
      RAISE EXCEPTION 'owner session revocation cannot refresh activity'
        USING ERRCODE = '23514', CONSTRAINT = 'owner_session_guard';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.revoked_at IS DISTINCT FROM OLD.revoked_at
    OR NEW.revocation_reason IS DISTINCT FROM OLD.revocation_reason THEN
    RAISE EXCEPTION 'owner session revocation is one-way'
      USING ERRCODE = '23514', CONSTRAINT = 'owner_session_guard';
  END IF;

  IF NEW.last_activity_at <= OLD.last_activity_at
    OR NEW.idle_expires_at <= OLD.idle_expires_at THEN
    RAISE EXCEPTION 'owner session activity and idle expiry must advance together'
      USING ERRCODE = '23514', CONSTRAINT = 'owner_session_guard';
  END IF;

  IF current_user_status <> 'active' THEN
    RAISE EXCEPTION 'inactive users cannot refresh owner sessions'
      USING ERRCODE = '23514', CONSTRAINT = 'owner_session_guard';
  END IF;

  RETURN NEW;
END;
$function$;

COMMIT;
