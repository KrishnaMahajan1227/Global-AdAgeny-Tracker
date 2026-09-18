-- Link each installation proof to the exact board/work item it proves.
ALTER TABLE public.installation_proofs
  ADD COLUMN IF NOT EXISTS work_item_id uuid REFERENCES public.work_items(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_installation_proofs_work_item_id ON public.installation_proofs(work_item_id);
