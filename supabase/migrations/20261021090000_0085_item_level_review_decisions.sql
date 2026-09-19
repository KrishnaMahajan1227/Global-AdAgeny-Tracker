-- Item-level Owner/Admin review decisions inside a single shop review.
create table if not exists public.field_review_decisions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  shop_id uuid not null references public.shops(id) on delete cascade,
  stage text not null check (stage in ('survey','installation')),
  survey_id uuid references public.surveys(id) on delete cascade,
  installation_job_id uuid references public.installation_jobs(id) on delete cascade,
  entity_type text not null check (entity_type in ('measurement','survey_photo','work_item','installation_photo')),
  entity_id uuid not null,
  decision text not null check (decision in ('approved','redo')),
  note text,
  reviewed_by uuid,
  reviewed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique(stage, entity_type, entity_id)
);
create index if not exists idx_field_review_decisions_shop on public.field_review_decisions(shop_id, stage);
create index if not exists idx_field_review_decisions_survey on public.field_review_decisions(survey_id) where survey_id is not null;
create index if not exists idx_field_review_decisions_install on public.field_review_decisions(installation_job_id) where installation_job_id is not null;
alter table public.field_review_decisions enable row level security;
drop policy if exists "org members manage field review decisions" on public.field_review_decisions;
create policy "org members manage field review decisions" on public.field_review_decisions for all to authenticated
using (organization_id in (select organization_id from public.profiles where id = auth.uid()))
with check (organization_id in (select organization_id from public.profiles where id = auth.uid()));
