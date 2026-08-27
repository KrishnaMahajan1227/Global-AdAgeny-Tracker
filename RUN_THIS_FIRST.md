# 1 step before anything else

**The reliable way to do this: from this project's root folder, run**

```
supabase db push
```

**This applies every migration file in `supabase/migrations/` in order, including any added since the last time you did this.** Every migration in this folder is written to be idempotent (safe to run again even if it already ran) — so `supabase db push` is always the right thing to run after pulling a new copy of this project, not just the first time. This project has now grown to 65+ migration files; if something in the app looks like it "should work but doesn't" (a feature exists in the code but its data silently isn't there), the single most likely cause is simply that a migration added since your last `db push` hasn't been applied to your actual Supabase project yet — always try `db push` first before assuming it's a code bug.

If you don't have the Supabase CLI linked to this project, the fallback is the SQL Editor in your Supabase dashboard — open each file below **in order** and run it. This list is a snapshot of everything added since the core schema; it is NOT guaranteed to include every migration in the folder going forward, which is exactly why `supabase db push` is the recommended path above.

```
supabase/migrations/20260814120000_0013_enable_realtime_and_consolidate_pipeline_fixes.sql
supabase/migrations/20260814130000_0014_installation_review_gate.sql
supabase/migrations/20260817090000_0018_design_marking_system.sql
supabase/migrations/20260817100000_0019_production_marking_system.sql
supabase/migrations/20260826090000_0030_po_variance_survey_banner.sql
supabase/migrations/20260827090000_0031_design_version_source.sql
supabase/migrations/20260829090000_0033_client_manager_scoping.sql
supabase/migrations/20260830090000_0034_supply_destinations.sql
supabase/migrations/20260831090000_0035_installation_fraud_proofing.sql
supabase/migrations/20260915090000_0050_client_agency_self_link.sql
supabase/migrations/20260916090000_0050_client_invite_agency_org.sql
supabase/migrations/20260917090000_0051_campaigns_and_client_shops.sql
supabase/migrations/20260918090000_0052_client_board_markings_read.sql
supabase/migrations/20260919090000_0053_client_shop_crud_and_po_delete.sql
supabase/migrations/20260920090000_0054_shops_extra_details.sql
supabase/migrations/20260923090000_0057_design_studio_final.sql
supabase/migrations/20260924090000_0058_production_studio_scale_and_summary.sql
supabase/migrations/20260925090000_0059_fix_broadcast_notifications.sql
supabase/migrations/20260926090000_0060_production_list_requires_installation.sql
supabase/migrations/20260927090000_0061_design_task_list_requires_design.sql
supabase/migrations/20260928090000_0062_vehicle_load.sql
supabase/migrations/20260929090000_0063_vehicle_load_multi_shop.sql
supabase/migrations/20260930090000_0064_invoice_billing_enhancements.sql
supabase/migrations/20261001090000_0065_zone_bulk_upload_rls.sql
supabase/migrations/20261002090000_0066_remove_public_shop_share_links.sql
```

(`0057` supersedes `0055`/`0056` — its own header says "run this one file," so those two are deliberately left out of this list. `0049`'s public-share-link table is deliberately left out too — `0066` cleanly removes that feature, so there's no point creating it just to drop it again.)

## ⚠️ Client portal showing "no photos" or unmarked survey photos?

If a Client Organization login can see a shop but its survey photos show unmarked (no board outline drawn) or its installation photos don't appear at all, this is **almost always a missing-migration problem, not a code bug** — the client-facing read access to this data was added in a specific, later pass and is easy to miss if you're not doing a full `db push`:

- `0037`–`0039` — the Client Organization platform itself (without these, there's no client login/portal at all).
- `0040` — gives a client_org user SELECT access to `survey_photos` and `installation_proofs` rows. Without this, both photo sections show empty ("None uploaded yet.") even though the photos genuinely exist — RLS silently returns zero rows, with no error to signal why.
- `0052` — gives a client_org user SELECT access to `board_markings` and `work_items`. Without this specifically, survey photos DO load, but always render as the **plain, unmarked** photo — the board outline/label never appears, because the marking data itself was invisible to the query. This is the single most likely explanation if survey photos show but never look "marked."

Run `supabase db push` (or the two files above, in order) and refresh — no app code changes are needed for this specific symptom, the fix is entirely in these two RLS migrations.


- `0013` turns on **Realtime** for the app's tables, so the Admin/Owner
  dashboard and every review queue update live instead of only on reload.
- `0014` adds the **Installation Review** approval gate — without it, the
  new `/installation-review` page will exist in the app but the underlying
  `installation_jobs.review_status` / `shops.status = 'installation_review'`
  values it depends on won't be valid in your database yet, and completing
  an installation from the mobile app will fail.
- `0018` adds the **design marking system** the Design Studio page now
  depends on (`design_version_items`, the table that links an uploaded
  design file to the specific board(s)/work item(s) it covers). Without it,
  the redesigned Designer dashboard's "Boards to design" checklist and
  multi-file upload will fail to save.
- `0019` adds a uniqueness constraint on `production_items` (one row per
  order + board) that the redesigned Production Studio page needs to
  safely record/edit produced quantity per board. Without it, re-editing a
  board's produced quantity would insert a duplicate row instead of
  updating the existing one, and reports would double-count.
- `0030` adds the three `work_items` columns the new **PO Budget Check**
  banner (Survey wizard + Survey Review) needs to store an Admin/Owner's
  variance adjustment note. Without it, approving a survey whose measurement
  exceeds its PO line item's budget and typing a note will fail to save
  that note (the banner itself still displays fine either way — only the
  note-saving part depends on this migration).
- `0031` adds `design_versions.source` (client-provided vs agency-designed)
  that the Designer's upload modal now writes. Without it, uploading a
  design and picking a source will fail — the field itself still shows in
  the UI, it just won't have anywhere to save.
- `0033` adds `profiles.client_id` and tightens RLS so a **Client Manager**
  account can be scoped to just their own client's shops/PO/rate/invoice
  data (Owner Console → Add/Edit User → Client picker, only shown for the
  Client Manager role). Without it, the new Client picker in Owner Console
  will show but saving it will fail — and every Client Manager keeps
  seeing every client's data org-wide (today's behaviour), which is safe
  but not scoped.
- `0034` adds the standalone **`supply_destinations`** table (doc Section
  4.2's literal schema) that Supply Orders now writes to alongside the
  existing shop-based Supply Only flow. Without it, creating a new Supply
  Only entry or dispatch will still work exactly as before (the sync is
  wrapped defensively and only logs a console warning if this table is
  missing) — you just won't get the standalone destination-report table
  until this runs.
- `0035` adds `angle`/`phash`/`duplicate_flag`/`duplicate_of` on
  `installation_proofs` and `gps_distance_meters`/`gps_distance_flag` on
  `installation_jobs` — the Installer app's new Front+Side photo
  requirement, duplicate-photo detection, and GPS-plausibility flag all
  write to these columns. Without it, submitting an installation will fail
  outright (the insert/update will be rejected for unknown columns).

## The full approval chain, after every migration above is applied
1. **Survey** — Surveyor submits → Admin/Owner **Survey Review**:
   Approve / Reject / Request Correction.
2. **Design** — Approved survey creates a design task → Designer sends it
   for review → Admin/Owner **Design Queue**: Approve / Reject (revision).
3. **Production** — Approved design creates a production order → Production
   marks it complete → Admin/Owner **Production**: Approve as Completed.
4. **Installation** — Approved production lets Installer start the job →
   Installer completes it → Admin/Owner **Installation Review**:
   Approve / Reject-Redo. Only Approve here sets the shop to `installed`.
5. **Billing** — Only shops with status `installed` (i.e. installation
   already approved) are eligible to be invoiced on the **Billing** page.

Every one of those Approve/Reject actions is enforced by a database
trigger, not just a UI button — a direct API call skipping a stage or
coming from the wrong role is rejected by Postgres itself.

## After running it
- Log in as `owner@darshanadagency.com` (or your Admin account).
- The sidebar now shows a small red count next to **Survey Review / Design
  Queue / Production / Installation Review** whenever something needs your
  action.
- Submit a fresh test survey from a Surveyor login, approve it, push it
  through Design → Production → Installation from each role's mobile/queue
  screen, and confirm it lands in **Installation Review** before it shows
  as "Installed" anywhere (Dashboard, Shop Timeline, Billing).

See `CHANGES.md` for the full technical write-up of everything found and
fixed in this pass (and every earlier pass).
