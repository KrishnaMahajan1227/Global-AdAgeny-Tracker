-- audit_logs.action was CHECK-constrained to only ('insert','update','delete')
-- since the table was first created, but almost every page in the app has
-- always called logAudit() with more specific, meaningful action words —
-- 'submit', 'approve', 'reject', 'correction', 'complete', 'bulk_assign',
-- 'create', 'upload' — none of which satisfy that constraint. Because the
-- audit_logs insert in logAudit() isn't awaited-and-checked by any of its
-- callers, every one of those inserts has been silently rejected by
-- Postgres (400 from PostgREST) without ever surfacing as an app-level
-- error — the real mutation (survey/shop/production/etc.) always went
-- through fine, only its audit trail entry was silently dropped. The new
-- Backfill and Reassign features made this visible for the first time
-- because their action values ('backfill', 'reassign') showed up in the
-- browser's network tab as an explicit failed request.
--
-- Fix: widen the constraint to the actual action vocabulary the app uses,
-- instead of forcing every call site into insert/update/delete and losing
-- the more specific meaning those words carry in the audit trail.
ALTER TABLE public.audit_logs DROP CONSTRAINT IF EXISTS audit_logs_action_check;
ALTER TABLE public.audit_logs ADD CONSTRAINT audit_logs_action_check CHECK (
  action IN (
    'insert', 'update', 'delete',
    'submit', 'approve', 'reject', 'correction',
    'complete', 'bulk_assign', 'create', 'upload',
    'backfill', 'reassign'
  )
);
