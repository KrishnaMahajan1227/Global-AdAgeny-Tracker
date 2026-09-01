/**
 * seed-mahadhan-data-v5.cjs
 * -----------------------------------------------------------------------
 * WHAT CHANGED FROM v4 (per your latest feedback)
 *
 * 1. SHOP COUNTS NOW COME FROM THE PO, NOT MADE UP. The Inshop Branding
 *    PDF literally has two lines labelled "per shop" — Transport &
 *    Installation (110 EA) and Recce Cost (110 EA). That's not a per-unit
 *    material quantity, it's the PO explicitly telling you the job covers
 *    110 shops — so this run seeds exactly 110, not the 30 I'd guessed
 *    before. The other 3 real POs (MS Pole S1 Karnataka 200 hoardings,
 *    Flex Printing 5000 banners, Foam Sheet 3500 sheets) don't have an
 *    equivalent "per shop" line — those are bulk material quantities, not
 *    a shop count (5000 banners doesn't mean 5000 different shops). Since
 *    you also said not to explode this to 500-1000 shops, I've sized
 *    those as a representative rollout batch rather than the full raw
 *    quantity — flagged clearly below so you can tell me the real number
 *    if you have it. Total across all 8 work orders: 345 shops.
 *
 * 2. EVERY WORK ORDER NOW SITS AT A DIFFERENT, DELIBERATE MATURITY —
 *    30% / 42% / 55% / 60% / 68% / 72% / 88%, roughly tracking how old
 *    each PO is (Dec 2025's Inshop Branding is furthest along; May 2026's
 *    Foam Sheet just started) — instead of every work order having the
 *    identical stage mix. maturityWeights() below builds a bell-curve
 *    stage distribution centred on that %, so a "68% mature" work order
 *    genuinely clusters around installation/billing while a "30%" one
 *    clusters around survey/design, with a natural spread either side —
 *    not a hard cutoff.
 *
 * 3. INSHOP BRANDING SHOPS NOW GET SEVERAL WORK ITEMS, NOT ONE. Board
 *    (Foam Sheet or ACP — a shop gets one or the other, not both),
 *    MS Structure and Logo are on every shop (a branding job without a
 *    logo or frame doesn't happen); Flex/StarFlex on ~70%, One Way film
 *    on ~55%, Wall Painting on ~45% — so two shops' work item lists
 *    genuinely differ, like a real rollout where not every location gets
 *    every extra.
 *
 * 4. BOARD MARKINGS WERE ACTUALLY BROKEN — FOUND AND FIXED. Read
 *    src/lib/markingUtils.ts: marking points are stored as PERCENTAGES
 *    (0-100) of image width/height, not pixels — mine were raw pixel
 *    values like {x:180,y:120} on a 1024-wide image, which computes to
 *    18,000%+ off the edge of the canvas. The polygon was being drawn
 *    completely outside the visible image — invisible, which is almost
 *    certainly why "photos" looked broken. Also: board_markings.work_item_id
 *    was left null before, but the app looks up each marking's label
 *    (work type + dimensions burned onto the photo) THROUGH that FK — a
 *    null work_item_id means no label ever renders. Both fixed: markings
 *    are now real percentage polygons, one per marked component, each
 *    correctly linked to its own work_item.
 *
 * 5. EXACTLY 2 FULLY-DOCUMENTED SHOWCASE SHOPS (not 6/15 like before) —
 *    one Inshop Branding shop with several components marked on the same
 *    photo (board, logo, one way, wall paint — however many that shop
 *    actually has), and the real Rajkot shop (single hoarding, backed by
 *    your actual DA2026-27/04 invoice) — each with a proper marked
 *    survey photo, a 2-version design history, and before/after install
 *    photos. Every other shop still gets ordinary single photos at
 *    whatever stage it's genuinely reached — just not the full showcase
 *    treatment, per "kuch hi shops, jyada nahi".
 *
 * Same run instructions as before:
 *   npm install @supabase/supabase-js
 *   export SUPABASE_URL="https://miqtgtasbxtgtaiowyeb.supabase.co"
 *   export SUPABASE_SERVICE_ROLE_KEY="<service_role secret>"
 *   node seed-mahadhan-data-v5.cjs
 */

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY env vars first.');
  process.exit(1);
}
const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const LEGACY_TAGS = ['MAHADHAN_DUMMY_2026_08', 'MAHADHAN_DUMMY_2026_08_V2', 'MAHADHAN_DUMMY_2026_08_V3'];

// ============================== WORK TYPES =================================

const WORK_TYPE_DEFS = {
  'Inshop Branding': 'Complete in-shop dealer board branding (foam sheet/ACP + structure + logo).',
  'Foam Sheet': 'UV-printed foam sheet boards and panels.',
  'ACP': 'Aluminium Composite Panel dealer boards with MS fabricated frame.',
  'Flex': 'Flex printing and banners.',
  'MS Structure': 'MS pipe/pole fabrication and board mounting structure.',
  'Logo': 'Backlit logo and round-flange signage.',
  'One Way': 'One-way vision window film.',
  'Wall Painting': 'Emulsion wall painting.',
  'Shutter': 'Shutter painting and branding.',
  'MS Pole Hoarding': 'Hoardings mounted on fabricated MS poles.',
  'Hoarding': 'Hoarding structure installation (MS structure + Flex/ACP face).',
};

// ============================== CAMPAIGNS ===================================

const CAMPAIGNS = [
  {
    key: 'inshop_branding',
    name: 'Inshop Branding — Pan India',
    description: 'Pan-India in-shop dealer board branding rollout for Mahadhan Agritech — foam sheet, ACP, structure, logo and signage installed at retail points across all zones.',
    workTypeKey: 'Inshop Branding',
    fulfillment: 'survey_install',
    workOrders: [
      {
        zoneLabel: 'Pan India', poNumber: '2999025524', poDate: '2025-12-30',
        name: 'Inshop Branding — Pan India',
        paymentTerms: 'Within 30 days due net', gstPercentage: 18,
        shopCount: 110, // PDF: "Transport & Installation (per shop)" and "Recce Cost (Per shop)" both = 110 EA. Real, exact.
        maturity: 0.88, // oldest PO (Dec 2025) — furthest along
        cityPool: PAN_INDIA_CITIES(),
        lineItems: [
          { description: '5mm Foam Sheet with UV Printing', workTypeKey: 'Foam Sheet', uom: 'piece', budgeted_qty: 7750, rate: 58.00 },
          { description: '3mm Foam Sheet with UV Printing', workTypeKey: 'Foam Sheet', uom: 'piece', budgeted_qty: 24000, rate: 50.00 },
          { description: 'Dealer Board + MS Fabricated Frame + White ACP', workTypeKey: 'ACP', uom: 'piece', budgeted_qty: 8500, rate: 220.00 },
          { description: 'Outer Board + StarFlex + Solvent Print (4 Pass 380 GSM)', workTypeKey: 'Flex', uom: 'piece', budgeted_qty: 2640, rate: 37.00 },
          { description: 'Double Circular Pipes + 16 Gauge Pole', workTypeKey: 'MS Structure', uom: 'piece', budgeted_qty: 9400, rate: 120.00 },
          { description: 'Round Flanges 16in ABS Mould Backlit (3mm VL)', workTypeKey: 'Logo', uom: 'piece', budgeted_qty: 110, rate: 1250.00 },
          { description: 'One Way Vision Film', workTypeKey: 'One Way', uom: 'piece', budgeted_qty: 1500, rate: 35.00 },
          { description: 'Transport & Installation (per shop)', workTypeKey: null, uom: 'piece', budgeted_qty: 110, rate: 8000.00 },
          { description: 'Recce Cost (per shop)', workTypeKey: null, uom: 'piece', budgeted_qty: 110, rate: 1500.00 },
          { description: 'Paint (Emulsion Walls + Oil Paint Shutter)', workTypeKey: 'Wall Painting', uom: 'piece', budgeted_qty: 320000, rate: 9.50 },
        ],
      },
    ],
  },
  {
    key: 'ms_pole_hoardings',
    name: 'MS Pole Hoardings (Survey + Install)',
    description: 'MS pole-mounted hoardings across Karnataka and Maharashtra zones — fabrication, printing and installation.',
    workTypeKey: 'MS Pole Hoarding',
    fulfillment: 'survey_install',
    workOrders: [
      {
        zoneLabel: 'S1 - Karnataka', poNumber: '2999025559', poDate: '2026-01-13',
        name: 'MS Pole Hoardings — S1 Karnataka',
        paymentTerms: 'Within 7 days due net', gstPercentage: 18,
        shopCount: 45, maturity: 0.72, // PDF: 200 EA hoardings total; seeding a representative in-progress batch, not all 200 at once.
        cityPool: cities('Karnataka', ['Bengaluru', 'Mysuru', 'Hubballi', 'Belagavi', 'Mangaluru', 'Kalaburagi']),
        lineItems: [{ description: 'Hoardings with MS Poles & Installation', workTypeKey: 'MS Pole Hoarding', uom: 'piece', budgeted_qty: 200, rate: 3625.00 }],
      },
      {
        zoneLabel: 'C1 - North Maharashtra, Marathwada, Vidarbha', poNumber: '2999026710', poDate: '2026-02-10',
        name: 'MS Pole Hoardings — C1',
        paymentTerms: 'Within 30 days due net', gstPercentage: 18, shopCount: 35, maturity: 0.55, isDummyPo: true,
        cityPool: [
          ...cities('Maharashtra', ['Jalgaon', 'Dhule', 'Nashik', 'Nandurbar']),
          ...cities('Maharashtra', ['Aurangabad', 'Jalna', 'Beed', 'Latur']),
          ...cities('Maharashtra', ['Nagpur', 'Amravati', 'Akola', 'Yavatmal']),
        ],
        lineItems: [{ description: 'Hoardings with MS Poles & Installation', workTypeKey: 'MS Pole Hoarding', uom: 'piece', budgeted_qty: 170, rate: 3600.00 }],
      },
      {
        zoneLabel: 'C2 - Pune, Marathwada South Maharashtra', poNumber: '2999026711', poDate: '2026-02-18',
        name: 'MS Pole Hoardings — C2',
        paymentTerms: 'Within 30 days due net', gstPercentage: 18, shopCount: 35, maturity: 0.42, isDummyPo: true,
        cityPool: [
          ...cities('Maharashtra', ['Pune', 'Solapur', 'Satara', 'Sangli']),
          ...cities('Maharashtra', ['Nanded', 'Parbhani', 'Hingoli', 'Osmanabad']),
        ],
        lineItems: [{ description: 'Hoardings with MS Poles & Installation', workTypeKey: 'MS Pole Hoarding', uom: 'piece', budgeted_qty: 160, rate: 3675.00 }],
      },
    ],
  },
  {
    key: 'hoardings',
    name: 'Hoardings (Survey + Install)',
    description: 'Standalone hoarding installations (MS structure + Flex/ACP face) across Maharashtra, Gujarat and Madhya Pradesh.',
    workTypeKey: 'Hoarding',
    fulfillment: 'survey_install',
    workOrders: [
      {
        zoneLabel: 'Maharashtra - C1,C2', poNumber: '2999025846', poDate: '2026-04-20',
        name: 'Hoardings — Maharashtra C1,C2',
        paymentTerms: 'Within 30 days due net', gstPercentage: 18, shopCount: 30, maturity: 0.68, isEstimatedTotal: true,
        cityPool: [
          { city: 'Rajkot', state: 'Gujarat' },
          ...cities('Maharashtra', ['Kolhapur', 'Ratnagiri', 'Nashik', 'Nagpur']),
          ...cities('Maharashtra', ['Aurangabad', 'Pune', 'Nanded', 'Amravati']),
        ],
        lineItems: [{ description: 'Hoarding Installation (MS Structure + Flex/ACP)', workTypeKey: 'Hoarding', uom: 'piece', budgeted_qty: 1436, rate: 4525.00 }],
      },
      {
        zoneLabel: 'Gujarat, MP', poNumber: '2999026750', poDate: '2026-05-05',
        name: 'Hoardings — Gujarat, MP',
        paymentTerms: 'Within 30 days due net', gstPercentage: 18, shopCount: 30, maturity: 0.35, isDummyPo: true,
        cityPool: [
          ...cities('Gujarat', ['Rajkot', 'Ahmedabad', 'Surat', 'Vadodara', 'Bhavnagar']),
          ...cities('Madhya Pradesh', ['Indore', 'Bhopal', 'Jabalpur', 'Gwalior']),
        ],
        lineItems: [{ description: 'Hoarding Installation (MS Structure + Flex/ACP)', workTypeKey: 'Hoarding', uom: 'piece', budgeted_qty: 750, rate: 4600.00 }],
      },
    ],
  },
  {
    key: 'flex_printing',
    name: 'Flex Printing — Pan India',
    description: 'Pan-India flex banner printing and supply — no site survey or installation, printed and dispatched to each location.',
    workTypeKey: 'Flex',
    fulfillment: 'supply_only',
    workOrders: [{
      zoneLabel: 'Pan India', poNumber: '2999025696', poDate: '2026-02-20',
      name: 'Flex Printing — Pan India',
      paymentTerms: 'Within 30 days due net', gstPercentage: 18,
      shopCount: 30, maturity: 0.60, cityPool: PAN_INDIA_CITIES(), // PDF: 5000 EA banners total — bulk print qty, not a shop count.
      lineItems: [{ description: 'Printing of Flex Banners', workTypeKey: 'Flex', uom: 'piece', budgeted_qty: 5000, rate: 96.00 }],
    }],
  },
  {
    key: 'foam_sheet',
    name: 'Foam Sheet — Pan India',
    description: 'Pan-India foam sheet printing and supply — no site survey or installation, printed and dispatched to each location.',
    workTypeKey: 'Foam Sheet',
    fulfillment: 'supply_only',
    workOrders: [{
      zoneLabel: 'Pan India', poNumber: '2999026603', poDate: '2026-05-26',
      name: 'Foam Sheet — Pan India',
      paymentTerms: 'Within 30 days due net', gstPercentage: 18,
      shopCount: 30, maturity: 0.30, cityPool: PAN_INDIA_CITIES(), // newest PO — least mature, intentionally
      lineItems: [{ description: 'Print Foam Sheet', workTypeKey: 'Foam Sheet', uom: 'piece', budgeted_qty: 3500, rate: 264.00 }],
    }],
  },
];

function cities(state, list) { return list.map((city) => ({ city, state })); }

const CITY_COORDS = {
  Jalgaon: [21.0077, 75.5626], Pune: [18.5204, 73.8567], Nashik: [19.9975, 73.7898], Nagpur: [21.1458, 79.0882],
  Ahmedabad: [23.0225, 72.5714], Surat: [21.1702, 72.8311], Indore: [22.7196, 75.8577], Bhopal: [23.2599, 77.4126],
  Bengaluru: [12.9716, 77.5946], Hubballi: [15.3647, 75.1240], Jaipur: [26.9124, 75.7873], Lucknow: [26.8467, 80.9462],
  Kanpur: [26.4499, 80.3319], Patna: [25.5941, 85.1376], Kolkata: [22.5726, 88.3639], Guwahati: [26.1445, 91.7362],
  Hyderabad: [17.3850, 78.4867], Chennai: [13.0827, 80.2707], Ludhiana: [30.9010, 75.8573], Raipur: [21.2514, 81.6296],
  Mysuru: [12.2958, 76.6394], Belagavi: [15.8497, 74.4977], Mangaluru: [12.9141, 74.8560], Kalaburagi: [17.3297, 76.8343],
  Dhule: [20.9042, 74.7749], Nandurbar: [21.3667, 74.2500], Aurangabad: [19.8762, 75.3433], Jalna: [19.8410, 75.8864],
  Beed: [18.9891, 75.7601], Latur: [18.4088, 76.5604], Amravati: [20.9374, 77.7796], Akola: [20.7002, 77.0082],
  Yavatmal: [20.3888, 78.1204], Solapur: [17.6599, 75.9064], Satara: [17.6805, 74.0183], Sangli: [16.8524, 74.5815],
  Nanded: [19.1383, 77.3210], Parbhani: [19.2704, 76.7749], Hingoli: [19.7145, 77.1490], Osmanabad: [18.1860, 76.0419],
  Kolhapur: [16.7050, 74.2433], Ratnagiri: [16.9902, 73.3120], Rajkot: [22.3039, 70.8022], Vadodara: [22.3072, 73.1812],
  Bhavnagar: [21.7645, 72.1519], Jabalpur: [23.1815, 79.9864], Gwalior: [26.2183, 78.1828],
};

function PAN_INDIA_CITIES() {
  return [
    { city: 'Jalgaon', state: 'Maharashtra' }, { city: 'Pune', state: 'Maharashtra' },
    { city: 'Nashik', state: 'Maharashtra' }, { city: 'Nagpur', state: 'Maharashtra' },
    { city: 'Ahmedabad', state: 'Gujarat' }, { city: 'Surat', state: 'Gujarat' },
    { city: 'Indore', state: 'Madhya Pradesh' }, { city: 'Bhopal', state: 'Madhya Pradesh' },
    { city: 'Bengaluru', state: 'Karnataka' }, { city: 'Hubballi', state: 'Karnataka' },
    { city: 'Jaipur', state: 'Rajasthan' }, { city: 'Lucknow', state: 'Uttar Pradesh' },
    { city: 'Kanpur', state: 'Uttar Pradesh' }, { city: 'Patna', state: 'Bihar' },
    { city: 'Kolkata', state: 'West Bengal' }, { city: 'Guwahati', state: 'Assam' },
    { city: 'Hyderabad', state: 'Telangana' }, { city: 'Chennai', state: 'Tamil Nadu' },
    { city: 'Ludhiana', state: 'Punjab' }, { city: 'Raipur', state: 'Chhattisgarh' },
  ];
}

const SHOP_NAME_TEMPLATES = [
  'Mahadhan Krishi Kendra', 'Shree Ganesh Krishi Seva Kendra', 'Kisan Agro Center',
  'Annapurna Beej Bhandar', 'Jai Kisan Fertilizer Store', 'Bhoomi Agro Agency',
  'Sanjivani Krishi Kendra', 'New Balaji Fertilizers', 'Krishak Mitra Agro Store',
  'Om Sai Krishi Seva Kendra', 'Green Field Agro Center', 'Shivshakti Beej Bhandar',
];
const OWNER_FIRST = ['Ramesh', 'Suresh', 'Ganesh', 'Vijay', 'Santosh', 'Dilip', 'Prakash', 'Anil', 'Mahesh', 'Sunil', 'Rajendra', 'Ashok', 'Bhausaheb', 'Dattatray', 'Vitthal'];
const OWNER_LAST = ['Patil', 'Jadhav', 'Deshmukh', 'Pawar', 'Shinde', 'Kulkarni', 'More', 'Chavan', 'Kadam', 'Bhosale', 'Gaikwad', 'Sawant'];
const LANDMARKS = ['Near Bus Stand', 'Opp. Krishi Seva Kendra', 'Near ST Depot', 'Main Chowk', 'Near District Hospital', 'Opp. Grain Market', 'Near Panchayat Office', 'Highway Road'];
const STREETS = ['Main Market Road', 'Station Road', 'Gandhi Chowk', 'APMC Road', 'College Road', 'Bazar Peth', 'Shivaji Nagar'];

// ============================== STAGE LADDERS ==============================

const SI_ORDER = [
  'pending', 'survey_started', 'surveyed', 'approved', 'designing', 'design_ready',
  'production_pending', 'in_production', 'production_ready', 'production_done',
  'installation_pending', 'installing', 'installation_review', 'installed', 'billed',
];
const SO_ORDER = ['pending', 'production_pending', 'in_production', 'production_ready', 'production_done', 'dispatched', 'billed'];

// `maturity` is the target BILLED fraction directly (0.88 = ~88% of this
// work order's shops are billed) — the remainder tapers backward from
// 'billed' with a geometric decay, so shops-in-progress cluster nearer
// completion than right at the very start. This is what makes "88%
// mature" actually mean ~88% billed, not just "average stage position
// somewhere near the end" (a symmetric bell curve undercounts billed
// itself since half its weight falls on stages that don't exist beyond
// the last one).
function maturityWeights(order, maturity) {
  const n = order.length;
  const billedIdx = n - 1;
  const decay = 0.72;
  let backSum = 0;
  for (let i = 0; i < billedIdx; i++) backSum += Math.pow(decay, billedIdx - i);
  const weights = {};
  order.forEach((s, i) => {
    weights[s] = i === billedIdx ? maturity : (1 - maturity) * (Math.pow(decay, billedIdx - i) / backSum);
  });
  return weights;
}

function allocateStages(order, weights, n) {
  const totalW = order.reduce((a, s) => a + weights[s], 0);
  const raw = order.map((s) => (weights[s] / totalW) * n);
  const counts = raw.map(Math.floor);
  let assigned = counts.reduce((a, c) => a + c, 0);
  const remainders = raw.map((r, i) => [r - counts[i], i]).sort((a, b) => b[0] - a[0]);
  let idx = 0;
  while (assigned < n) { counts[remainders[idx % remainders.length][1]]++; assigned++; idx++; }
  const list = [];
  order.forEach((s, i) => { for (let k = 0; k < counts[i]; k++) list.push(s); });
  for (let i = list.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [list[i], list[j]] = [list[j], list[i]]; }
  return list;
}

// The geometric taper in maturityWeights gives 'surveyed'/'approved' such
// tiny weight on a highly-mature work order that allocateStages can
// legitimately round them down to zero shops — which is exactly what
// starved the Survey Review page's "pending review" tab in testing (0
// surveys with status='submitted', even though 285 existed as
// already-reviewed). The review queue existing at all matters more than
// the proportions being mathematically pure, so every survey+install work
// order is guaranteed at least MIN_PER_KEY_STAGE shops sitting in each of
// these stages, taken from whichever stage currently has the most.
const MIN_PER_KEY_STAGE = 2;
function ensureStagePresence(list, keyStages) {
  const counts = {};
  list.forEach((s) => { counts[s] = (counts[s] || 0) + 1; });
  for (const key of keyStages) {
    let have = counts[key] || 0;
    while (have < MIN_PER_KEY_STAGE && list.length > 0) {
      // pull from the current largest stage that isn't itself a key stage
      // running low, so we don't just rob Peter to pay Paul.
      let donorStage = null, donorCount = -1;
      for (const [s, c] of Object.entries(counts)) {
        if (s === key) continue;
        if (keyStages.includes(s) && c <= MIN_PER_KEY_STAGE) continue;
        if (c > donorCount) { donorCount = c; donorStage = s; }
      }
      if (!donorStage) break;
      const donorIdx = list.indexOf(donorStage);
      list[donorIdx] = key;
      counts[donorStage]--; counts[key] = (counts[key] || 0) + 1;
      have++;
    }
  }
  return list;
}

// ============================== INSHOP BRANDING COMPONENT MIX =============

function pickInshopComponents(shopIdx) {
  const seed = (i) => ((shopIdx * 2654435761 + i * 40503) % 1000) / 1000;
  const board = seed(1) < 0.5 ? 'Foam Sheet' : 'ACP';
  const comps = [board, 'MS Structure', 'Logo'];
  if (seed(2) < 0.70) comps.push('Flex');
  if (seed(3) < 0.55) comps.push('One Way');
  if (seed(4) < 0.45) comps.push('Wall Painting');
  return comps;
}

const MARK_REGIONS = {
  'Foam Sheet': [{ x: 24, y: 14 }, { x: 76, y: 14 }, { x: 76, y: 46 }, { x: 24, y: 46 }],
  'ACP': [{ x: 24, y: 14 }, { x: 76, y: 14 }, { x: 76, y: 46 }, { x: 24, y: 46 }],
  'Logo': [{ x: 40, y: 50 }, { x: 60, y: 50 }, { x: 60, y: 62 }, { x: 40, y: 62 }],
  'One Way': [{ x: 4, y: 20 }, { x: 21, y: 20 }, { x: 21, y: 58 }, { x: 4, y: 58 }],
  'Wall Painting': [{ x: 79, y: 10 }, { x: 97, y: 10 }, { x: 97, y: 70 }, { x: 79, y: 70 }],
  'Hoarding': [{ x: 12, y: 10 }, { x: 88, y: 10 }, { x: 88, y: 55 }, { x: 12, y: 55 }],
  'MS Pole Hoarding': [{ x: 12, y: 10 }, { x: 88, y: 10 }, { x: 88, y: 55 }, { x: 12, y: 55 }],
};

// ============================== HELPERS ==================================

function pick(arr, i) { return arr[i % arr.length]; }
function weightedPick(items, i) {
  const seed = ((i * 2654435761) % 100) / 100;
  let acc = 0;
  for (const [v, w] of items) { acc += w; if (seed < acc) return v; }
  return items[items.length - 1][0];
}
function placeholderPhoto(seed) { return `https://picsum.photos/seed/${encodeURIComponent(seed).slice(0, 80)}/1024/768`; }
function isoDaysAgo(days) { const d = new Date(); d.setDate(d.getDate() - days); return d.toISOString(); }
function dateDaysAgo(days) { return isoDaysAgo(days).slice(0, 10); }
function round2(n) { return Math.round(n * 100) / 100; }
function jitter(v, spread) { return v + (Math.random() - 0.5) * spread; }

function findProfile(profiles, patterns, roleFallback) {
  for (const pat of patterns) {
    const re = new RegExp(pat, 'i');
    const hit = profiles.find((p) => re.test(p.full_name));
    if (hit) return hit;
  }
  if (roleFallback) { const hit = profiles.find((p) => p.role === roleFallback); if (hit) return hit; }
  return profiles[0];
}

// ============================== CLEANUP (no tags needed) ===================

async function cleanupByIdentity(agencyOrg, clientOrg) {
  console.log('--- Cleaning up any previous run of this script (by campaign name / PO number, no tags) ---');
  const campaignNames = CAMPAIGNS.map((c) => c.name);
  const poNumbers = CAMPAIGNS.flatMap((c) => c.workOrders.map((w) => w.poNumber));

  const { data: oldPOs } = await sb.from('purchase_orders').select('id').eq('organization_id', agencyOrg.id).in('po_number', poNumbers);
  const poIds = (oldPOs || []).map((p) => p.id);
  const { data: oldShops } = poIds.length ? await sb.from('shops').select('id').in('purchase_order_id', poIds) : { data: [] };
  const shopIds = (oldShops || []).map((s) => s.id);

  if (shopIds.length) {
    const { data: invIds } = await sb.from('invoice_items').select('invoice_id').in('shop_id', shopIds);
    const invoiceIds = [...new Set((invIds || []).map((r) => r.invoice_id))];
    if (invoiceIds.length) { await sb.from('invoice_items').delete().in('invoice_id', invoiceIds); await sb.from('invoices').delete().in('id', invoiceIds); }
    const { data: jobs } = await sb.from('installation_jobs').select('id').in('shop_id', shopIds);
    const jobIds = (jobs || []).map((j) => j.id);
    if (jobIds.length) { await sb.from('installation_proofs').delete().in('installation_job_id', jobIds); await sb.from('installation_jobs').delete().in('id', jobIds); }
    const { data: prodOrders } = await sb.from('production_orders').select('id').in('shop_id', shopIds);
    const prodIds = (prodOrders || []).map((p) => p.id);
    if (prodIds.length) { await sb.from('production_items').delete().in('production_order_id', prodIds); await sb.from('production_orders').delete().in('id', prodIds); }
    const { data: designTasks } = await sb.from('design_tasks').select('id').in('shop_id', shopIds);
    const dtIds = (designTasks || []).map((d) => d.id);
    if (dtIds.length) { await sb.from('design_versions').delete().in('design_task_id', dtIds); await sb.from('design_tasks').delete().in('id', dtIds); }
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
  if (poIds.length) await sb.from('purchase_orders').delete().in('id', poIds);

  const { data: oldCampaigns } = await sb.from('campaigns').select('id').eq('client_org_id', clientOrg.id).in('name', campaignNames);
  const campaignIds = (oldCampaigns || []).map((c) => c.id);
  if (campaignIds.length) await sb.from('campaigns').delete().in('id', campaignIds);

  console.log(`  Removed: ${shopIds.length} shops, ${poIds.length} POs, ${campaignIds.length} campaigns.`);

  for (const tag of LEGACY_TAGS) {
    const { data: taggedShops } = await sb.from('shops').select('id').eq('extra_details->>seed_tag', tag);
    if (taggedShops && taggedShops.length) console.warn(`  NOTE: ${taggedShops.length} shop(s) still tagged "${tag}" were not caught by name/PO matching.`);
  }
}

// ============================== MAIN ======================================

async function main() {
  const AGENCY_OWNER_PROFILE_ID = '7cfa1e75-e8a5-4edc-8e55-3e0046e88d80'; // Shubham Suryawanshi
  const CLIENT_ADMIN_PROFILE_ID = '38683cad-ae52-4b76-99ba-251d0535d5b0'; // Divyanshu Yadav

  console.log('--- Resolving agency org via Shubham Suryawanshi\'s profile ---');
  const { data: ownerProfile, error: opErr } = await sb.from('profiles').select('*').eq('id', AGENCY_OWNER_PROFILE_ID).single();
  if (opErr || !ownerProfile) throw new Error(`Could not find profile ${AGENCY_OWNER_PROFILE_ID}.`);
  const { data: agencyOrg, error: aErr } = await sb.from('organizations').select('*').eq('id', ownerProfile.organization_id).single();
  if (aErr || !agencyOrg) throw aErr || new Error('Agency org not found.');
  console.log('Agency org:', agencyOrg.id, agencyOrg.name);

  console.log('--- Resolving client org via Divyanshu Yadav\'s profile ---');
  const { data: clientAdminProfile, error: cpErr } = await sb.from('profiles').select('*').eq('id', CLIENT_ADMIN_PROFILE_ID).single();
  if (cpErr || !clientAdminProfile) throw new Error(`Could not find profile ${CLIENT_ADMIN_PROFILE_ID}.`);
  const { data: clientOrg, error: coErr } = await sb.from('organizations').select('*').eq('id', clientAdminProfile.organization_id).single();
  if (coErr || !clientOrg) throw coErr || new Error('Client org not found.');
  console.log('Client org:', clientOrg.id, clientOrg.name);

  await cleanupByIdentity(agencyOrg, clientOrg);

  console.log('--- Resolving agency-internal clients row for Mahadhan ---');
  const { data: existingClientRows } = await sb.from('clients').select('*').ilike('name', '%Mahadhan%').eq('organization_id', agencyOrg.id).limit(1);
  let clientRow = existingClientRows && existingClientRows[0];
  if (!clientRow) {
    const { data: created, error: crErr } = await sb.from('clients').insert({
      organization_id: agencyOrg.id, name: 'Mahadhan Agritech Limited',
      contact_person: 'Nagesh Shete', contact_email: 'nagesh.shete@dfpcl.com',
      address: 'Sai Hira, Survey No. 93, Mundhwa, Pune', city: 'Pune', state: 'Maharashtra',
      gst_number: '27AACCA5046P2ZC',
    }).select().single();
    if (crErr) throw crErr;
    clientRow = created;
  }
  console.log('Agency clients row:', clientRow.id, clientRow.name);

  console.log('--- Loading agency profiles + mapping real team ---');
  const { data: profiles, error: pErr } = await sb.from('profiles').select('*').eq('organization_id', agencyOrg.id).eq('is_active', true);
  if (pErr) throw pErr;
  if (!profiles.length) throw new Error('No active profiles found in the agency org.');

  const pravin = findProfile(profiles, ['^pravin'], 'surveyor');
  const rajaIndori = findProfile(profiles, ['raja.*indori'], 'surveyor');
  const installerP = findProfile(profiles, ['raja.*install'], 'installer');
  const designerP = findProfile(profiles, ['mustafa'], 'designer');
  const nilesh = findProfile(profiles, ['^nilesh'], 'printing');
  const saurabh = findProfile(profiles, ['saurabh'], 'printing');
  const ownerP = findProfile(profiles, ['shubham.*suryawanshi'], 'agency_owner') || findProfile(profiles, [], 'admin');
  const surveyor = (i) => weightedPick([[pravin, 0.6], [rajaIndori, 0.4]], i);
  const production = (i) => weightedPick([[nilesh, 0.55], [saurabh, 0.45]], i + 17);
  console.log(`Surveyors: ${pravin.full_name} (~60%), ${rajaIndori.full_name} (~40%) | Installer: ${installerP.full_name} | Designer: ${designerP.full_name} | Production: ${nilesh.full_name} (~55%), ${saurabh.full_name} (~45%) | Owner: ${ownerP.full_name}`);

  console.log('--- Ensuring work_types (professional taxonomy, deduped, EXACT name match) ---');
  const workTypeCache = {};
  for (const [name, description] of Object.entries(WORK_TYPE_DEFS)) {
    const { data: existingWT } = await sb.from('work_types').select('*').ilike('name', name).eq('organization_id', agencyOrg.id).limit(5);
    let wt = (existingWT || []).find((w) => w.name.toLowerCase() === name.toLowerCase());
    if (!wt) {
      const { data: created, error: wtErr } = await sb.from('work_types').insert({ organization_id: agencyOrg.id, name, description }).select().single();
      if (wtErr) throw wtErr;
      wt = created;
    }
    workTypeCache[name] = wt;
  }
  console.log('Work types ready:', Object.keys(workTypeCache).join(', '));

  let totalShopsCreated = 0;
  let globalShopIndex = 0;
  const utilizationCheck = [];
  const heroShops = [];

  for (const campaign of CAMPAIGNS) {
    console.log(`\n=== Campaign: ${campaign.name} ===`);
    const { data: campaignRow, error: cErr } = await sb.from('campaigns').insert({
      client_org_id: clientOrg.id, name: campaign.name, description: campaign.description,
      status: 'active', created_by: null,
    }).select().single();
    if (cErr) throw cErr;
    console.log('Campaign created:', campaignRow.id);

    for (const wo of campaign.workOrders) {
      const lineTotal = wo.lineItems.reduce((a, li) => a + li.budgeted_qty * li.rate, 0);
      console.log(`  -- Work order: ${wo.name} (PO ${wo.poNumber})${wo.isDummyPo ? ' [generated]' : ''} — ${wo.shopCount} shops, ${(wo.maturity * 100).toFixed(0)}% mature — line items sum to Rs ${lineTotal.toLocaleString('en-IN')}`);

      let notes = `Zone: ${wo.zoneLabel}. Delivered at Place Jalgaon. Payment terms: ${wo.paymentTerms}.`;
      if (wo.isEstimatedTotal) notes += ' Total is estimated pending final reconciliation.';

      const { data: poRow, error: poErr } = await sb.from('purchase_orders').insert({
        organization_id: agencyOrg.id, client_id: clientRow.id, campaign_id: campaignRow.id,
        po_number: wo.poNumber, name: wo.name, po_date: wo.poDate,
        fulfillment_type: campaign.fulfillment, total_amount: lineTotal,
        gst_percentage: wo.gstPercentage, payment_terms: wo.paymentTerms, status: 'active',
        notes, is_demo: false,
        client_org_id: clientOrg.id, assigned_agency_id: agencyOrg.id,
        assignment_status: 'accepted', origin: 'agency_created',
      }).select().single();
      if (poErr) throw poErr;
      wo.poRowId = poRow.id;

      const lineItemRows = [];
      for (const li of wo.lineItems) {
        const { data: row, error: liErr } = await sb.from('po_line_items').insert({
          organization_id: agencyOrg.id, purchase_order_id: poRow.id,
          work_type_id: li.workTypeKey ? workTypeCache[li.workTypeKey].id : null,
          description: li.description, uom: li.uom, budgeted_qty: li.budgeted_qty, rate: li.rate,
        }).select().single();
        if (liErr) throw liErr;
        lineItemRows.push(row);
      }
      const primaryLineItem = lineItemRows.length === 1 ? lineItemRows[0] : null;
      const lineItemByWorkType = {};
      for (const row of lineItemRows) {
        const src = wo.lineItems.find((li) => li.description === row.description);
        if (src && src.workTypeKey) lineItemByWorkType[src.workTypeKey] = row;
      }
      const shopWorkType = workTypeCache[campaign.workTypeKey];

      const isSurveyInstall = campaign.fulfillment === 'survey_install';
      const heroIndex = (campaign.key === 'inshop_branding' || wo.poNumber === '2999025846') && isSurveyInstall ? 0 : -1;
      const order_ = isSurveyInstall ? SI_ORDER : SO_ORDER;
      const weights = maturityWeights(order_, wo.maturity);
      let stagesForRest = allocateStages(order_, weights, wo.shopCount - (heroIndex >= 0 ? 1 : 0));
      if (isSurveyInstall) stagesForRest = ensureStagePresence(stagesForRest, ['surveyed', 'approved']);

      let woInvoicedTotal = 0;

      for (let i = 0; i < wo.shopCount; i++) {
        const pinnedRajkot = wo.poNumber === '2999025846' && i === 0;
        const isHero = (i === heroIndex && !pinnedRajkot) || pinnedRajkot;
        const loc = pinnedRajkot ? { city: 'Rajkot', state: 'Gujarat' } : pick(wo.cityPool, i + 1);
        const shopName = pinnedRajkot ? 'Mahadhan Krishi Kendra - Rajkot' : `${pick(SHOP_NAME_TEMPLATES, i + wo.poNumber.length)} - ${loc.city}`;
        const stage = pinnedRajkot ? 'billed' : (isHero ? 'billed' : stagesForRest[heroIndex >= 0 && i > heroIndex ? i - 1 : i]);
        const idx_ = order_.indexOf(stage);

        let insertStatus = stage;
        if (isSurveyInstall) {
          if (stage === 'installation_review') insertStatus = 'installing';
          if (stage === 'billed') insertStatus = 'installed';
        }

        const createdAt = isHero ? isoDaysAgo(0) : isoDaysAgo(5 + Math.floor(Math.random() * 90));
        const [baseLat, baseLng] = CITY_COORDS[loc.city] || [20.5, 78.9];
        const ownerName = `${pick(OWNER_FIRST, i)} ${pick(OWNER_LAST, i + 3)}`;

        const { data: shop, error: shopErr } = await sb.from('shops').insert({
          organization_id: agencyOrg.id, client_id: clientRow.id, purchase_order_id: poRow.id,
          name: shopName, owner_name: ownerName,
          contact_phone: `9${String(100000000 + Math.floor(Math.random() * 899999999))}`,
          address: `${Math.floor(Math.random() * 200) + 1}, ${pick(STREETS, i)}, ${loc.city}`,
          city: loc.city, district: loc.city, zone: wo.zoneLabel, state: loc.state,
          latitude: round2(jitter(baseLat, 0.15)), longitude: round2(jitter(baseLng, 0.15)),
          status: insertStatus, is_demo: false, created_at: createdAt,
          extra_details: { Landmark: pick(LANDMARKS, i) },
        }).select().single();
        if (shopErr) throw shopErr;

        const invoicedAmount = await buildShopPipeline({
          shop, campaign, wo, primaryLineItem, lineItemByWorkType, shopWorkType, workTypeCache, stage, idx: idx_, order: order_,
          agencyOrg, clientRow, surveyor, installerP, designerP, production, ownerP,
          pinnedRajkot, isHero, shopIdx: globalShopIndex,
        });
        woInvoicedTotal += invoicedAmount;
        if (isHero) heroShops.push({ name: shop.name, po: wo.poNumber, campaign: campaign.name });

        totalShopsCreated++;
        globalShopIndex++;
      }
      console.log(`     ${wo.shopCount} shops created. Invoiced: Rs ${woInvoicedTotal.toLocaleString('en-IN')} / budget Rs ${lineTotal.toLocaleString('en-IN')} (${((woInvoicedTotal / lineTotal) * 100).toFixed(1)}%)`);
      utilizationCheck.push({ po: wo.poNumber, name: wo.name, budget: lineTotal, invoiced: woInvoicedTotal });
    }
  }

  console.log('\n=== DONE ===');
  console.log('Total shops created:', totalShopsCreated);
  console.log('\n--- The 2 fully-documented showcase shops (marked photo, 2-version design, before/after install) ---');
  heroShops.forEach((h) => console.log(`  "${h.name}" — ${h.campaign} (PO ${h.po})`));
  console.log('\n--- Self-check: PO utilization should NEVER exceed 100% from a single run ---');
  for (const u of utilizationCheck) {
    const pct = ((u.invoiced / u.budget) * 100).toFixed(1);
    console.log(`  ${u.po} (${u.name}): ${pct}% invoiced${u.invoiced > u.budget ? '  <-- investigate' : ''}`);
  }

  // Definitive proof the Survey Review page will show data — queries
  // surveys the EXACT same way src/pages/SurveyReviewPage.tsx does
  // (same org filter, same status list). If this prints 0/0, the review
  // page will genuinely be empty and something upstream (org resolution,
  // RLS, or a table this script didn't touch) needs investigating — if it
  // prints real numbers here but the page still looks empty, the problem
  // is in the browser session (wrong org logged in, stale cache), not the
  // data.
  console.log('\n--- Self-check: Survey Review page query (exact same filter the app uses) ---');
  const { data: reviewRows, error: reviewErr } = await sb
    .from('surveys').select('id, status, shop_id, submitted_at')
    .eq('organization_id', agencyOrg.id)
    .in('status', ['submitted', 'approved', 'rejected', 'correction_requested']);
  if (reviewErr) { console.error('  Query itself failed:', reviewErr.message); }
  else {
    const pending = reviewRows.filter((r) => r.status === 'submitted');
    const reviewed = reviewRows.filter((r) => r.status !== 'submitted');
    console.log(`  Total surveys visible to Survey Review page: ${reviewRows.length}`);
    console.log(`  Pending review (status='submitted'): ${pending.length}`);
    console.log(`  Already reviewed (status!='submitted', mostly 'approved'): ${reviewed.length}`);
    if (reviewRows.length === 0) {
      console.warn('  WARNING: this is genuinely 0 — the page will be empty. This should not happen given the shops just created above; if you see this, paste this whole terminal output back so it can be diagnosed properly instead of guessed at.');
    }
  }
}

async function buildShopPipeline(ctx) {
  const {
    shop, campaign, wo, primaryLineItem, lineItemByWorkType, shopWorkType, workTypeCache, stage, idx, order, agencyOrg, clientRow,
    surveyor, installerP, designerP, production, ownerP, pinnedRajkot, isHero, shopIdx,
  } = ctx;
  const reached = (step) => idx >= order.indexOf(step);
  const at = (step) => stage === step;
  const photoCount = isHero ? 2 : 1;
  const isInshop = campaign.key === 'inshop_branding';

  let survey = null;
  const workItems = [];
  let designTask = null;
  let productionOrder = null;

  if (campaign.fulfillment === 'survey_install') {
    if (reached('survey_started')) {
      const surveyStatus = at('survey_started') ? 'draft' : (at('surveyed') ? 'submitted' : 'approved');
      const surv = surveyor(shopIdx);
      const surveyNote = surveyStatus === 'draft'
        ? `${surv.full_name} has started the site visit — measurements in progress.`
        : `${surv.full_name} completed the site survey and measured the ${campaign.workTypeKey} area.`;
      const { data: s, error: sErr } = await sb.from('surveys').insert({
        organization_id: agencyOrg.id, shop_id: shop.id, surveyor_id: surv.id,
        status: surveyStatus, gps_lat: jitter(shop.latitude, 0.02), gps_lng: jitter(shop.longitude, 0.02),
        gps_accuracy: 8 + Math.random() * 12, gps_captured_at: isoDaysAgo(60),
        notes: surveyNote,
        submitted_at: surveyStatus !== 'draft' ? isoDaysAgo(58) : null,
        reviewed_at: surveyStatus === 'approved' ? isoDaysAgo(56) : null,
        reviewed_by: surveyStatus === 'approved' ? ownerP.id : null,
      }).select().single();
      if (sErr) throw sErr;
      survey = s;

      const frontShots = surveyStatus === 'draft' ? 1 : photoCount;
      const frontPhotos = [];
      for (let p = 0; p < frontShots; p++) {
        frontPhotos.push({ organization_id: agencyOrg.id, survey_id: survey.id, shop_id: shop.id, storage_path: `${agencyOrg.id}/${shop.id}/front_${p}.jpg`, photo_url: placeholderPhoto(`front-${shop.id}-${p}`), photo_type: 'shop_front', caption: `Shop front — ${shop.name}` });
      }
      if (frontPhotos.length) await sb.from('survey_photos').insert(frontPhotos);

      let markedPhoto = null;
      if (surveyStatus !== 'draft') {
        const { data: mp, error: mpErr } = await sb.from('survey_photos').insert({
          organization_id: agencyOrg.id, survey_id: survey.id, shop_id: shop.id,
          storage_path: `${agencyOrg.id}/${shop.id}/marked_0.jpg`, photo_url: placeholderPhoto(`marked-${shop.id}`),
          photo_type: 'marked', caption: 'Marked elevation — board placement',
        }).select().single();
        if (mpErr) throw mpErr;
        markedPhoto = mp;
      }

      if (reached('surveyed')) {
        const componentKeys = isInshop ? pickInshopComponents(shopIdx) : [campaign.workTypeKey];

        for (const compKey of componentKeys) {
          const width = pinnedRajkot ? 12 : (isInshop ? 3 + Math.floor(Math.random() * 5) : 8 + Math.floor(Math.random() * 8));
          const height = pinnedRajkot ? 10 : (isInshop ? 2 + Math.floor(Math.random() * 3) : 4 + Math.floor(Math.random() * 4));
          const qty = pinnedRajkot ? 109 : 1;
          let wiStatus = 'surveyed';
          if (reached('approved')) wiStatus = 'approved';
          if (reached('designing')) wiStatus = 'designing';
          if (reached('design_ready')) wiStatus = 'designed';
          if (reached('production_pending')) wiStatus = 'design_approved';
          if (reached('in_production')) wiStatus = 'in_production';
          if (reached('production_done')) wiStatus = 'production_done';
          if (reached('installed')) wiStatus = 'installed';

          const compWorkType = workTypeCache[compKey] || null;
          const { data: wi, error: wiErr } = await sb.from('work_items').insert({
            organization_id: agencyOrg.id, shop_id: shop.id, survey_id: survey.id,
            work_type_id: compWorkType ? compWorkType.id : (shopWorkType ? shopWorkType.id : null),
            work_type_name: compKey,
            po_line_item_id: isInshop ? (lineItemByWorkType[compKey] ? lineItemByWorkType[compKey].id : null) : (primaryLineItem ? primaryLineItem.id : null),
            material: compKey === 'Foam Sheet' ? 'Foam Sheet' : compKey === 'ACP' ? 'ACP' : compKey,
            survey_width: width, survey_height: height, survey_unit: 'ft', survey_quantity: qty, survey_area: width * height * qty,
            approved_width: reached('approved') ? width : null, approved_height: reached('approved') ? height : null,
            approved_unit: reached('approved') ? 'ft' : null, approved_quantity: reached('approved') ? qty : null,
            approved_area: reached('approved') ? width * height * qty : null,
            produced_quantity: reached('production_done') ? qty : null, produced_at: reached('production_done') ? isoDaysAgo(25) : null,
            installed_width: reached('installed') ? width : null, installed_height: reached('installed') ? height : null,
            installed_unit: reached('installed') ? 'ft' : null, installed_quantity: reached('installed') ? qty : null,
            installed_area: reached('installed') ? width * height * qty : null, installed_at: reached('installed') ? isoDaysAgo(15) : null,
            status: wiStatus,
          }).select().single();
          if (wiErr) throw wiErr;
          workItems.push({ ...wi, _compKey: compKey });
        }

        if (reached('approved')) {
          await sb.from('approvals').insert({
            organization_id: agencyOrg.id, shop_id: shop.id, survey_id: survey.id,
            approval_type: 'internal', status: 'approved', reviewed_by: ownerP.id,
            reviewed_at: isoDaysAgo(55), note: `Survey approved by ${ownerP.full_name} — dimensions confirmed for ${workItems.length} item(s).`,
          });
        }

        if (isHero && markedPhoto) {
          for (const wi of workItems) {
            const region = MARK_REGIONS[wi._compKey];
            if (!region) continue;
            await sb.from('board_markings').insert({
              organization_id: agencyOrg.id, survey_photo_id: markedPhoto.id, work_item_id: wi.id,
              points: region, image_width: 1024, image_height: 768, version: 1,
            });
          }
        }
      }
    }

    if (reached('designing')) {
      let dtStatus = 'designing';
      if (at('design_ready')) dtStatus = 'design_ready';
      if (reached('production_pending')) dtStatus = 'ready_for_production';
      const dtNote = dtStatus === 'designing'
        ? `${designerP.full_name} is preparing the ${campaign.workTypeKey} artwork${workItems.length ? ` (${workItems.map((w) => w._compKey).join(', ')})` : ''}.`
        : `${designerP.full_name}'s design approved by ${ownerP.full_name} — sent to production.`;
      const { data: dt, error: dtErr } = await sb.from('design_tasks').insert({
        organization_id: agencyOrg.id, shop_id: shop.id, designer_id: designerP.id,
        status: dtStatus, notes: dtNote, assigned_at: isoDaysAgo(50),
        completed_at: reached('production_pending') ? isoDaysAgo(45) : null,
      }).select().single();
      if (dtErr) throw dtErr;
      designTask = dt;

      if (reached('design_ready')) {
        await sb.from('design_versions').insert({
          organization_id: agencyOrg.id, design_task_id: dt.id, version_number: 1,
          storage_path: `${agencyOrg.id}/${shop.id}/design_v1.jpg`, file_url: placeholderPhoto(`design-v1-${shop.id}`),
          file_name: `${shop.name.replace(/[^a-zA-Z0-9]+/g, '_')}_v1.jpg`, uploaded_by: designerP.id,
          status: isHero || reached('production_pending') ? 'approved' : (at('design_ready') ? 'uploaded' : 'approved'),
          source: 'agency_designed', notes: `${designerP.full_name} — initial layout.`,
        });
        if (isHero) {
          await sb.from('design_versions').insert({
            organization_id: agencyOrg.id, design_task_id: dt.id, version_number: 2,
            storage_path: `${agencyOrg.id}/${shop.id}/design_v2.jpg`, file_url: placeholderPhoto(`design-v2-${shop.id}`),
            file_name: `${shop.name.replace(/[^a-zA-Z0-9]+/g, '_')}_v2_final.jpg`, uploaded_by: designerP.id,
            status: 'approved', source: 'agency_designed',
            notes: `${designerP.full_name} — revised per ${ownerP.full_name}'s feedback, approved final.`,
          });
        }
      }
    }

    if (reached('production_pending')) {
      let prodStatus = 'pending';
      if (reached('in_production')) prodStatus = 'in_production';
      if (at('production_ready')) prodStatus = 'ready';
      if (reached('production_done')) prodStatus = 'completed';
      const prod = production(shopIdx);
      const { data: po, error: poErr } = await sb.from('production_orders').insert({
        organization_id: agencyOrg.id, shop_id: shop.id, design_task_id: designTask ? designTask.id : null,
        assigned_to: prod.id, status: prodStatus,
        notes: prodStatus === 'completed' ? `${prod.full_name} completed production — ready for dispatch.` : `${prod.full_name} handling production for this board.`,
      }).select().single();
      if (poErr) throw poErr;
      productionOrder = po;
      for (const wi of (workItems.length ? workItems : [null])) {
        await sb.from('production_items').insert({
          organization_id: agencyOrg.id, production_order_id: po.id, work_item_id: wi ? wi.id : null,
          requested_qty: wi ? wi.survey_quantity : 1,
          approved_qty: wi && wi.approved_quantity ? wi.approved_quantity : null,
          produced_qty: reached('production_done') && wi ? wi.survey_quantity : null,
        });
      }
    }

    if (reached('installation_pending')) {
      const jobStatus = at('installation_pending') ? 'assigned' : (at('installing') ? 'started' : 'completed');
      const reviewStatus = reached('installation_review') ? (reached('installed') ? 'approved' : 'pending') : 'not_applicable';
      const jobNote = jobStatus === 'assigned' ? `Installation assigned to ${installerP.full_name} — pending site visit.`
        : jobStatus === 'started' ? `${installerP.full_name} is on site installing the board.`
        : `${installerP.full_name} completed installation and verified board mounting.`;

      const { data: job, error: jobErr } = await sb.from('installation_jobs').insert({
        organization_id: agencyOrg.id, shop_id: shop.id, installer_id: installerP.id,
        production_order_id: productionOrder ? productionOrder.id : null,
        status: jobStatus, review_status: reviewStatus,
        reviewed_by: reviewStatus === 'approved' ? ownerP.id : null, reviewed_at: reviewStatus === 'approved' ? isoDaysAgo(19) : null,
        material_check_confirmed: jobStatus !== 'assigned', material_check_confirmed_by: jobStatus !== 'assigned' ? installerP.id : null,
        material_check_confirmed_at: jobStatus !== 'assigned' ? isoDaysAgo(22) : null,
        gps_lat: jobStatus !== 'assigned' ? jitter(shop.latitude, 0.02) : null, gps_lng: jobStatus !== 'assigned' ? jitter(shop.longitude, 0.02) : null,
        gps_accuracy: jobStatus !== 'assigned' ? 8 + Math.random() * 12 : null, gps_captured_at: jobStatus !== 'assigned' ? isoDaysAgo(20) : null,
        started_at: jobStatus !== 'assigned' ? isoDaysAgo(21) : null, completed_at: jobStatus === 'completed' ? isoDaysAgo(20) : null,
        notes: jobNote,
      }).select().single();
      if (jobErr) throw jobErr;

      if (jobStatus === 'completed') {
        // captured_at was never set here before, so every seeded proof
        // photo silently defaulted to the DB's DEFAULT now() — i.e. the
        // exact moment this script ran, for every shop, every campaign.
        // The client dashboard's "Recent Visual Proof" feed orders by
        // captured_at DESC, so with every photo tied for the same
        // instant, "recent" was meaningless — everything looked equally
        // (un)recent instead of the freshly-completed installs genuinely
        // floating to the top. A believable spread over the last ~3
        // weeks fixes that without needing any app-side change.
        const capturedAt = isoDaysAgo(Math.floor(Math.random() * 21) + 1);
        const proofs = [];
        for (let p = 0; p < photoCount; p++) {
          proofs.push({ organization_id: agencyOrg.id, installation_job_id: job.id, shop_id: shop.id, storage_path: `${agencyOrg.id}/${shop.id}/before_${p}.jpg`, photo_url: placeholderPhoto(`before-${shop.id}-${p}`), photo_type: 'before', caption: 'Before installation', captured_at: capturedAt });
          proofs.push({ organization_id: agencyOrg.id, installation_job_id: job.id, shop_id: shop.id, storage_path: `${agencyOrg.id}/${shop.id}/after_${p}.jpg`, photo_url: placeholderPhoto(`after-${shop.id}-${p}`), photo_type: 'installed', caption: 'Installed — final', captured_at: capturedAt });
        }
        await sb.from('installation_proofs').insert(proofs);
      }

      if (stage === 'installation_review') {
        const { error } = await sb.from('shops').update({ status: 'installation_review' }).eq('id', shop.id);
        if (error) throw error;
      }
    }
  } else {
    // SUPPLY ONLY
    if (reached('production_pending')) {
      const qty = 200 + Math.floor(Math.random() * 300);
      let wiStatus = 'approved';
      if (reached('in_production')) wiStatus = 'in_production';
      if (reached('production_done')) wiStatus = 'production_done';
      const { data: wi, error: wiErr } = await sb.from('work_items').insert({
        organization_id: agencyOrg.id, shop_id: shop.id, survey_id: null,
        work_type_id: shopWorkType ? shopWorkType.id : null, work_type_name: campaign.workTypeKey,
        po_line_item_id: primaryLineItem ? primaryLineItem.id : null,
        material: campaign.workTypeKey === 'Foam Sheet' ? 'Foam Sheet' : 'Flex',
        survey_unit: 'ft', survey_quantity: qty, approved_quantity: qty, approved_unit: 'ft',
        produced_quantity: reached('production_done') ? qty : null, produced_at: reached('production_done') ? isoDaysAgo(12) : null,
        status: wiStatus,
      }).select().single();
      if (wiErr) throw wiErr;
      workItems.push({ ...wi, _compKey: campaign.workTypeKey });

      let prodStatus = 'pending';
      if (reached('in_production')) prodStatus = 'in_production';
      if (at('production_ready')) prodStatus = 'ready';
      if (reached('production_done')) prodStatus = 'completed';
      const prod = production(shopIdx);
      const { data: po, error: poErr } = await sb.from('production_orders').insert({
        organization_id: agencyOrg.id, shop_id: shop.id, design_task_id: null, assigned_to: prod.id, status: prodStatus,
        notes: prodStatus === 'completed' ? `${prod.full_name} completed the print run — ready for dispatch.` : `${prod.full_name} handling this print run.`,
      }).select().single();
      if (poErr) throw poErr;
      await sb.from('production_items').insert({
        organization_id: agencyOrg.id, production_order_id: po.id, work_item_id: wi.id,
        requested_qty: qty, approved_qty: qty, produced_qty: reached('production_done') ? qty : null,
      });
    }
  }

  if (stage !== 'billed') return 0;

  const boardWorkItem = workItems.find((w) => w._compKey === 'Foam Sheet' || w._compKey === 'ACP') || workItems[0] || null;
  let amount, description, invoiceNumber, gstAmountEach, total, quantity, rate;
  if (pinnedRajkot) {
    amount = 493225.00; gstAmountEach = 44390.25; total = 582005.57;
    description = 'Rajkot HOARDING — 12 X 10, Qty 109 @ Rate 4525'; invoiceNumber = 'DA2026-27/04';
    quantity = 109; rate = 4525;
  } else {
    const lineTotal = wo.lineItems.reduce((a, li) => a + li.budgeted_qty * li.rate, 0);
    amount = round2(lineTotal / wo.shopCount);
    gstAmountEach = round2(amount * (wo.gstPercentage / 2) / 100);
    total = round2(amount + gstAmountEach * 2);
    description = primaryLineItem ? `${primaryLineItem.description} — ${shop.name}` : `${campaign.workTypeKey} (complete package) — ${shop.name}`;
    invoiceNumber = `DA-${wo.poNumber.slice(-4)}-${String(shopIdx).padStart(4, '0')}`;
    quantity = 1; rate = amount;
  }

  const { data: inv, error: invErr } = await sb.from('invoices').insert({
    organization_id: agencyOrg.id, client_id: clientRow.id, purchase_order_id: wo.poRowId,
    invoice_number: invoiceNumber, invoice_date: pinnedRajkot ? '2026-05-06' : dateDaysAgo(10),
    due_date: pinnedRajkot ? '2026-06-05' : dateDaysAgo(-20),
    subtotal: amount, tax_rate: wo.gstPercentage, tax_amount: gstAmountEach * 2, total,
    cgst_rate: wo.gstPercentage / 2, cgst_amount: gstAmountEach, sgst_rate: wo.gstPercentage / 2, sgst_amount: gstAmountEach,
    payment_status: pinnedRajkot ? 'unpaid' : 'paid',
    bill_to_name: clientRow.name, bill_to_address: clientRow.address, bill_to_city: clientRow.city, bill_to_state: clientRow.state, bill_to_gst: clientRow.gst_number,
    terms: wo.paymentTerms, notes: pinnedRajkot ? null : 'Thank you for your business.',
  }).select().single();
  if (invErr) throw invErr;

  await sb.from('invoice_items').insert({
    organization_id: agencyOrg.id, invoice_id: inv.id, shop_id: shop.id,
    work_item_id: boardWorkItem ? boardWorkItem.id : null, po_line_item_id: primaryLineItem ? primaryLineItem.id : null,
    description, quantity, area: boardWorkItem ? boardWorkItem.survey_area : null, rate, amount,
  });

  const { error: billedErr } = await sb.from('shops').update({ status: 'billed' }).eq('id', shop.id);
  if (billedErr) throw billedErr;

  return amount;
}

main().then(() => process.exit(0)).catch((e) => {
  console.error('SEED FAILED:', e);
  process.exit(1);
});
