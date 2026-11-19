-- Additive draft: review against the approved development datasource before deployment.
BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '60s';
CREATE TABLE public.platform_owner_enrollments (
  id UUID NOT NULL PRIMARY KEY,
  platform_staff_id UUID NOT NULL,
  email CITEXT NOT NULL,
  identity_version INTEGER NOT NULL,
  token_digest VARCHAR(128) NOT NULL,
  session_digest VARCHAR(128),
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMPTZ(6) NOT NULL,
  sent_at TIMESTAMPTZ(6),
  exchanged_at TIMESTAMPTZ(6),
  consumed_at TIMESTAMPTZ(6),
  send_count INTEGER NOT NULL DEFAULT 1,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  setup_version INTEGER NOT NULL DEFAULT 0,
  password_hash VARCHAR(255),
  encrypted_secret BYTEA,
  encryption_key_id VARCHAR(120),
  encryption_version INTEGER,
  initialization_vector BYTEA,
  authentication_tag BYTEA,
  CONSTRAINT platform_owner_enrollments_staff_fkey FOREIGN KEY (platform_staff_id)
    REFERENCES public.platform_staff(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT platform_owner_enrollments_bounds_check CHECK (
    identity_version > 0 AND send_count BETWEEN 1 AND 3
    AND failed_attempts BETWEEN 0 AND 5 AND setup_version BETWEEN 0 AND 3),
  CONSTRAINT platform_owner_enrollments_digest_check CHECK (
    token_digest ~ '^[a-f0-9]{64}$'
    AND (session_digest IS NULL OR session_digest ~ '^[a-f0-9]{64}$')),
  CONSTRAINT platform_owner_enrollments_time_check CHECK (
    expires_at > created_at
    AND (sent_at IS NULL OR sent_at >= created_at)
    AND (exchanged_at IS NULL OR (sent_at IS NOT NULL AND exchanged_at >= sent_at))
    AND (consumed_at IS NULL OR consumed_at >= created_at)),
  CONSTRAINT platform_owner_enrollments_session_check CHECK (
    (exchanged_at IS NULL) = (session_digest IS NULL)),
  CONSTRAINT platform_owner_enrollments_secret_check CHECK (
    (setup_version = 0 AND encrypted_secret IS NULL AND encryption_key_id IS NULL
      AND encryption_version IS NULL AND initialization_vector IS NULL AND authentication_tag IS NULL)
    OR (setup_version > 0 AND password_hash IS NOT NULL AND exchanged_at IS NOT NULL
      AND encrypted_secret IS NOT NULL AND octet_length(encrypted_secret) BETWEEN 16 AND 128
      AND encryption_key_id IS NOT NULL AND encryption_version = 1
      AND initialization_vector IS NOT NULL AND octet_length(initialization_vector) = 12
      AND authentication_tag IS NOT NULL AND octet_length(authentication_tag) = 16))
);
CREATE UNIQUE INDEX platform_owner_enrollments_staff_key ON public.platform_owner_enrollments(platform_staff_id);
CREATE UNIQUE INDEX platform_owner_enrollments_token_key ON public.platform_owner_enrollments(token_digest);
CREATE UNIQUE INDEX platform_owner_enrollments_session_key ON public.platform_owner_enrollments(session_digest);
CREATE INDEX platform_owner_enrollments_expiry_idx ON public.platform_owner_enrollments(expires_at);
REVOKE ALL ON public.platform_owner_enrollments FROM PUBLIC;

-- Proof issuance is confined to the sole pending system owner, even for non-HTTP writers.
CREATE FUNCTION public.guard_platform_owner_enrollment() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $$
BEGIN
  IF (SELECT count(*) FROM public.platform_staff) <> 1 OR NOT EXISTS (
    SELECT 1 FROM public.platform_staff AS staff
    JOIN public.users AS identity ON identity.id = staff.user_id
    JOIN public.platform_staff_roles AS assignment ON assignment.platform_staff_id = staff.id
    JOIN public.platform_roles AS role ON role.id = assignment.platform_role_id
    WHERE staff.id = NEW.platform_staff_id AND staff.status = 'pending'
      AND identity.status = 'pending' AND identity.email_verified_at IS NULL
      AND identity.email = NEW.email AND identity.identity_version = NEW.identity_version
      AND role.key = 'platform.owner' AND role.is_system
      AND NOT EXISTS (SELECT 1 FROM public.password_credentials WHERE user_id = identity.id)
      AND NOT EXISTS (SELECT 1 FROM public.platform_totp_credentials WHERE platform_staff_id = staff.id)
  ) THEN
    RAISE EXCEPTION 'First-owner enrollment requires the sole pending system owner.' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.id IS DISTINCT FROM OLD.id OR NEW.platform_staff_id IS DISTINCT FROM OLD.platform_staff_id THEN
      RAISE EXCEPTION 'Enrollment ownership is immutable.' USING ERRCODE = '23514';
    END IF;
    IF NEW.token_digest IS DISTINCT FROM OLD.token_digest THEN
      IF NEW.send_count <> OLD.send_count + 1 OR NEW.created_at <= OLD.created_at
        OR NEW.exchanged_at IS NOT NULL OR NEW.consumed_at IS NOT NULL THEN
        RAISE EXCEPTION 'Invalid operator reissue.' USING ERRCODE = '23514';
      END IF;
    ELSIF OLD.consumed_at IS NOT NULL OR NEW.send_count <> OLD.send_count
      OR NEW.created_at IS DISTINCT FROM OLD.created_at
      OR NEW.email IS DISTINCT FROM OLD.email OR NEW.identity_version <> OLD.identity_version
      OR NEW.failed_attempts < OLD.failed_attempts OR NEW.expires_at > OLD.expires_at
      OR (OLD.session_digest IS NOT NULL AND NEW.session_digest IS DISTINCT FROM OLD.session_digest)
      OR (OLD.sent_at IS NOT NULL AND NEW.sent_at IS DISTINCT FROM OLD.sent_at)
      OR (OLD.exchanged_at IS NOT NULL AND NEW.exchanged_at IS DISTINCT FROM OLD.exchanged_at)
      OR (NEW.consumed_at IS NULL AND NEW.setup_version < OLD.setup_version) THEN
      RAISE EXCEPTION 'Invalid enrollment transition.' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER platform_owner_enrollment_guard BEFORE INSERT OR UPDATE ON public.platform_owner_enrollments
  FOR EACH ROW EXECUTE FUNCTION public.guard_platform_owner_enrollment();
REVOKE ALL ON FUNCTION public.guard_platform_owner_enrollment() FROM PUBLIC;
COMMIT;
