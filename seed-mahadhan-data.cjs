/**
 * seed-mahadhan-data.js
 * -----------------------------------------------------------------------
 * Populates Darshan Ad Agency's live Supabase DB with a full, realistic
 * DUMMY dataset for the client "Mahadhan Agritech" — 5 campaigns, 8 work
 * orders (purchase_orders) under them, ~130 shops spread across the
 * requested zones, and for every shop the correct chain of records
 * (survey -> approval -> design -> production -> installation -> billing)
 * matching whatever stage that shop has been dummied-up to reach.
 *
 * WHY THIS IS A SCRIPT AND NOT DONE DIRECTLY BY CLAUDE
 * -----------------------------------------------------------------------
 * This is your live production Supabase project. Claude's sandboxed
 * bash tool can only reach a small allow-listed set of domains and
 * supabase.co is not on it, so it cannot call your database directly
 * from that chat sandbox. Running this script from your own machine (or
 * Claude Code, which has full network access) does the same job safely.
 *
 * EVERYTHING THIS SCRIPT CREATES IS TAGGED
 * -----------------------------------------------------------------------
 * Every row this script creates carries the tag defined in SEED_TAG below
 * -- in shops.extra_details.seed_tag, purchase_orders.notes, campaigns
 * .description, and invoices.notes. To wipe every bit of this dummy data
 * later, filter on that tag (a ready-to-use cleanup SQL block is at the
 * bottom of this file, commented out).
 *
 * HOW TO RUN
 * -----------------------------------------------------------------------
 *   npm install @supabase/supabase-js
 *   export SUPABASE_URL="https://miqtgtasbxtgtaiowyeb.supabase.co"
 *   export SUPABASE_SERVICE_ROLE_KEY="...."      # the service_role secret
 *   node seed-mahadhan-data.js
 *
 * It is safe to re-run: campaigns/POs are looked up by name/po_number
 * before insert, and shops are only created once per run (re-running
 * will add a second batch of shops rather than duplicate the same PO
 * against itself indefinitely — if you only want ONE batch, just run it
 * once).
 *
 * IMPORTANT ASSUMPTIONS (read before running)
 * -----------------------------------------------------------------------
 *  1. Your agency org already exists with a name containing "Darshan".
 *  2. Your agency already has a `clients` row for Mahadhan (name
 *     containing "Mahadhan"). If not found, one is created.
 *  3. A client-type `organizations` row for Mahadhan is looked up /
 *     created (needed because `campaigns.client_org_id` points at
 *     organizations, not at your agency's internal `clients` table).
 *  4. At least ONE profile (any role) exists in your agency org — it's
 *     reused wherever a surveyor_id / installer_id / uploaded_by /
 *     designer_id foreign key is required. Roles are matched where
 *     possible (surveyor for surveys, installer for installation_jobs)
 *     and otherwise fall back to any available profile.
 *  5. Photos are NOT uploaded to Supabase Storage — photo_url points at
 *     placehold.co placeholder images (clearly labelled, e.g. "Shop
 *     Front — Nashik"), and storage_path is a synthetic string. This
 *     satisfies the app's NOT NULL columns without needing real files.
 *     Swap PLACEHOLDER photo generation for real uploads later if you
 *     want actual photos in Storage.
 */

const { createClient } = require('@supabase/supabase-js');

// ============================== CONFIG ==================================

const SEED_TAG = 'MAHADHAN_DUMMY_2026_08';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY env vars first.');
  process.exit(1);
}

const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

// Status buckets requested: 40% billed, 30% installed/dispatched (pending
// bill), 20% mid-process, 10% early stage.
const STATUS_WEIGHTS = { billed: 0.40, doneNoBill: 0.30, mid: 0.20, early: 0.10 };

// -------------------------------------------------------------------------
// Work orders (= purchase_orders) to create, grouped under their campaign.
// Real PO numbers/dates/amounts come straight from the PDFs you shared;
// the ones with no matching PDF (extra MS-Pole & Hoarding zones) are
// clearly marked isDummyPo:true and get a generated PO number + a
// plausible amount, since you didn't upload a document for those.
// -------------------------------------------------------------------------
const CAMPAIGNS = [
  {
    key: 'inshop_branding',
    name: 'Inshop Branding — Pan India',
    workType: 'Inshop Branding',
    fulfillment: 'survey_install',
    workOrders: [
      {
        zoneLabel: 'Pan India',
        poNumber: '2999025524',
        poDate: '2025-12-30',
        totalAmount: 10643812.40,
        name: 'Inshop Branding — Pan India',
        shopCount: 30,
        cityPool: PAN_INDIA_CITIES(),
      },
    ],
  },
  {
    key: 'ms_pole_hoardings',
    name: 'MS Pole Hoardings (Survey + Install)',
    workType: 'MS Pole Hoarding',
    fulfillment: 'survey_install',
    workOrders: [
      {
        zoneLabel: 'S1 - Karnataka',
        poNumber: '2999025559',
        poDate: '2026-01-13',
        totalAmount: 855500.00,
        name: 'MS Pole Hoardings — S1 Karnataka',
        shopCount: 12,
        cityPool: cities('Karnataka', ['Bengaluru', 'Mysuru', 'Hubballi', 'Belagavi', 'Mangaluru', 'Kalaburagi']),
      },
      {
        zoneLabel: 'C1 - North Maharashtra, Marathwada, Vidarbha',
        poNumber: '2999026710',
        poDate: '2026-02-10',
        totalAmount: 612000.00,
        name: 'MS Pole Hoardings — C1',
        shopCount: 14,
        isDummyPo: true,
        cityPool: [
          ...cities('Maharashtra', ['Jalgaon', 'Dhule', 'Nashik', 'Nandurbar']),
          ...cities('Maharashtra', ['Aurangabad', 'Jalna', 'Beed', 'Latur']),
          ...cities('Maharashtra', ['Nagpur', 'Amravati', 'Akola', 'Yavatmal']),
        ],
      },
      {
        zoneLabel: 'C2 - Pune, Marathwada South Maharashtra',
        poNumber: '2999026711',
        poDate: '2026-02-18',
        totalAmount: 588000.00,
        name: 'MS Pole Hoardings — C2',
        shopCount: 14,
        isDummyPo: true,
        cityPool: [
          ...cities('Maharashtra', ['Pune', 'Solapur', 'Satara', 'Sangli']),
          ...cities('Maharashtra', ['Nanded', 'Parbhani', 'Hingoli', 'Osmanabad']),
        ],
      },
    ],
  },
  {
    key: 'hoardings',
    name: 'Hoardings (Survey + Install)',
    workType: 'Hoarding',
    fulfillment: 'survey_install',
    workOrders: [
      {
        zoneLabel: 'Maharashtra - C1,C2',
        poNumber: '2999025846',
        poDate: '2026-04-27',
        totalAmount: 4930000.00,
        name: 'Hoardings — Maharashtra C1,C2',
        shopCount: 15,
        cityPool: [
          ...cities('Maharashtra', ['Rajkot-style Belt: Kolhapur', 'Ratnagiri', 'Nashik', 'Nagpur']),
          ...cities('Maharashtra', ['Aurangabad', 'Pune', 'Nanded', 'Amravati']),
        ],
      },
      {
        zoneLabel: 'Gujarat, MP',
        poNumber: '2999026750',
        poDate: '2026-05-05',
        totalAmount: 3450000.00,
        name: 'Hoardings — Gujarat, MP',
        shopCount: 15,
        isDummyPo: true,
        cityPool: [
          ...cities('Gujarat', ['Rajkot', 'Ahmedabad', 'Surat', 'Vadodara', 'Bhavnagar']),
          ...cities('Madhya Pradesh', ['Indore', 'Bhopal', 'Jabalpur', 'Gwalior']),
        ],
      },
    ],
  },
  {
    key: 'flex_printing',
    name: 'Flex Printing — Pan India',
    workType: 'Flex Printing',
    fulfillment: 'supply_only',
    workOrders: [
      {
        zoneLabel: 'Pan India',
        poNumber: '2999025696',
        poDate: '2026-02-20',
        totalAmount: 566400.00,
        name: 'Flex Printing — Pan India',
        shopCount: 15,
        cityPool: PAN_INDIA_CITIES(),
      },
    ],
  },
  {
    key: 'foam_sheet',
    name: 'Foam Sheet — Pan India',
    workType: 'Foam Sheet',
    fulfillment: 'supply_only',
    workOrders: [
      {
        zoneLabel: 'Pan India',
        poNumber: '2999026603',
        poDate: '2026-05-26',
        totalAmount: 1090320.00,
        name: 'Foam Sheet — Pan India',
        shopCount: 15,
        cityPool: PAN_INDIA_CITIES(),
      },
    ],
  },
];

function cities(state, list) {
  return list.map((city) => ({ city: city.replace(/^.*Belt: /, ''), state }));
}

function PAN_INDIA_CITIES() {
  return [
    { city: 'Jalgaon', state: 'Maharashtra' },
    { city: 'Pune', state: 'Maharashtra' },
    { city: 'Nashik', state: 'Maharashtra' },
    { city: 'Nagpur', state: 'Maharashtra' },
    { city: 'Ahmedabad', state: 'Gujarat' },
    { city: 'Surat', state: 'Gujarat' },
    { city: 'Indore', state: 'Madhya Pradesh' },
    { city: 'Bhopal', state: 'Madhya Pradesh' },
    { city: 'Bengaluru', state: 'Karnataka' },
    { city: 'Hubballi', state: 'Karnataka' },
    { city: 'Jaipur', state: 'Rajasthan' },
    { city: 'Lucknow', state: 'Uttar Pradesh' },
    { city: 'Kanpur', state: 'Uttar Pradesh' },
    { city: 'Patna', state: 'Bihar' },
    { city: 'Kolkata', state: 'West Bengal' },
    { city: 'Guwahati', state: 'Assam' },
    { city: 'Hyderabad', state: 'Telangana' },
    { city: 'Chennai', state: 'Tamil Nadu' },
    { city: 'Ludhiana', state: 'Punjab' },
    { city: 'Raipur', state: 'Chhattisgarh' },
  ];
}

const SHOP_NAME_TEMPLATES = [
  'Mahadhan Krishi Kendra',
  'Shree Ganesh Krishi Seva Kendra',
  'Kisan Agro Center',
  'Annapurna Beej Bhandar',
  'Jai Kisan Fertilizer Store',
  'Bhoomi Agro Agency',
  'Sanjivani Krishi Kendra',
  'New Balaji Fertilizers',
  'Krishak Mitra Agro Store',
  'Om Sai Krishi Seva Kendra',
  'Green Field Agro Center',
  'Shivshakti Beej Bhandar',
];

// ============================== HELPERS ==================================

function pick(arr, i) { return arr[i % arr.length]; }
// Real photographs (not colored placeholder boxes) — picsum.photos serves an
// actual stock photo deterministically per seed string, so the same shop
// always gets the same picture across re-runs, and every shop/photo-type
// combination gets a different-looking real photo.
function placeholderPhoto(seed) {
  const safeSeed = encodeURIComponent(seed).slice(0, 80);
  return `https://picsum.photos/seed/${safeSeed}/1024/768`;
}
function isoDaysAgo(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString();
}
function dateDaysAgo(days) {
  return isoDaysAgo(days).slice(0, 10);
}

async function upsertByMatch(table, matchCol, matchVal, insertRow, selectCols = '*') {
  const { data: existing, error: selErr } = await sb
    .from(table).select(selectCols).ilike(matchCol, `%${matchVal}%`).limit(1);
  if (selErr) throw selErr;
  if (existing && existing.length) return existing[0];
  const { data: created, error: insErr } = await sb.from(table).insert(insertRow).select(selectCols).single();
  if (insErr) throw insErr;
  return created;
}

// ============================== MAIN ======================================

async function cleanupPreviousSeedBatch() {
  console.log(`--- Cleaning up any previous run tagged ${SEED_TAG} (safe to re-run) ---`);
  const { data: taggedShops } = await sb.from('shops').select('id').eq('extra_details->>seed_tag', SEED_TAG);
  const shopIds = (taggedShops || []).map((s) => s.id);
  const { data: taggedPOs } = await sb.from('purchase_orders').select('id').ilike('notes', `%${SEED_TAG}%`);
  const poIds = (taggedPOs || []).map((p) => p.id);
  const { data: taggedCampaigns } = await sb.from('campaigns').select('id').ilike('description', `%${SEED_TAG}%`);
  const campaignIds = (taggedCampaigns || []).map((c) => c.id);

  if (!shopIds.length && !poIds.length && !campaignIds.length) {
    console.log('Nothing to clean up — first run.');
    return;
  }

  if (shopIds.length) {
    const { data: invIds } = await sb.from('invoice_items').select('invoice_id').in('shop_id', shopIds);
    const invoiceIds = [...new Set((invIds || []).map((r) => r.invoice_id))];
    if (invoiceIds.length) {
      await sb.from('invoice_items').delete().in('invoice_id', invoiceIds);
      await sb.from('invoices').delete().in('id', invoiceIds);
    }
    const { data: jobs } = await sb.from('installation_jobs').select('id').in('shop_id', shopIds);
    const jobIds = (jobs || []).map((j) => j.id);
    if (jobIds.length) {
      await sb.from('installation_proofs').delete().in('installation_job_id', jobIds);
      await sb.from('installation_jobs').delete().in('id', jobIds);
    }
    const { data: prodOrders } = await sb.from('production_orders').select('id').in('shop_id', shopIds);
    const prodIds = (prodOrders || []).map((p) => p.id);
    if (prodIds.length) {
      await sb.from('production_items').delete().in('production_order_id', prodIds);
      await sb.from('production_orders').delete().in('id', prodIds);
    }
    const { data: designTasks } = await sb.from('design_tasks').select('id').in('shop_id', shopIds);
    const dtIds = (designTasks || []).map((d) => d.id);
    if (dtIds.length) {
      await sb.from('design_versions').delete().in('design_task_id', dtIds);
      await sb.from('design_tasks').delete().in('id', dtIds);
    }
    await sb.from('approvals').delete().in('shop_id', shopIds);
    const { data: surveys } = await sb.from('surveys').select('id').in('shop_id', shopIds);
    const surveyIds = (surveys || []).map((s) => s.id);
    if (surveyIds.length) {
      const { data: sPhotos } = await sb.from('survey_photos').select('id').in('survey_id', surveyIds);
      const sPhotoIds = (sPhotos || []).map((p) => p.id);
      if (sPhotoIds.length) await sb.from('board_markings').delete().in('survey_photo_id', sPhotoIds);
      await sb.from('survey_photos').delete().in('survey_id', surveyIds);
    }
    await sb.from('work_items').delete().in('shop_id', shopIds);
    await sb.from('surveys').delete().in('shop_id', shopIds);
    await sb.from('shops').delete().in('id', shopIds);
  }
  if (poIds.length) {
    await sb.from('po_line_items').delete().in('purchase_order_id', poIds);
    await sb.from('purchase_orders').delete().in('id', poIds);
  }
  if (campaignIds.length) {
    await sb.from('campaigns').delete().in('id', campaignIds);
  }
  console.log(`Cleaned: ${shopIds.length} shops, ${poIds.length} POs, ${campaignIds.length} campaigns.`);
}

async function main() {
  await cleanupPreviousSeedBatch();

  console.log('--- Resolving agency org (Darshan) ---');
  const { data: agencyOrgs, error: aErr } = await sb.from('organizations').select('*').ilike('name', '%Darshan%').limit(1);
  if (aErr) throw aErr;
  if (!agencyOrgs.length) throw new Error('Could not find an organization with "Darshan" in the name. Create the agency org first.');
  const agencyOrg = agencyOrgs[0];
  console.log('Agency org:', agencyOrg.id, agencyOrg.name);

  console.log('--- Resolving/creating client organization (Mahadhan) ---');
  const clientOrg = await upsertByMatch(
    'organizations', 'name', 'Mahadhan',
    { name: 'Mahadhan Agritech Limited', org_type: 'client', default_currency: 'INR', default_unit: 'sqft' }
  );
  console.log('Client org:', clientOrg.id, clientOrg.name);

  console.log('--- Resolving/creating agency-internal clients row for Mahadhan ---');
  const clientRow = await upsertByMatch(
    'clients', 'name', 'Mahadhan',
    {
      organization_id: agencyOrg.id,
      name: 'Mahadhan Agritech Limited',
      contact_person: 'Nagesh Shete',
      contact_email: 'nagesh.shete@dfpcl.com',
      address: 'Sai Hira, Survey No. 93, Mundhwa, Pune',
      city: 'Pune', state: 'Maharashtra',
      gst_number: '27AACCA5046P2ZC',
      is_demo: true,
    }
  );
  console.log('Agency clients row:', clientRow.id, clientRow.name);

  console.log('--- Loading agency profiles (for surveyor/installer/designer fallbacks) ---');
  const { data: profiles, error: pErr } = await sb.from('profiles').select('*').eq('organization_id', agencyOrg.id).eq('is_active', true);
  if (pErr) throw pErr;
  if (!profiles.length) throw new Error('No active profiles found in the agency org — need at least one user to assign as surveyor/installer/etc.');
  const byRole = (role) => profiles.filter((p) => p.role === role);
  const anyProfile = () => profiles[0];
  const surveyor = () => (byRole('surveyor')[0] || anyProfile());
  const installer = () => (byRole('installer')[0] || anyProfile());
  const designer = () => (byRole('designer')[0] || anyProfile());
  const uploader = () => anyProfile();
  console.log(`Found ${profiles.length} profiles.`);

  console.log('--- Ensuring work_types ---');
  const workTypeCache = {};
  for (const c of CAMPAIGNS) {
    if (workTypeCache[c.workType]) continue;
    const wt = await upsertByMatch('work_types', 'name', c.workType, {
      organization_id: agencyOrg.id, name: c.workType, description: `${c.workType} (seeded)`,
    });
    workTypeCache[c.workType] = wt;
  }
  console.log('Work types ready:', Object.keys(workTypeCache));

  let totalShopsCreated = 0;
  let statusCounters = { billed: 0, doneNoBill: 0, mid: 0, early: 0 };

  for (const campaign of CAMPAIGNS) {
    console.log(`\n=== Campaign: ${campaign.name} ===`);
    const { data: campaignRow, error: cErr } = await sb.from('campaigns').insert({
      client_org_id: clientOrg.id,
      name: campaign.name,
      description: `[${SEED_TAG}] Seeded campaign for ${campaign.name}`,
      status: 'active',
    }).select().single();
    if (cErr) throw cErr;
    console.log('Campaign created:', campaignRow.id);

    for (const wo of campaign.workOrders) {
      console.log(`  -- Work order: ${wo.name} (PO ${wo.poNumber})${wo.isDummyPo ? ' [generated, no source PDF]' : ''}`);
      const { data: poRow, error: poErr } = await sb.from('purchase_orders').insert({
        organization_id: agencyOrg.id,
        client_id: clientRow.id,
        campaign_id: campaignRow.id,
        po_number: wo.poNumber,
        name: wo.name,
        po_date: wo.poDate,
        fulfillment_type: campaign.fulfillment,
        total_amount: wo.totalAmount,
        status: 'active',
        notes: `[${SEED_TAG}] Zone: ${wo.zoneLabel}.${wo.isDummyPo ? ' Generated for demo dataset (no matching client PO document uploaded).' : ' Matches uploaded client PO document.'}`,
        is_demo: true,
      }).select().single();
      if (poErr) throw poErr;
      wo.poRowId = poRow.id;

      const { data: lineItem, error: liErr } = await sb.from('po_line_items').insert({
        organization_id: agencyOrg.id,
        purchase_order_id: poRow.id,
        work_type_id: workTypeCache[campaign.workType].id,
        description: `${campaign.workType} — ${wo.zoneLabel}`,
        uom: 'piece',
        budgeted_qty: wo.shopCount,
        rate: Math.round(wo.totalAmount / wo.shopCount),
      }).select().single();
      if (liErr) throw liErr;

      // ---- create shops for this work order ----
      for (let i = 0; i < wo.shopCount; i++) {
        const loc = pick(wo.cityPool, i);
        const shopName = `${pick(SHOP_NAME_TEMPLATES, i + wo.poNumber.length)} - ${loc.city}`;
        const bucket = pickStatusBucket(statusCounters, STATUS_WEIGHTS);
        statusCounters[bucket]++;

        const shopStatus = resolveShopStatus(bucket, campaign.fulfillment);

        const { data: shop, error: shopErr } = await sb.from('shops').insert({
          organization_id: agencyOrg.id,
          client_id: clientRow.id,
          purchase_order_id: poRow.id,
          name: shopName,
          owner_name: `Owner ${i + 1} - ${loc.city}`,
          contact_phone: `9${String(100000000 + Math.floor(Math.random() * 899999999))}`,
          address: `${Math.floor(Math.random() * 200) + 1}, Main Market Road, ${loc.city}`,
          city: loc.city,
          district: loc.city,
          zone: wo.zoneLabel,
          state: loc.state,
          status: shopStatus,
          is_demo: true,
          extra_details: { seed_tag: SEED_TAG, campaign: campaign.name, work_order: wo.name },
        }).select().single();
        if (shopErr) throw shopErr;

        await buildShopPipeline({
          sb, shop, campaign, wo, poLineItem: lineItem, bucket, shopStatus,
          agencyOrg, clientRow, surveyor, installer, designer, uploader, SEED_TAG,
        });

        totalShopsCreated++;
      }
      console.log(`     ${wo.shopCount} shops created for this work order.`);
    }
  }

  console.log('\n=== DONE ===');
  console.log('Total shops created:', totalShopsCreated);
  console.log('Status split:', statusCounters);
}

function pickStatusBucket(counters, weights) {
  // simple weighted random
  const r = Math.random();
  let acc = 0;
  for (const [bucket, w] of Object.entries(weights)) {
    acc += w;
    if (r <= acc) return bucket;
  }
  return 'early';
}

function resolveShopStatus(bucket, fulfillment) {
  if (fulfillment === 'supply_only') {
    switch (bucket) {
      case 'billed': return 'billed';
      case 'doneNoBill': return 'dispatched';
      case 'mid': return pick(['production_pending', 'in_production', 'production_ready'], Math.floor(Math.random() * 3));
      default: return 'pending';
    }
  }
  switch (bucket) {
    case 'billed': return 'billed';
    case 'doneNoBill': return 'installed';
    case 'mid': return pick(['surveyed', 'approved', 'designing', 'design_ready', 'in_production'], Math.floor(Math.random() * 5));
    default: return pick(['pending', 'assigned', 'survey_started'], Math.floor(Math.random() * 3));
  }
}

// Builds the correct chain of child rows (survey/design/production/
// installation/invoice) so the shop's status is backed by real, consistent
// records rather than just a status string sitting on its own.
async function buildShopPipeline(ctx) {
  const { sb, shop, campaign, wo, poLineItem, shopStatus, agencyOrg, clientRow, surveyor, installer, designer, uploader, SEED_TAG } = ctx;
  const surveyInstall = campaign.fulfillment === 'survey_install';

  const reachedStage = (stage) => {
    const order = ['pending', 'assigned', 'survey_started', 'surveyed', 'approved', 'designing', 'design_ready',
      'in_production', 'production_pending', 'production_ready', 'production_done', 'dispatched',
      'installed', 'billed'];
    return order.indexOf(shopStatus) >= order.indexOf(stage) || shopStatus === 'billed' || shopStatus === 'installed' || shopStatus === 'dispatched';
  };

  let survey = null;
  let workItem = null;

  if (surveyInstall && shopStatus !== 'pending' && shopStatus !== 'assigned') {
    // ---- survey ----
    const { data: s, error: sErr } = await sb.from('surveys').insert({
      organization_id: agencyOrg.id,
      shop_id: shop.id,
      surveyor_id: surveyor().id,
      status: 'approved',
      gps_lat: 18 + Math.random() * 8,
      gps_lng: 73 + Math.random() * 8,
      gps_captured_at: isoDaysAgo(60),
      notes: `[${SEED_TAG}] Site survey completed.`,
      submitted_at: isoDaysAgo(58),
      reviewed_at: isoDaysAgo(56),
      reviewed_by: surveyor().id,
    }).select().single();
    if (sErr) throw sErr;
    survey = s;

    await sb.from('survey_photos').insert([
      { organization_id: agencyOrg.id, survey_id: survey.id, shop_id: shop.id, storage_path: `${agencyOrg.id}/${shop.id}/front.jpg`, photo_url: placeholderPhoto(`front-${shop.id}`), photo_type: 'shop_front' },
      { organization_id: agencyOrg.id, survey_id: survey.id, shop_id: shop.id, storage_path: `${agencyOrg.id}/${shop.id}/marked.jpg`, photo_url: placeholderPhoto(`marked-${shop.id}`), photo_type: 'marked' },
    ]);

    // ---- work item ----
    const width = 8 + Math.floor(Math.random() * 8);
    const height = 4 + Math.floor(Math.random() * 4);
    const { data: wi, error: wiErr } = await sb.from('work_items').insert({
      organization_id: agencyOrg.id,
      shop_id: shop.id,
      survey_id: survey.id,
      work_type_name: campaign.workType,
      po_line_item_id: poLineItem.id,
      material: campaign.workType.includes('Foam') ? 'Foam Sheet' : 'ACP + Flex',
      survey_width: width, survey_height: height, survey_unit: 'ft', survey_quantity: 1,
      survey_area: width * height,
      approved_width: width, approved_height: height, approved_unit: 'ft', approved_quantity: 1,
      approved_area: width * height,
      status: reachedStage('installed') ? 'installed' : (reachedStage('in_production') ? 'produced' : (reachedStage('designing') ? 'designed' : 'approved')),
    }).select().single();
    if (wiErr) throw wiErr;
    workItem = wi;

    await sb.from('approvals').insert({
      organization_id: agencyOrg.id, shop_id: shop.id, survey_id: survey.id,
      approval_type: 'internal', status: 'approved', reviewed_by: surveyor().id,
      reviewed_at: isoDaysAgo(55), note: `[${SEED_TAG}] Approved.`,
    });
  }

  // ---- design ----
  if (surveyInstall && reachedStage('designing')) {
    const { data: dt, error: dtErr } = await sb.from('design_tasks').insert({
      organization_id: agencyOrg.id, shop_id: shop.id, designer_id: designer().id,
      status: reachedStage('in_production') ? 'approved' : 'design_ready',
      notes: `[${SEED_TAG}] Design task.`,
      assigned_at: isoDaysAgo(50), completed_at: reachedStage('in_production') ? isoDaysAgo(45) : null,
    }).select().single();
    if (dtErr) throw dtErr;

    await sb.from('design_versions').insert({
      organization_id: agencyOrg.id, design_task_id: dt.id, version_number: 1,
      storage_path: `${agencyOrg.id}/${shop.id}/design_v1.jpg`,
      file_url: placeholderPhoto(`design-${shop.id}`),
      file_name: 'design_v1.jpg', uploaded_by: uploader().id,
      status: reachedStage('in_production') ? 'approved' : 'uploaded',
    });
  }

  // ---- production ----
  let productionOrder = null;
  if (reachedStage('in_production') || reachedStage('production_pending')) {
    const prodStatus = reachedStage('dispatched') || reachedStage('installed') || reachedStage('billed') ? 'completed'
      : (shopStatus === 'production_ready' ? 'ready' : 'in_production');
    const { data: po, error: poErr } = await sb.from('production_orders').insert({
      organization_id: agencyOrg.id, shop_id: shop.id,
      status: prodStatus,
      notes: `[${SEED_TAG}] Production for ${campaign.workType}.`,
    }).select().single();
    if (poErr) throw poErr;
    productionOrder = po;

    await sb.from('production_items').insert({
      organization_id: agencyOrg.id, production_order_id: po.id,
      work_item_id: workItem ? workItem.id : null,
      requested_qty: 1, approved_qty: 1,
      produced_qty: prodStatus === 'completed' ? 1 : null,
    });
  }

  // ---- installation (survey_install only) ----
  if (surveyInstall && (reachedStage('installed') || shopStatus === 'billed')) {
    // DB trigger trg_installation_start_gate requires shops.status to already
    // be one of these BEFORE an installation_jobs row can be inserted. The
    // shop was created with its final target status directly, so flip it to
    // a valid pre-installation state first, then progress it forward for real.
    const { error: preErr } = await sb.from('shops').update({ status: 'production_done' }).eq('id', shop.id);
    if (preErr) throw preErr;

    const { data: job, error: jobErr } = await sb.from('installation_jobs').insert({
      organization_id: agencyOrg.id, shop_id: shop.id, installer_id: installer().id,
      production_order_id: productionOrder ? productionOrder.id : null,
      status: 'completed',
      review_status: 'approved',
      reviewed_by: installer().id,
      reviewed_at: isoDaysAgo(19),
      material_check_confirmed: true,
      material_check_confirmed_by: installer().id,
      material_check_confirmed_at: isoDaysAgo(22),
      gps_lat: 18 + Math.random() * 8, gps_lng: 73 + Math.random() * 8,
      gps_captured_at: isoDaysAgo(20),
      started_at: isoDaysAgo(21), completed_at: isoDaysAgo(20),
      notes: `[${SEED_TAG}] Installation completed.`,
    }).select().single();
    if (jobErr) throw jobErr;

    // Now move the shop to 'installed'. DB trigger trg_installation_review_gate
    // requires the shop to be sitting in 'installation_review' immediately
    // before this — mirrors the real app's Owner/Admin approval step.
    const { error: reviewErr } = await sb.from('shops').update({ status: 'installation_review' }).eq('id', shop.id);
    if (reviewErr) throw reviewErr;
    const { error: postErr } = await sb.from('shops').update({ status: 'installed' }).eq('id', shop.id);
    if (postErr) throw postErr;

    await sb.from('installation_proofs').insert([
      { organization_id: agencyOrg.id, installation_job_id: job.id, shop_id: shop.id, storage_path: `${agencyOrg.id}/${shop.id}/before.jpg`, photo_url: placeholderPhoto(`before-${shop.id}`), photo_type: 'before' },
      { organization_id: agencyOrg.id, installation_job_id: job.id, shop_id: shop.id, storage_path: `${agencyOrg.id}/${shop.id}/after.jpg`, photo_url: placeholderPhoto(`after-${shop.id}`), photo_type: 'installed' },
    ]);

    if (workItem) {
      await sb.from('work_items').update({
        installed_width: workItem.survey_width, installed_height: workItem.survey_height,
        installed_unit: 'ft', installed_quantity: 1,
        installed_area: workItem.survey_area, installed_at: isoDaysAgo(20), status: 'installed',
      }).eq('id', workItem.id);
    }
  }

  // ---- billing ----
  if (shopStatus === 'billed') {
    const amount = Math.round(wo.totalAmount / wo.shopCount);
    const cgst = Math.round(amount * 0.09);
    const sgst = Math.round(amount * 0.09);
    const total = amount + cgst + sgst;
    const invoiceNumber = `DA-${SEED_TAG.slice(-4)}-${shop.id.slice(0, 6).toUpperCase()}`;

    const { data: inv, error: invErr } = await sb.from('invoices').insert({
      organization_id: agencyOrg.id, client_id: clientRow.id,
      purchase_order_id: wo.poRowId,
      invoice_number: invoiceNumber,
      invoice_date: dateDaysAgo(10), due_date: dateDaysAgo(-20),
      subtotal: amount, tax_rate: 18, tax_amount: cgst + sgst, total,
      cgst_rate: 9, cgst_amount: cgst, sgst_rate: 9, sgst_amount: sgst,
      payment_status: 'paid',
      bill_to_name: clientRow.name, bill_to_address: clientRow.address,
      bill_to_city: clientRow.city, bill_to_state: clientRow.state, bill_to_gst: clientRow.gst_number,
      notes: `[${SEED_TAG}] Auto-generated demo invoice for ${shop.name}.`,
    }).select().single();
    if (invErr) throw invErr;

    await sb.from('invoice_items').insert({
      organization_id: agencyOrg.id, invoice_id: inv.id, shop_id: shop.id,
      work_item_id: workItem ? workItem.id : null,
      po_line_item_id: poLineItem ? poLineItem.id : null,
      description: `${campaign.workType} — ${shop.name}`,
      quantity: 1, area: workItem ? workItem.survey_area : null,
      rate: amount, amount,
    });

    // Final state: billed (no gate on this transition, but keep it explicit
    // and separate from the 'installed'/'dispatched' step above).
    const { error: billedErr } = await sb.from('shops').update({ status: 'billed' }).eq('id', shop.id);
    if (billedErr) throw billedErr;
  }
}

main().then(() => process.exit(0)).catch((e) => {
  console.error('SEED FAILED:', e);
  process.exit(1);
});

/* ============================== CLEANUP (optional) =======================
Run this in the Supabase SQL editor if you ever want to remove everything
this script created (identified by the SEED_TAG above, e.g. 'MAHADHAN_DUMMY_2026_08'):

  delete from invoice_items where invoice_id in (select id from invoices where notes ilike '%MAHADHAN_DUMMY_2026_08%');
  delete from invoices where notes ilike '%MAHADHAN_DUMMY_2026_08%';
  delete from installation_proofs where shop_id in (select id from shops where extra_details->>'seed_tag' = 'MAHADHAN_DUMMY_2026_08');
  delete from installation_jobs where shop_id in (select id from shops where extra_details->>'seed_tag' = 'MAHADHAN_DUMMY_2026_08');
  delete from production_items where production_order_id in (select id from production_orders where shop_id in (select id from shops where extra_details->>'seed_tag' = 'MAHADHAN_DUMMY_2026_08'));
  delete from production_orders where shop_id in (select id from shops where extra_details->>'seed_tag' = 'MAHADHAN_DUMMY_2026_08');
  delete from design_versions where design_task_id in (select id from design_tasks where shop_id in (select id from shops where extra_details->>'seed_tag' = 'MAHADHAN_DUMMY_2026_08'));
  delete from design_tasks where shop_id in (select id from shops where extra_details->>'seed_tag' = 'MAHADHAN_DUMMY_2026_08');
  delete from approvals where shop_id in (select id from shops where extra_details->>'seed_tag' = 'MAHADHAN_DUMMY_2026_08');
  delete from board_markings where survey_photo_id in (select id from survey_photos where shop_id in (select id from shops where extra_details->>'seed_tag' = 'MAHADHAN_DUMMY_2026_08'));
  delete from survey_photos where shop_id in (select id from shops where extra_details->>'seed_tag' = 'MAHADHAN_DUMMY_2026_08');
  delete from work_items where shop_id in (select id from shops where extra_details->>'seed_tag' = 'MAHADHAN_DUMMY_2026_08');
  delete from surveys where shop_id in (select id from shops where extra_details->>'seed_tag' = 'MAHADHAN_DUMMY_2026_08');
  delete from shops where extra_details->>'seed_tag' = 'MAHADHAN_DUMMY_2026_08';
  delete from po_line_items where purchase_order_id in (select id from purchase_orders where notes ilike '%MAHADHAN_DUMMY_2026_08%');
  delete from purchase_orders where notes ilike '%MAHADHAN_DUMMY_2026_08%';
  delete from campaigns where description ilike '%MAHADHAN_DUMMY_2026_08%';
============================================================================ */
