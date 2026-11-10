-- Forward-only retirement: existing migration SQL and checksums remain immutable.
-- Review the target, stop legacy writers and take a verified backup before deployment.
-- Refuse to discard ANY existing records, including financial/audit history.
-- A populated target needs a separate approved archival/data-retention plan; do not
-- truncate tables or disable this guard to make deployment pass.
BEGIN;

SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '60s';
-- A non-bypass migration role must fail rather than mistake RLS-hidden rows for emptiness.
SET LOCAL row_security = off;

-- Lock every affected table before inspecting data to prevent concurrent inserts
-- between the empty-table precondition and retirement. No CASCADE is permitted.
LOCK TABLE
  public.organization_membership_plans,
  public.organization_members,
  public.organization_member_subscriptions,
  public.organization_member_reminder_deliveries,
  public.organization_payments,
  public.organization_payment_allocations,
  public.organization_payment_refunds,
  public.organization_payment_audit_events
IN ACCESS EXCLUSIVE MODE;

DO $retirement_guard$
BEGIN
  IF EXISTS (SELECT 1 FROM public.organization_membership_plans)
    OR EXISTS (SELECT 1 FROM public.organization_members)
    OR EXISTS (SELECT 1 FROM public.organization_member_subscriptions)
    OR EXISTS (SELECT 1 FROM public.organization_member_reminder_deliveries)
    OR EXISTS (SELECT 1 FROM public.organization_payments)
    OR EXISTS (SELECT 1 FROM public.organization_payment_allocations)
    OR EXISTS (SELECT 1 FROM public.organization_payment_refunds)
    OR EXISTS (SELECT 1 FROM public.organization_payment_audit_events)
  THEN
    RAISE EXCEPTION 'Akiba retirement refused: legacy commercial records exist'
      USING ERRCODE = '23514',
        HINT = 'Preserve the data and obtain a separately reviewed archival and retention plan.';
  END IF;
END
$retirement_guard$;

-- One statement permits dependencies within this exact retired set. Unexpected
-- external dependencies abort the transaction instead of removing other objects.
DROP TABLE
  public.organization_member_reminder_deliveries,
  public.organization_payment_audit_events,
  public.organization_payment_allocations,
  public.organization_payment_refunds,
  public.organization_payments,
  public.organization_member_subscriptions,
  public.organization_members,
  public.organization_membership_plans
RESTRICT;

DROP FUNCTION public.guard_member_subscription_history();
DROP FUNCTION public.guard_organization_payment();
DROP FUNCTION public.guard_payment_allocation_history();
DROP FUNCTION public.guard_payment_refund_history();
DROP FUNCTION public.guard_payment_audit_history();
DROP FUNCTION public.stamp_payment_audit_recorded_at();
DROP FUNCTION public.validate_payment_allocation_balance();
DROP FUNCTION public.validate_payment_refund_balance();

DROP TYPE public.organization_member_reminder_status;
DROP TYPE public.organization_member_reminder_channel;
DROP TYPE public.organization_member_reminder_kind;
DROP TYPE public.organization_member_email_suppression_reason;
DROP TYPE public.organization_payment_audit_action;
DROP TYPE public.organization_payment_refund_status;
DROP TYPE public.organization_payment_status;
DROP TYPE public.organization_payment_method;
DROP TYPE public.member_period_unit;

-- Keep shared extensions (citext and btree_gist) and every identity, tenant,
-- onboarding, session and security-audit object intact.
COMMIT;
