-- Forward-only organization authorization expansion. Existing assignments remain valid.
-- Review duplicate role names after case folding before deploying; the unique index fails closed.
BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE public.organization_memberships
  ADD COLUMN authorization_version INTEGER NOT NULL DEFAULT 1,
  ADD CONSTRAINT organization_memberships_authorization_version_check CHECK (authorization_version > 0);

ALTER TABLE public.organization_roles
  ALTER COLUMN name TYPE CITEXT USING name::citext,
  ADD COLUMN is_active BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN authorization_version INTEGER NOT NULL DEFAULT 1,
  ADD CONSTRAINT organization_roles_authorization_version_check CHECK (authorization_version > 0),
  ADD CONSTRAINT organization_roles_name_length_check CHECK (char_length(name::text) BETWEEN 1 AND 120),
  ADD CONSTRAINT organization_roles_system_identity_check CHECK (
    (key <> 'owner' OR is_system)
    AND (NOT is_system OR key IN ('owner', 'administrator'))
    AND (is_system OR key NOT IN ('administrator', 'admin', 'superadmin', 'platform.owner'))
    AND (is_system OR lower(btrim(name::text)) NOT IN ('owner', 'organization owner',
      'superadmin', 'administrator', 'organization administrator', 'platform owner'))
    AND (key <> 'owner' OR (is_active AND name::text = 'Owner'))
  );
CREATE UNIQUE INDEX organization_roles_organization_name_key
  ON public.organization_roles(organization_id, name);

CREATE TABLE public.organization_permissions (
  id UUID NOT NULL,
  key VARCHAR(80) NOT NULL,
  description VARCHAR(500) NOT NULL,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT organization_permissions_pkey PRIMARY KEY (id),
  CONSTRAINT organization_permissions_key_check CHECK (
    key COLLATE "C" ~ '^organization\.[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$'
  )
);
CREATE UNIQUE INDEX organization_permissions_key_key ON public.organization_permissions(key);

-- Catalog additions require a reviewed migration and a matching typed API registry.
INSERT INTO public.organization_permissions (id, key, description) VALUES
  ('00000000-0000-4000-8000-000000000101', 'organization.dashboard.read', 'Read the organization portal identity.'),
  ('00000000-0000-4000-8000-000000000102', 'organization.members.read', 'Read membership summaries.'),
  ('00000000-0000-4000-8000-000000000103', 'organization.members.manage', 'Manage ordinary membership state.'),
  ('00000000-0000-4000-8000-000000000104', 'organization.roles.read', 'Read organization role definitions.'),
  ('00000000-0000-4000-8000-000000000105', 'organization.roles.create', 'Create organization custom roles.'),
  ('00000000-0000-4000-8000-000000000106', 'organization.roles.update', 'Update organization custom roles.'),
  ('00000000-0000-4000-8000-000000000107', 'organization.roles.assign', 'Assign delegable organization roles.'),
  ('00000000-0000-4000-8000-000000000108', 'organization.roles.system', 'Protected owner administration; requires verified step-up.');

CREATE TABLE public.organization_role_permissions (
  organization_id UUID NOT NULL,
  organization_role_id UUID NOT NULL,
  organization_permission_id UUID NOT NULL,
  granted_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT organization_role_permissions_pkey PRIMARY KEY
    (organization_id, organization_role_id, organization_permission_id),
  CONSTRAINT organization_role_permissions_role_fkey FOREIGN KEY
    (organization_id, organization_role_id) REFERENCES public.organization_roles(organization_id, id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT organization_role_permissions_permission_fkey FOREIGN KEY
    (organization_permission_id) REFERENCES public.organization_permissions(id)
    ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE INDEX organization_role_permissions_permission_idx
  ON public.organization_role_permissions(organization_permission_id);

CREATE TABLE public.organization_authorization_audit_events (
  id UUID NOT NULL,
  organization_id UUID NOT NULL,
  actor_membership_id UUID NOT NULL,
  actor_user_id UUID NOT NULL,
  target_membership_id UUID,
  target_role_id UUID,
  action VARCHAR(40) NOT NULL,
  request_id VARCHAR(80) NOT NULL,
  occurred_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT organization_authorization_audit_events_pkey PRIMARY KEY (id),
  CONSTRAINT organization_authorization_audit_actor_fkey FOREIGN KEY
    (organization_id, actor_membership_id, actor_user_id)
    REFERENCES public.organization_memberships(organization_id, id, user_id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT organization_authorization_audit_target_membership_fkey FOREIGN KEY
    (organization_id, target_membership_id) REFERENCES public.organization_memberships(organization_id, id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT organization_authorization_audit_target_role_fkey FOREIGN KEY
    (organization_id, target_role_id) REFERENCES public.organization_roles(organization_id, id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT organization_authorization_audit_actor_user_fkey FOREIGN KEY
    (actor_user_id) REFERENCES public.users(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT organization_authorization_audit_action_check CHECK (
    (action IN ('role_created', 'role_details_changed', 'role_permissions_changed', 'role_disabled')
      AND target_role_id IS NOT NULL AND target_membership_id IS NULL)
    OR (action IN ('role_assigned', 'role_revoked')
      AND target_role_id IS NOT NULL AND target_membership_id IS NOT NULL)
    OR (action IN ('membership_suspended', 'membership_reactivated', 'membership_revoked')
      AND target_role_id IS NULL AND target_membership_id IS NOT NULL)
  ),
  CONSTRAINT organization_authorization_audit_request_check CHECK (
    request_id ~ '^req_[0-9a-f-]{36}$'
  )
);
CREATE INDEX organization_authorization_audit_org_time_idx
  ON public.organization_authorization_audit_events(organization_id, occurred_at DESC, id);
CREATE INDEX organization_authorization_audit_org_actor_time_idx
  ON public.organization_authorization_audit_events(organization_id, actor_membership_id, occurred_at DESC, id);

CREATE FUNCTION public.reject_organization_authorization_audit_mutation() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $$
BEGIN
  RAISE EXCEPTION 'Organization authorization audits are immutable.' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER organization_authorization_audit_immutable
  BEFORE UPDATE OR DELETE ON public.organization_authorization_audit_events
  FOR EACH ROW EXECUTE FUNCTION public.reject_organization_authorization_audit_mutation();
CREATE TRIGGER organization_authorization_audit_no_truncate
  BEFORE TRUNCATE ON public.organization_authorization_audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION public.reject_organization_authorization_audit_mutation();

REVOKE ALL ON TABLE public.organization_permissions, public.organization_role_permissions,
  public.organization_authorization_audit_events FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reject_organization_authorization_audit_mutation() FROM PUBLIC;
COMMIT;
