-- Forward-only expansion. No existing identity or credential is reset or deleted.
-- Review the datasource diff and existing rows before human deployment. Unsupported email rows
-- intentionally block constraint validation; reconcile them through an approved identity workflow.
ALTER TYPE public.user_status ADD VALUE IF NOT EXISTS 'disabled';
BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE public.users ADD COLUMN identity_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE public.password_credentials
  ADD COLUMN version INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN normalization VARCHAR(8) NOT NULL DEFAULT 'raw',
  ADD COLUMN disabled_at TIMESTAMPTZ(6);

ALTER TABLE public.users
  ADD CONSTRAINT users_identity_version_check CHECK (identity_version > 0),
  ADD CONSTRAINT users_email_identity_check CHECK (
    octet_length(email::text) <= 254
    AND octet_length(split_part(email::text, '@', 1)) <= 64
    AND split_part(email::text, '@', 2) COLLATE "C" ~* '\.[a-z0-9-]*[a-z][a-z0-9-]*$'
    AND email::text COLLATE "C" ~* '^[a-z0-9!#$%&''*+/=?^_`{|}~-]+(\.[a-z0-9!#$%&''*+/=?^_`{|}~-]+)*@[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$'
  ) NOT VALID;
ALTER TABLE public.users VALIDATE CONSTRAINT users_email_identity_check;

ALTER TABLE public.password_credentials
  ADD CONSTRAINT password_credentials_version_check CHECK (version > 0),
  ADD CONSTRAINT password_credentials_normalization_check CHECK (normalization IN ('raw', 'nfc')),
  ADD CONSTRAINT password_credentials_disabled_time_check CHECK (
    disabled_at IS NULL OR disabled_at >= created_at
  );

CREATE TABLE public.user_email_verification_challenges (
  id UUID NOT NULL,
  user_id UUID NOT NULL,
  identity_version INTEGER NOT NULL,
  target_email CITEXT NOT NULL,
  token_digest VARCHAR(64) NOT NULL,
  expires_at TIMESTAMPTZ(6) NOT NULL,
  consumed_at TIMESTAMPTZ(6),
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT user_email_verification_challenges_pkey PRIMARY KEY (id),
  CONSTRAINT user_email_verification_challenges_user_fkey FOREIGN KEY (user_id)
    REFERENCES public.users(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT user_email_verification_challenges_version_check CHECK (identity_version > 0),
  CONSTRAINT user_email_verification_challenges_digest_check CHECK (token_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT user_email_verification_challenges_time_check CHECK (
    expires_at > created_at AND (consumed_at IS NULL OR consumed_at >= created_at)
  ),
  CONSTRAINT user_email_verification_challenges_email_check CHECK (
    octet_length(target_email::text) <= 254
    AND octet_length(split_part(target_email::text, '@', 1)) <= 64
    AND split_part(target_email::text, '@', 2) COLLATE "C" ~* '\.[a-z0-9-]*[a-z][a-z0-9-]*$'
    AND target_email::text COLLATE "C" ~* '^[a-z0-9!#$%&''*+/=?^_`{|}~-]+(\.[a-z0-9!#$%&''*+/=?^_`{|}~-]+)*@[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$'
  )
);
CREATE UNIQUE INDEX user_email_verification_challenges_digest_key
  ON public.user_email_verification_challenges(token_digest);
CREATE INDEX user_email_verification_challenges_user_active_idx
  ON public.user_email_verification_challenges(user_id, consumed_at, expires_at);

CREATE TABLE public.identity_security_audit_events (
  id UUID NOT NULL,
  user_id UUID NOT NULL,
  actor_platform_staff_id UUID,
  actor_user_id UUID,
  actor_kind VARCHAR(24) NOT NULL,
  action VARCHAR(48) NOT NULL,
  identity_version INTEGER NOT NULL,
  credential_version INTEGER,
  request_id VARCHAR(80) NOT NULL,
  occurred_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT identity_security_audit_events_pkey PRIMARY KEY (id),
  CONSTRAINT identity_security_audit_events_user_fkey FOREIGN KEY (user_id)
    REFERENCES public.users(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT identity_security_audit_events_actor_staff_fkey FOREIGN KEY (actor_platform_staff_id)
    REFERENCES public.platform_staff(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT identity_security_audit_events_actor_user_fkey FOREIGN KEY (actor_user_id)
    REFERENCES public.users(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT identity_security_audit_events_actor_check CHECK (
    (actor_kind IN ('platform', 'bootstrap') AND actor_platform_staff_id IS NOT NULL AND actor_user_id IS NULL)
    OR (actor_kind IN ('enrollment', 'email_verification') AND actor_user_id IS NOT NULL AND actor_user_id = user_id AND actor_platform_staff_id IS NULL)
  ),
  CONSTRAINT identity_security_audit_events_action_check CHECK (action IN (
    'identity_created', 'email_verified', 'email_changed', 'password_created', 'password_changed',
    'password_rehashed', 'credential_disabled', 'account_suspended', 'account_reactivated',
    'account_disabled', 'credential_compromised'
  )),
  CONSTRAINT identity_security_audit_events_version_check CHECK (
    identity_version > 0 AND (credential_version IS NULL OR credential_version > 0)
  ),
  CONSTRAINT identity_security_audit_events_request_check CHECK (
    request_id ~ '^req_[0-9a-f-]{36}$'
  )
);
CREATE INDEX identity_security_audit_events_user_time_idx
  ON public.identity_security_audit_events(user_id, occurred_at DESC, id);
CREATE INDEX identity_security_audit_events_request_idx ON public.identity_security_audit_events(request_id);

-- An email write cannot retain the old mailbox proof. A verified change sets its new timestamp in a
-- subsequent statement inside the same authorized transaction, after consuming the matching proof.
CREATE FUNCTION public.invalidate_changed_email_verification() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.email IS DISTINCT FROM OLD.email THEN
    NEW.email_verified_at := NULL;
    NEW.identity_version := GREATEST(NEW.identity_version, OLD.identity_version + 1);
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER users_invalidate_changed_email_verification
  BEFORE UPDATE OF email ON public.users
  FOR EACH ROW EXECUTE FUNCTION public.invalidate_changed_email_verification();

CREATE FUNCTION public.reject_identity_audit_mutation() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $$
BEGIN
  RAISE EXCEPTION 'Identity security audit events are immutable.' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER identity_security_audit_events_immutable
  BEFORE UPDATE OR DELETE ON public.identity_security_audit_events
  FOR EACH ROW EXECUTE FUNCTION public.reject_identity_audit_mutation();
CREATE TRIGGER identity_security_audit_events_no_truncate
  BEFORE TRUNCATE ON public.identity_security_audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION public.reject_identity_audit_mutation();
REVOKE ALL ON TABLE public.user_email_verification_challenges, public.identity_security_audit_events FROM PUBLIC;
REVOKE ALL ON FUNCTION public.invalidate_changed_email_verification() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reject_identity_audit_mutation() FROM PUBLIC;
COMMIT;
