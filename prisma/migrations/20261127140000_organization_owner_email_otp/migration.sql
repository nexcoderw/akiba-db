BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '60s';

ALTER TYPE public.owner_session_assurance ADD VALUE 'password_email_otp';

ALTER TABLE public.owner_sessions DROP CONSTRAINT owner_sessions_assurance_check;
ALTER TABLE public.owner_sessions
  ADD CONSTRAINT owner_sessions_assurance_check CHECK (
    (assurance::text = 'aal1' AND mfa_verified_at IS NULL)
    OR (assurance::text IN ('aal2', 'password_email_otp') AND mfa_verified_at IS NOT NULL)
  );

CREATE TABLE public.owner_email_otp_challenges (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  user_id uuid NOT NULL,
  membership_id uuid,
  enrollment_challenge_id uuid,
  purpose varchar(16) NOT NULL,
  origin varchar(512) NOT NULL,
  identity_version integer NOT NULL,
  credential_version integer NOT NULL,
  token_digest varchar(64) NOT NULL,
  code_digest varchar(64) NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  created_at timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at timestamptz(6) NOT NULL,
  sent_at timestamptz(6),
  consumed_at timestamptz(6),
  CONSTRAINT owner_email_otp_organization_fkey FOREIGN KEY (organization_id)
    REFERENCES public.organizations (id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT owner_email_otp_user_fkey FOREIGN KEY (user_id)
    REFERENCES public.users (id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT owner_email_otp_membership_fkey FOREIGN KEY (organization_id, membership_id, user_id)
    REFERENCES public.organization_memberships (organization_id, id, user_id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT owner_email_otp_enrollment_fkey FOREIGN KEY (organization_id, enrollment_challenge_id, user_id)
    REFERENCES public.organization_owner_enrollment_challenges (organization_id, id, user_id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT owner_email_otp_binding_check CHECK (
    (purpose = 'login' AND membership_id IS NOT NULL AND enrollment_challenge_id IS NULL)
    OR (purpose = 'enrollment' AND membership_id IS NULL AND enrollment_challenge_id IS NOT NULL)
  ),
  CONSTRAINT owner_email_otp_proof_check CHECK (
    token_digest COLLATE "C" ~ '^[0-9a-f]{64}$'
    AND code_digest COLLATE "C" ~ '^[0-9a-f]{64}$'
    AND attempts BETWEEN 0 AND 5
    AND identity_version > 0 AND credential_version > 0
  ),
  CONSTRAINT owner_email_otp_time_check CHECK (
    expires_at > created_at AND expires_at <= created_at + interval '5 minutes'
    AND (sent_at IS NULL OR sent_at BETWEEN created_at AND expires_at)
    AND (consumed_at IS NULL OR (sent_at IS NOT NULL AND consumed_at BETWEEN sent_at AND expires_at))
  )
);
CREATE UNIQUE INDEX owner_email_otp_token_key ON public.owner_email_otp_challenges (token_digest);
CREATE UNIQUE INDEX owner_email_otp_scope_key
  ON public.owner_email_otp_challenges (organization_id, user_id, purpose);
REVOKE ALL ON public.owner_email_otp_challenges FROM PUBLIC;

COMMIT;
