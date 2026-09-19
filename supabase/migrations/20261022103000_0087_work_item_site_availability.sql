-- Per-work-item site availability / non-execution state.
-- Keeps the work item and its survey/design history, while explicitly excluding
-- temporarily/permanently unavailable installation scope from installed/billing totals.
ALTER TABLE public.work_items
  ADD COLUMN IF NOT EXISTS execution_state text NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS execution_reason text,
  ADD COLUMN IF NOT EXISTS execution_note text,
  ADD COLUMN IF NOT EXISTS excluded_from_calculations boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS execution_marked_at timestamptz,
  ADD COLUMN IF NOT EXISTS execution_marked_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL;

DO $$ BEGIN
  ALTER TABLE public.work_items ADD CONSTRAINT work_items_execution_state_check
    CHECK (execution_state IN ('active','site_unavailable','removed_from_scope'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS idx_work_items_execution_state ON public.work_items(shop_id, execution_state);
