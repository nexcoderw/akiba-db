-- Draft forward expansion: review development status/diff, SQL and maintenance window before deploy.
-- Existing platform sessions are deliberately revoked: legacy rows do not identify their MFA method.
BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE public.platform_staff
  ADD COLUMN mfa_version INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN recovery_generation INTEGER NOT NULL DEFAULT 1,
  ADD CONSTRAINT platform_staff_mfa_version_check CHECK (mfa_version > 0 AND recovery_generation > 0);
ALTER TABLE public.platform_admin_sessions
  ADD COLUMN authentication_method VARCHAR(24) NOT NULL DEFAULT 'legacy',
  ADD COLUMN mfa_version INTEGER NOT NULL DEFAULT 1,
  ADD CONSTRAINT platform_sessions_method_check
    CHECK (authentication_method IN ('legacy', 'totp', 'recovery_code', 'email_otp') AND mfa_version > 0),
  ADD CONSTRAINT platform_admin_sessions_staff_id_key UNIQUE (platform_staff_id, id);
ALTER TABLE public.platform_admin_sessions
  DROP CONSTRAINT platform_admin_sessions_revocation_reason_check,
  ADD CONSTRAINT platform_admin_sessions_revocation_reason_check CHECK (
    revocation_reason IS NULL OR (revoked_at IS NOT NULL AND revocation_reason IN (
      'logout', 'remote', 'all_sessions', 'credential_change', 'expired', 'invalidated',
      'mfa_policy_changed', 'mfa_changed', 'recovery_used', 'recovery_rotated'
    ))
  );
UPDATE public.platform_admin_sessions SET revoked_at = clock_timestamp(), revocation_reason = 'mfa_policy_changed'
  WHERE revoked_at IS NULL;
UPDATE public.platform_mfa_challenges SET consumed_at = clock_timestamp() WHERE consumed_at IS NULL;

ALTER TABLE public.platform_totp_credentials
  ADD COLUMN label VARCHAR(80) NOT NULL DEFAULT 'Authenticator',
  ADD COLUMN version INTEGER NOT NULL DEFAULT 1,
  ADD CONSTRAINT platform_totp_credentials_staff_id_key UNIQUE (platform_staff_id, id),
  ADD CONSTRAINT platform_totp_metadata_check
    CHECK (version > 0 AND length(btrim(label)) BETWEEN 1 AND 80 AND label !~ '[[:cntrl:]]');
ALTER TABLE public.platform_recovery_codes
  ADD COLUMN generation INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN digest_version INTEGER NOT NULL DEFAULT 1,
  ADD CONSTRAINT platform_recovery_version_check CHECK (generation > 0 AND digest_version IN (1, 2));
ALTER TABLE public.platform_mfa_challenges
  ADD COLUMN purpose VARCHAR(16) NOT NULL DEFAULT 'login',
  ADD COLUMN operation VARCHAR(32),
  ADD COLUMN platform_session_id UUID,
  ADD COLUMN mfa_version INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN identity_version INTEGER,
  ADD COLUMN credential_version INTEGER,
  ADD COLUMN factor_version INTEGER,
  ADD COLUMN factor_id UUID,
  ADD COLUMN verified_at TIMESTAMPTZ(6),
  ADD COLUMN label VARCHAR(80),
  ADD COLUMN encrypted_secret BYTEA,
  ADD COLUMN encryption_key_id VARCHAR(120),
  ADD COLUMN encryption_version INTEGER,
  ADD COLUMN initialization_vector BYTEA,
  ADD COLUMN authentication_tag BYTEA,
  ADD CONSTRAINT platform_mfa_challenges_session_fkey FOREIGN KEY (platform_staff_id, platform_session_id)
    REFERENCES public.platform_admin_sessions(platform_staff_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT platform_mfa_challenges_factor_fkey FOREIGN KEY (platform_staff_id, factor_id)
    REFERENCES public.platform_totp_credentials(platform_staff_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT platform_mfa_management_scope_check CHECK (
    mfa_version > 0 AND (
      (purpose = 'login' AND platform_session_id IS NULL AND operation IS NULL
        AND verified_at IS NULL AND encrypted_secret IS NULL)
      OR
      (purpose IN ('step_up', 'enrollment') AND platform_session_id IS NOT NULL
        AND operation IS NOT NULL
        AND operation IN ('totp_enroll', 'totp_replace', 'totp_remove', 'factor_rename', 'recovery_regenerate')
        AND ((operation IN ('totp_enroll', 'recovery_regenerate') AND factor_id IS NULL)
          OR (operation IN ('totp_replace', 'totp_remove', 'factor_rename') AND factor_id IS NOT NULL))
        AND identity_version IS NOT NULL AND identity_version > 0
        AND credential_version IS NOT NULL AND credential_version > 0
        AND factor_version IS NOT NULL AND factor_version >= 0
        AND expires_at > created_at AND max_attempts BETWEEN 1 AND 5
        AND failed_attempts BETWEEN 0 AND max_attempts
        AND (consumed_at IS NULL OR consumed_at >= created_at)
        AND expires_at <= created_at + interval '5 minutes'
        AND (verified_at IS NULL OR (verified_at >= created_at AND verified_at < expires_at)))
    )
  ),
  ADD CONSTRAINT platform_mfa_pending_secret_check CHECK (
    (purpose <> 'enrollment' AND encrypted_secret IS NULL AND encryption_key_id IS NULL
      AND encryption_version IS NULL AND initialization_vector IS NULL AND authentication_tag IS NULL)
    OR
    (purpose = 'enrollment' AND operation IN ('totp_enroll', 'totp_replace')
      AND verified_at IS NULL AND label IS NOT NULL AND length(btrim(label)) BETWEEN 1 AND 80
      AND label !~ '[[:cntrl:]]' AND encrypted_secret IS NOT NULL
      AND octet_length(encrypted_secret) BETWEEN 16 AND 256
      AND encryption_key_id IS NOT NULL AND length(encryption_key_id) BETWEEN 1 AND 120
      AND encryption_version IS NOT NULL AND encryption_version = 1
      AND initialization_vector IS NOT NULL AND octet_length(initialization_vector) = 12
      AND authentication_tag IS NOT NULL AND octet_length(authentication_tag) = 16)
  );
CREATE INDEX platform_mfa_challenges_session_idx ON public.platform_mfa_challenges(platform_session_id);
CREATE UNIQUE INDEX platform_mfa_one_pending_management_idx
  ON public.platform_mfa_challenges(platform_staff_id, purpose)
  WHERE purpose <> 'login' AND consumed_at IS NULL;

CREATE TABLE public.platform_security_notifications (
  id UUID NOT NULL PRIMARY KEY,
  platform_staff_id UUID NOT NULL REFERENCES public.platform_staff(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  recipient CITEXT NOT NULL,
  event VARCHAR(48) NOT NULL,
  request_id VARCHAR(80) NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'queued',
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  sent_at TIMESTAMPTZ(6),
  provider_message_id VARCHAR(128),
  CONSTRAINT platform_security_notification_event_check CHECK (event IN (
    'mfa_factor_enrolled', 'mfa_factor_replaced', 'mfa_factor_renamed', 'mfa_recovery_rotated', 'mfa_recovery_used')),
  CONSTRAINT platform_security_notification_status_check
    CHECK (status IN ('queued', 'sending', 'sent', 'uncertain', 'failed')),
  CONSTRAINT platform_security_notification_time_check
    CHECK ((status = 'sent') = (sent_at IS NOT NULL) AND (sent_at IS NULL OR sent_at >= created_at)
      AND (status <> 'sent' OR provider_message_id IS NOT NULL)),
  CONSTRAINT platform_security_notification_provider_check
    CHECK (provider_message_id IS NULL OR provider_message_id ~ '^[0-9a-fA-F-]{36}$'),
  CONSTRAINT platform_security_notification_recipient_check
    CHECK (octet_length(recipient::text) BETWEEN 3 AND 254 AND recipient::text !~ '[[:cntrl:]]'
      AND recipient::text ~ '^[^@[:space:]]+@[^@[:space:]]+$'),
  CONSTRAINT platform_security_notification_request_check CHECK (request_id ~ '^req_[0-9a-f-]{36}$')
);
CREATE INDEX platform_security_notifications_queue_idx
  ON public.platform_security_notifications(status, created_at, id);
REVOKE ALL ON public.platform_security_notifications FROM PUBLIC;

CREATE FUNCTION public.guard_platform_totp_management() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $$
DECLARE staff_status public.platform_staff_status; removing BOOLEAN;
BEGIN
  SELECT status INTO staff_status FROM public.platform_staff WHERE id = OLD.platform_staff_id FOR UPDATE;
  IF TG_OP = 'DELETE' THEN removing := true;
  ELSE removing := NEW.disabled_at IS NOT NULL OR NEW.verified_at IS NULL;
  END IF;
  IF OLD.verified_at IS NOT NULL AND OLD.disabled_at IS NULL AND staff_status <> 'revoked'
    AND removing THEN
    RAISE EXCEPTION 'The final platform authenticator cannot be removed.' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.platform_staff_id IS DISTINCT FROM OLD.platform_staff_id OR NEW.id IS DISTINCT FROM OLD.id THEN
      RAISE EXCEPTION 'Authenticator ownership is immutable.' USING ERRCODE = '23514';
    END IF;
    IF ROW(NEW.encrypted_secret, NEW.initialization_vector, NEW.authentication_tag, NEW.encryption_key_id,
      NEW.encryption_version, NEW.verified_at, NEW.disabled_at)
      IS DISTINCT FROM ROW(OLD.encrypted_secret, OLD.initialization_vector, OLD.authentication_tag,
      OLD.encryption_key_id, OLD.encryption_version, OLD.verified_at, OLD.disabled_at) THEN
      NEW.version := OLD.version + 1;
    ELSE NEW.version := OLD.version;
    END IF;
    RETURN NEW;
  END IF;
  RETURN OLD;
END;
$$;
CREATE TRIGGER platform_totp_management_guard BEFORE UPDATE OR DELETE ON public.platform_totp_credentials
  FOR EACH ROW EXECUTE FUNCTION public.guard_platform_totp_management();

CREATE FUNCTION public.invalidate_platform_mfa_access() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $$
DECLARE staff_id UUID; changed BOOLEAN; recorded TIMESTAMPTZ := clock_timestamp();
BEGIN
  IF TG_OP = 'INSERT' THEN staff_id := NEW.platform_staff_id; changed := NEW.verified_at IS NOT NULL;
  ELSIF TG_OP = 'DELETE' THEN staff_id := OLD.platform_staff_id; changed := OLD.verified_at IS NOT NULL;
  ELSE staff_id := NEW.platform_staff_id; changed := NEW.version <> OLD.version;
  END IF;
  IF changed THEN
    UPDATE public.platform_staff SET mfa_version = mfa_version + 1,
      recovery_generation = recovery_generation + 1 WHERE id = staff_id;
    UPDATE public.platform_admin_sessions SET revoked_at = recorded, revocation_reason = 'mfa_changed'
      WHERE platform_staff_id = staff_id AND revoked_at IS NULL;
    UPDATE public.platform_mfa_challenges SET consumed_at = recorded
      WHERE platform_staff_id = staff_id AND consumed_at IS NULL;
    UPDATE public.platform_recovery_codes SET used_at = recorded
      WHERE platform_staff_id = staff_id AND used_at IS NULL;
  END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER platform_totp_access_invalidation AFTER INSERT OR UPDATE OR DELETE ON public.platform_totp_credentials
  FOR EACH ROW EXECUTE FUNCTION public.invalidate_platform_mfa_access();
REVOKE ALL ON FUNCTION public.guard_platform_totp_management(), public.invalidate_platform_mfa_access() FROM PUBLIC;

ALTER TABLE public.identity_security_audit_events DROP CONSTRAINT identity_security_audit_events_action_check,
  DROP CONSTRAINT identity_security_audit_events_authentication_check,
  ADD CONSTRAINT identity_security_audit_events_action_check CHECK (action IN (
    'identity_created','email_verified','email_changed','password_created','password_changed','password_rehashed',
    'credential_disabled','account_suspended','account_reactivated','account_disabled','credential_compromised',
    'platform_primary_authenticated','platform_mfa_rejected','platform_session_issued','platform_session_revoked',
    'platform_challenge_revoked','mfa_step_up_started','mfa_step_up_verified','mfa_enrollment_started',
    'mfa_enrollment_failed','mfa_factor_enrolled','mfa_factor_replaced','mfa_factor_renamed',
    'mfa_factor_change_denied','mfa_recovery_rotated','mfa_recovery_used')),
  ADD CONSTRAINT identity_security_audit_events_authentication_check CHECK (
    (actor_kind = 'authentication') = (action LIKE 'platform_%' OR action LIKE 'mfa_%')
  );
COMMIT;
