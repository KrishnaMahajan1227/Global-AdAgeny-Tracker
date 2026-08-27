/*
# Rebuild demo seed pipeline — every stage gated on the one before it

## Why this migration exists
The original seed (0002) only ever set `shops.status` by hand (e.g.
'design_approved', 'production_done', 'installed') and never touched the
tables each queue screen actually reads (`surveys`, `design_tasks`,
`production_orders`, `installation_jobs`). Migration 0007 tried to patch
that by *backfilling* rows to match whatever `shops.status` already said —
but that just recreates the same problem one level down: it manufactures a
'design_approved' design_tasks row (or a 'completed' production_orders row)
straight from the shop's label, with no real submitted → approved survey
underneath it. That's exactly the symptom reported: shops showing up in
Design/Production with nothing in "Survey Review" pending, because no shop
ever actually had a row sitting there waiting for approval.

This migration throws out the backfill and rebuilds the demo pipeline
properly: for every shop, each table below is only ever inserted *because*
the row before it in the real approval chain exists and is approved —
survey submitted → survey approved → design_tasks created → design
approved → production_orders created → production completed → installer
assigned → installation_jobs completed. A shop can never end up in Design
or Production here without a genuinely approved survey behind it, same as
if a real admin had clicked "Approve" in the app.

Three shops (Balaji Agro Center, Bansal Hardware & Cement, Adani Corner -
Maninagar) are deliberately left with a `submitted` survey and nothing
past it — these are what should show up under Survey Review → Pending
Review. Everything else is built up the same way, just further along.

Also fixes a plain data gap found while doing this: Gupta Cement Agency
(shop 9) was seeded as `design_approved` but never had a `work_items` row
at all — the survey step that's supposed to create one had been skipped
entirely, which is the same class of bug as the missing installer
assignments below.

Safe to re-run: it deletes and rebuilds only the pipeline rows for this
org's 18 demo shops, it doesn't touch any other data.
*/

-- ============================================================
-- Fix the one shop that was seeded with an advanced status but no
-- work_items row underneath it at all (Gupta Cement Agency).
-- ============================================================
INSERT INTO public.work_items (organization_id, shop_id, work_type_id, work_type_name, material, survey_width, survey_height, survey_unit, survey_quantity, survey_area, survey_notes, status)
SELECT 'a0000000-0000-0000-0000-000000000001', '50000000-0000-0000-0000-000000000009', '40000000-0000-0000-0000-000000000002', 'ACP Board', 'ACP 3mm', 7, 4, 'ft', 1, 28, 'Storefront ACP board', 'pending'
WHERE NOT EXISTS (
  SELECT 1 FROM public.work_items WHERE shop_id = '50000000-0000-0000-0000-000000000009'
);

-- ============================================================
-- Clean slate for this org's pipeline rows so this migration can be
-- re-run and always produce the same consistent, fully-linked history.
-- ============================================================
DELETE FROM public.installation_proofs WHERE shop_id IN (SELECT id FROM public.shops WHERE organization_id = 'a0000000-0000-0000-0000-000000000001');
DELETE FROM public.installation_jobs WHERE shop_id IN (SELECT id FROM public.shops WHERE organization_id = 'a0000000-0000-0000-0000-000000000001');
DELETE FROM public.production_items WHERE production_order_id IN (SELECT id FROM public.production_orders WHERE shop_id IN (SELECT id FROM public.shops WHERE organization_id = 'a0000000-0000-0000-0000-000000000001'));
DELETE FROM public.production_orders WHERE shop_id IN (SELECT id FROM public.shops WHERE organization_id = 'a0000000-0000-0000-0000-000000000001');
DELETE FROM public.design_versions WHERE design_task_id IN (SELECT id FROM public.design_tasks WHERE shop_id IN (SELECT id FROM public.shops WHERE organization_id = 'a0000000-0000-0000-0000-000000000001'));
DELETE FROM public.design_tasks WHERE shop_id IN (SELECT id FROM public.shops WHERE organization_id = 'a0000000-0000-0000-0000-000000000001');
DELETE FROM public.board_markings WHERE survey_photo_id IN (SELECT id FROM public.survey_photos WHERE shop_id IN (SELECT id FROM public.shops WHERE organization_id = 'a0000000-0000-0000-0000-000000000001'));
DELETE FROM public.survey_photos WHERE shop_id IN (SELECT id FROM public.shops WHERE organization_id = 'a0000000-0000-0000-0000-000000000001');
DELETE FROM public.approvals WHERE shop_id IN (SELECT id FROM public.shops WHERE organization_id = 'a0000000-0000-0000-0000-000000000001');
DELETE FROM public.surveys WHERE shop_id IN (SELECT id FROM public.shops WHERE organization_id = 'a0000000-0000-0000-0000-000000000001');
DELETE FROM public.shop_assignments WHERE organization_id = 'a0000000-0000-0000-0000-000000000001';

-- Reset every work item back to its as-created state; each stage below
-- re-advances it exactly the way the app itself would when a real person
-- clicks Approve / Ready for Production / Completed / Install.
UPDATE public.work_items SET
  survey_id = NULL,
  approved_width = NULL, approved_height = NULL, approved_unit = NULL, approved_quantity = NULL, approved_area = NULL, approved_notes = NULL,
  produced_quantity = NULL, produced_notes = NULL, produced_at = NULL,
  installed_width = NULL, installed_height = NULL, installed_unit = NULL, installed_quantity = NULL, installed_area = NULL, installed_notes = NULL, installed_at = NULL,
  status = 'pending'
WHERE organization_id = 'a0000000-0000-0000-0000-000000000001';

-- ============================================================
-- Rebuild, one shop at a time, one gated stage at a time.
-- ============================================================
DO $$
DECLARE
  org_id CONSTANT uuid := 'a0000000-0000-0000-0000-000000000001';
  surveyor_id CONSTANT uuid := '10000000-0000-0000-0000-000000000004';
  designer_id CONSTANT uuid := '10000000-0000-0000-0000-000000000005';
  installer_id CONSTANT uuid := '10000000-0000-0000-0000-000000000007';
  admin_id CONSTANT uuid := '10000000-0000-0000-0000-000000000003';

  rec RECORD;
  target text;
  rank int;
  t timestamptz;
  new_survey_id uuid;
  new_design_task_id uuid;
  new_production_order_id uuid;
BEGIN
  FOR rec IN
    SELECT * FROM (VALUES
      ('50000000-0000-0000-0000-000000000001'::uuid, 'installed'),          -- Mahadhan Krushi Kendra
      ('50000000-0000-0000-0000-000000000002'::uuid, 'production_done'),    -- Shri Ganesh Fertilizers
      ('50000000-0000-0000-0000-000000000003'::uuid, 'design_approved'),    -- Sai Krushi Bhandar
      ('50000000-0000-0000-0000-000000000004'::uuid, 'surveyed'),           -- Balaji Agro Center  -> pending review
      ('50000000-0000-0000-0000-000000000005'::uuid, 'assigned'),           -- Krushi Seva Kendra
      ('50000000-0000-0000-0000-000000000006'::uuid, 'pending'),            -- Jai Durga Fertilizers
      ('50000000-0000-0000-0000-000000000007'::uuid, 'installed'),          -- Shree Cement Store
      ('50000000-0000-0000-0000-000000000008'::uuid, 'production_done'),    -- Raj Cement Depot
      ('50000000-0000-0000-0000-000000000009'::uuid, 'design_approved'),    -- Gupta Cement Agency
      ('50000000-0000-0000-0000-00000000000a'::uuid, 'surveyed'),           -- Bansal Hardware & Cement -> pending review
      ('50000000-0000-0000-0000-00000000000b'::uuid, 'assigned'),           -- Sharma Building Material
      ('50000000-0000-0000-0000-00000000000c'::uuid, 'pending'),            -- Vinayak Trading Co
      ('50000000-0000-0000-0000-00000000000d'::uuid, 'installed'),          -- Adani Fuels - CG Road
      ('50000000-0000-0000-0000-00000000000e'::uuid, 'production_ready'),   -- Adani Retail - Satellite
      ('50000000-0000-0000-0000-00000000000f'::uuid, 'designing'),          -- Adani Mart - Bopal
      ('50000000-0000-0000-0000-000000000010'::uuid, 'approval_pending'),   -- Adani Corner - Maninagar -> pending review
      ('50000000-0000-0000-0000-000000000011'::uuid, 'pending'),            -- Adani Express - Naroda
      ('50000000-0000-0000-0000-000000000012'::uuid, 'pending')             -- Adani Mart - Vastral
    ) AS s(shop_id, target_status)
  LOOP
    target := rec.target_status;
    new_survey_id := NULL; new_design_task_id := NULL; new_production_order_id := NULL;

    -- How far along the real approval chain this shop has genuinely gone.
    rank := CASE target
      WHEN 'pending'           THEN 0
      WHEN 'assigned'          THEN 1
      WHEN 'surveyed'          THEN 2  -- survey submitted, awaiting review
      WHEN 'approval_pending'  THEN 2  -- survey submitted, awaiting review
      WHEN 'designing'         THEN 4  -- survey approved, design in progress
      WHEN 'design_approved'   THEN 6  -- design internally approved
      WHEN 'production_pending' THEN 7
      WHEN 'in_production'     THEN 8
      WHEN 'production_ready'  THEN 9  -- design sent to production
      WHEN 'production_done'   THEN 10 -- production completed
      WHEN 'installed'         THEN 13 -- installed on site
      ELSE 0
    END;

    -- Shops still awaiting review get a recent submission (that's the
    -- live queue); everything further along gets an older, staggered
    -- start so the whole history stays safely in the past.
    IF rank = 2 THEN
      t := now() - interval '1 day';
    ELSE
      t := now() - ((rank * 3 + 10) || ' days')::interval;
    END IF;

    -- STAGE 1 — surveyor assigned to the shop
    IF rank >= 1 THEN
      INSERT INTO public.shop_assignments (organization_id, shop_id, user_id, role, status, assigned_at, completed_at)
      VALUES (org_id, rec.shop_id, surveyor_id, 'surveyor',
        CASE WHEN rank >= 2 THEN 'completed' ELSE 'accepted' END,
        t, CASE WHEN rank >= 2 THEN t + interval '1 day' ELSE NULL END);
    END IF;

    -- STAGE 2 — survey submitted (gate: nothing past this exists unless
    -- this row exists and, for anything further, is actually 'approved')
    IF rank >= 2 THEN
      INSERT INTO public.surveys (organization_id, shop_id, surveyor_id, status, submitted_at, reviewed_at, reviewed_by, review_note, notes)
      VALUES (org_id, rec.shop_id, surveyor_id,
        CASE WHEN rank >= 4 THEN 'approved' ELSE 'submitted' END,
        t + interval '1 day',
        CASE WHEN rank >= 4 THEN t + interval '2 days' ELSE NULL END,
        CASE WHEN rank >= 4 THEN admin_id ELSE NULL END,
        CASE WHEN rank >= 4 THEN 'Measurements verified, approved.' ELSE NULL END,
        'Seed survey data.')
      RETURNING id INTO new_survey_id;

      UPDATE public.work_items SET survey_id = new_survey_id, status = 'surveyed'
      WHERE shop_id = rec.shop_id;
    END IF;

    -- STAGE 3 — survey approved: work items copied to approved (gate:
    -- only runs because the survey row above is genuinely 'approved')
    IF rank >= 4 THEN
      UPDATE public.work_items SET
        approved_width = survey_width, approved_height = survey_height, approved_unit = survey_unit,
        approved_quantity = survey_quantity, approved_area = survey_area, approved_notes = survey_notes,
        status = 'approved'
      WHERE shop_id = rec.shop_id;
    END IF;

    -- STAGE 4 — design task created (gate: only because the approved
    -- survey above exists — never conjured from shops.status directly)
    IF rank >= 4 THEN
      INSERT INTO public.design_tasks (organization_id, shop_id, designer_id, status, assigned_at, completed_at)
      VALUES (org_id, rec.shop_id, designer_id,
        CASE WHEN rank >= 9 THEN 'ready_for_production' WHEN rank >= 6 THEN 'approved' ELSE 'designing' END,
        t + interval '3 days',
        CASE WHEN rank >= 6 THEN t + interval '5 days' ELSE NULL END)
      RETURNING id INTO new_design_task_id;

      IF rank >= 6 THEN
        INSERT INTO public.design_versions (organization_id, design_task_id, version_number, storage_path, file_url, file_name, uploaded_by, status, notes, created_at)
        VALUES (org_id, new_design_task_id, 1, 'seed/design-v1.pdf', 'https://placehold.co/800x600?text=Design+v1', 'design-v1.pdf', designer_id, 'approved', 'Initial design version, approved internally.', t + interval '4 days');
      END IF;
    END IF;

    -- STAGE 5 — production order created (gate: only because the design
    -- task above was actually sent 'ready_for_production')
    IF rank >= 9 THEN
      UPDATE public.work_items SET status = 'design_approved' WHERE shop_id = rec.shop_id;

      INSERT INTO public.production_orders (organization_id, shop_id, design_task_id, status, notes, created_at)
      VALUES (org_id, rec.shop_id, new_design_task_id,
        CASE WHEN rank >= 10 THEN 'completed' ELSE 'ready' END,
        'Seed production order.', t + interval '6 days')
      RETURNING id INTO new_production_order_id;

      INSERT INTO public.production_items (organization_id, production_order_id, work_item_id, requested_qty, approved_qty, produced_qty, notes)
      SELECT org_id, new_production_order_id, wi.id, wi.survey_quantity, wi.survey_quantity,
        CASE WHEN rank >= 10 THEN wi.survey_quantity ELSE NULL END, NULL
      FROM public.work_items wi WHERE wi.shop_id = rec.shop_id;

      IF rank >= 10 THEN
        UPDATE public.work_items SET
          produced_quantity = survey_quantity, produced_at = t + interval '7 days', status = 'production_done'
        WHERE shop_id = rec.shop_id;
      END IF;
    END IF;

    -- STAGE 6 — installed (gate: only because production above actually
    -- completed) — and, one stage earlier, make sure a production-done
    -- shop that isn't installed yet at least has an installer *assigned*,
    -- which is the same class of gap as the missing surveyor-assignment
    -- screen: a shop reaching a stage with nobody actually assigned to
    -- pick it up from there.
    IF rank >= 13 THEN
      INSERT INTO public.shop_assignments (organization_id, shop_id, user_id, role, status, assigned_at, completed_at)
      VALUES (org_id, rec.shop_id, installer_id, 'installer', 'completed', t + interval '8 days', t + interval '9 days');

      INSERT INTO public.installation_jobs (organization_id, shop_id, installer_id, production_order_id, status, started_at, completed_at, notes, created_at)
      VALUES (org_id, rec.shop_id, installer_id, new_production_order_id, 'completed', t + interval '9 days', t + interval '9 days' + interval '2 hours', 'Installed successfully.', t + interval '9 days');

      UPDATE public.work_items SET
        installed_width = survey_width, installed_height = survey_height, installed_unit = survey_unit,
        installed_quantity = survey_quantity, installed_area = survey_area, installed_at = t + interval '9 days' + interval '2 hours',
        status = 'installed'
      WHERE shop_id = rec.shop_id;
    ELSIF rank >= 10 THEN
      INSERT INTO public.shop_assignments (organization_id, shop_id, user_id, role, status, assigned_at)
      VALUES (org_id, rec.shop_id, installer_id, 'installer', 'assigned', t + interval '8 days');
    END IF;

    -- shops.status is display-only now — every queue screen reads the
    -- pipeline tables built above, so this is guaranteed consistent with
    -- what actually exists, not a label set ahead of the real data.
    UPDATE public.shops SET status = target WHERE id = rec.shop_id;
  END LOOP;
END $$;
