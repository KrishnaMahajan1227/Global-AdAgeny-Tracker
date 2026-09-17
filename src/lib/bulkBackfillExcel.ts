// Bulk Backfill via Excel — the multi-shop version of the single-shop
// Backfill panel and the "Add Shop (In Progress)" flow, combined. Every
// shop here can be at a different real-world stage with different
// boards/measurements, so this is a line-items format: one row per
// board, many rows can share a Shop ID, and each shop's own
// Stage/Surveyor/Designer/etc. only needs to be filled on one of its
// rows. A row with a Shop ID updates that existing shop; a row with the
// Shop ID left BLANK creates a brand-new shop first (grouped by Shop
// Name + Phone instead, since a new shop has no ID yet), then backfills
// it exactly the same way — so a batch that's part already-added, part
// completely new can go through in one file.
//
// The downloaded template is built with ExcelJS (not the `xlsx` package
// used elsewhere in the app) specifically because it can write real
// Excel dropdown data validation — Stage, Surveyor, Designer, Production
// Person, Installer and Client are all click-to-select dropdowns in the
// actual spreadsheet, not free text, so there's nothing to mistype.
// Reading the filled file back in still goes through `xlsx`/SheetJS,
// which reads a dropdown cell's chosen value like any other cell.
import * as XLSX from 'xlsx';
import ExcelJS from 'exceljs';
import type { BackfillStage } from './backfillPipeline';

export const BULK_BACKFILL_HEADERS = [
  'Shop ID', 'Shop Name', 'Phone', 'Client', 'City', 'District', 'State', 'Address', 'Owner Name', 'Current Status',
  'Stage', 'Work Type', 'Material', 'Width', 'Height', 'Unit', 'Qty',
  'Surveyor', 'Designer', 'Production Person', 'Installer', 'Note',
] as const;

const STAGE_LABELS: Record<BackfillStage, string> = {
  design_pending: 'Survey Done',
  production_pending: 'Survey + Design Done',
  production_done: 'Survey + Design + Production Done',
  dispatched: 'Survey + Design + Production Done (Dispatched)',
};
// Accepts either the friendly label above or the raw stage code, so a
// shorthand typed value still works.
const STAGE_LOOKUP: Record<string, BackfillStage> = {
  'survey done': 'design_pending',
  'survey + design done': 'production_pending',
  'survey + design + production done': 'production_done',
  'survey + design + production done (dispatched)': 'dispatched',
  design_pending: 'design_pending',
  production_pending: 'production_pending',
  production_done: 'production_done',
  dispatched: 'dispatched',
};

export interface BulkBackfillShopRow {
  id: string;
  name: string;
  phone: string | null;
  city: string | null;
  status: string;
}

/** For dropdown-list ranges on the hidden "Lists" sheet — 1 → 'A', 26 → 'Z', 27 → 'AA', etc. */
function colLetter(n: number): string {
  let s = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

export interface BulkBackfillTemplateOptions {
  shops: BulkBackfillShopRow[];
  surveyors: string[];
  designers: string[];
  productionPeople: string[];
  installers: string[];
  clients: string[];
}

/** Builds and immediately downloads the .xlsx template: an Instructions
 *  sheet, one pre-filled reference row per shop that still needs
 *  backfilling, a block of blank rows underneath for shops that don't
 *  exist in the app yet, and real dropdown selectors (Stage / Surveyor /
 *  Designer / Production Person / Installer / Client) so Owner/Admin
 *  pick from the actual list instead of typing names by hand. */
export async function downloadBulkBackfillTemplate(opts: BulkBackfillTemplateOptions): Promise<void> {
  const { shops, surveyors, designers, productionPeople, installers, clients } = opts;
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Bulk Backfill';
  wb.created = new Date();

  const wsInstructions = wb.addWorksheet('Instructions');
  wsInstructions.columns = [{ width: 100 }];
  const instructionLines = [
    'Bulk Backfill — Instructions',
    '',
    'SHOPS ALREADY IN THE APP (listed on the Backfill Data sheet with a Shop ID filled in):',
    '1. Do not edit the "Shop ID" column — it\'s how each row is matched back to the right shop.',
    '2. "Client", "City", "District", "State", "Address", "Owner Name" are shown for reference only and are ignored for these rows.',
    '',
    'SHOPS THAT DON\'T EXIST IN THE APP YET:',
    '3. Use one of the blank rows at the bottom of the Backfill Data sheet. Leave "Shop ID" and "Current Status" empty.',
    '4. Fill in Shop Name, Phone, Client, City, District, State, Address, Owner Name — the shop gets created first, then backfilled.',
    '5. Pick "Client" from its dropdown — required for a new shop.',
    '6. Every row for the same new shop needs the same Shop Name + Phone so they\'re grouped together correctly.',
    '',
    'BOTH CASES:',
    '7. "Stage", "Surveyor", "Designer", "Production Person", "Installer" and "Client" are all dropdowns — click the cell and pick from the list rather than typing.',
    '8. One row = one board/item. A shop with 3 boards needs 3 rows.',
    '9. Only fill Stage / Surveyor / Designer / Production Person / Installer / Note on ONE of that shop\'s rows — the rest can be left blank, extra copies are fine too.',
    '10. Designer only matters if Stage includes Design. Production Person / Installer only matter if Stage includes Production.',
    '11. Save this file and upload it back from the same "Bulk Backfill" screen.',
  ];
  instructionLines.forEach((line) => wsInstructions.addRow([line]));
  wsInstructions.getRow(1).font = { bold: true, size: 13 };

  // Hidden reference sheet the dropdowns pull their options from — kept
  // as a separate sheet (rather than an inline comma list) because a
  // long team-member or client list can exceed Excel's ~255-character
  // limit for an inline dropdown formula.
  const wsLists = wb.addWorksheet('Lists');
  wsLists.state = 'veryHidden';
  const listColumns: { header: string; values: string[] }[] = [
    { header: 'Stage', values: Object.values(STAGE_LABELS) },
    { header: 'Surveyor', values: surveyors },
    { header: 'Designer', values: designers },
    { header: 'Production', values: productionPeople },
    { header: 'Installer', values: installers },
    { header: 'Client', values: clients },
  ];
  listColumns.forEach((col, i) => {
    const c = i + 1;
    wsLists.getCell(1, c).value = col.header;
    col.values.forEach((v, r) => { wsLists.getCell(r + 2, c).value = v; });
  });

  const wsData = wb.addWorksheet('Backfill Data');
  wsData.addRow([...BULK_BACKFILL_HEADERS]);
  wsData.getRow(1).font = { bold: true };
  wsData.columns = BULK_BACKFILL_HEADERS.map((h) => ({ width: Math.max(12, h.length + 2) }));

  for (const shop of shops) {
    wsData.addRow([shop.id, shop.name, shop.phone || '', '', shop.city || '', '', '', '', '', shop.status, '', '', '', '', '', 'ft', '', '', '', '', '', '']);
  }
  const blankRowsStart = shops.length + 2; // first blank-new-shop row number
  for (let i = 0; i < 30; i++) {
    wsData.addRow(['', '', '', '', '', '', '', '', '', '', '', '', '', '', '', 'ft', '', '', '', '', '', '']);
  }
  const lastRow = blankRowsStart + 30 - 1;

  const colOf = (label: string) => BULK_BACKFILL_HEADERS.indexOf(label as (typeof BULK_BACKFILL_HEADERS)[number]) + 1;
  const applyDropdown = (label: string, listCol: number, listLen: number) => {
    if (listLen === 0) return;
    const col = colOf(label);
    const range = `Lists!$${colLetter(listCol)}$2:$${colLetter(listCol)}$${listLen + 1}`;
    for (let r = 2; r <= lastRow; r++) {
      wsData.getCell(r, col).dataValidation = { type: 'list', allowBlank: true, formulae: [range] };
    }
  };
  applyDropdown('Stage', 1, listColumns[0].values.length);
  applyDropdown('Surveyor', 2, surveyors.length);
  applyDropdown('Designer', 3, designers.length);
  applyDropdown('Production Person', 4, productionPeople.length);
  applyDropdown('Installer', 5, installers.length);
  applyDropdown('Client', 6, clients.length);

  const buffer = await wb.xlsx.writeBuffer();
  const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `bulk-backfill-template-${new Date().toISOString().slice(0, 10)}.xlsx`;
  a.click();
  URL.revokeObjectURL(url);
}

export interface BulkBackfillParsedItem {
  workType: string; material: string; width: string; height: string; unit: string; quantity: string;
}
export interface BulkBackfillParsedShop {
  /** A stable key for this group of rows — the real Shop ID for an
   *  existing shop, or a synthetic "new:name|phone" key for a shop
   *  that's being created. */
  key: string;
  /** Empty for a new shop — isNew distinguishes "not yet resolved" from
   *  "genuinely blank". */
  shopId: string;
  isNew: boolean;
  shopName: string;
  phone: string;
  clientName: string;
  city: string;
  district: string;
  state: string;
  address: string;
  ownerName: string;
  stage: BackfillStage | null;
  stageRaw: string;
  items: BulkBackfillParsedItem[];
  surveyor: string; designer: string; production: string; installer: string; note: string;
}

/** Reads the uploaded workbook back into one entry per shop (existing,
 *  keyed by Shop ID; new, keyed by Shop Name + Phone). Returns a
 *  parse-level error only when the sheet/headers themselves are wrong;
 *  per-row problems (bad stage, no items, missing client) surface later
 *  per-shop instead of blocking the whole file. */
export function parseBulkBackfillWorkbook(wb: XLSX.WorkBook): { shops: BulkBackfillParsedShop[] } | { error: string } {
  const sheet = wb.Sheets['Backfill Data'] || wb.Sheets[wb.SheetNames[wb.SheetNames.length - 1]];
  if (!sheet) return { error: 'Could not find a "Backfill Data" sheet in this file.' };
  const aoa = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1 });
  if (aoa.length < 2) return { error: 'This sheet has no data rows.' };

  const headerRow = (aoa[0] || []).map((h) => String(h ?? '').trim());
  const colIndex = (label: string) => headerRow.findIndex((h) => h.toLowerCase() === label.toLowerCase());
  const idx = {
    shopId: colIndex('Shop ID'), shopName: colIndex('Shop Name'), phone: colIndex('Phone'), client: colIndex('Client'),
    city: colIndex('City'), district: colIndex('District'), state: colIndex('State'), address: colIndex('Address'),
    ownerName: colIndex('Owner Name'), stage: colIndex('Stage'),
    workType: colIndex('Work Type'), material: colIndex('Material'), width: colIndex('Width'),
    height: colIndex('Height'), unit: colIndex('Unit'), qty: colIndex('Qty'),
    surveyor: colIndex('Surveyor'), designer: colIndex('Designer'), production: colIndex('Production Person'),
    installer: colIndex('Installer'), note: colIndex('Note'),
  };
  if (idx.shopId === -1) return { error: 'Could not find a "Shop ID" column — please use the downloaded template and don\'t rename its columns.' };
  if (idx.shopName === -1) return { error: 'Could not find a "Shop Name" column — please use the downloaded template and don\'t rename its columns.' };

  const cell = (row: unknown[], i: number) => (i === -1 || row[i] == null ? '' : String(row[i]).trim());
  const byKey = new Map<string, BulkBackfillParsedShop>();

  for (let r = 1; r < aoa.length; r++) {
    const row = aoa[r] || [];
    const shopId = cell(row, idx.shopId);
    const shopName = cell(row, idx.shopName);
    const phone = cell(row, idx.phone);
    // A completely blank row (common at the bottom of a template that
    // wasn't fully filled in) — nothing to group it by, skip silently.
    if (!shopId && !shopName) continue;

    const isNew = !shopId;
    const key = isNew ? `new:${shopName.toLowerCase()}|${phone}` : shopId;

    let entry = byKey.get(key);
    if (!entry) {
      entry = {
        key, shopId, isNew, shopName, phone,
        clientName: cell(row, idx.client), city: cell(row, idx.city), district: cell(row, idx.district),
        state: cell(row, idx.state), address: cell(row, idx.address), ownerName: cell(row, idx.ownerName),
        stage: null, stageRaw: '', items: [], surveyor: '', designer: '', production: '', installer: '', note: '',
      };
      byKey.set(key, entry);
    }

    const stageRaw = cell(row, idx.stage);
    if (stageRaw && !entry.stageRaw) {
      entry.stageRaw = stageRaw;
      entry.stage = STAGE_LOOKUP[stageRaw.toLowerCase()] || null;
    }
    const surveyor = cell(row, idx.surveyor); if (surveyor && !entry.surveyor) entry.surveyor = surveyor;
    const designer = cell(row, idx.designer); if (designer && !entry.designer) entry.designer = designer;
    const production = cell(row, idx.production); if (production && !entry.production) entry.production = production;
    const installer = cell(row, idx.installer); if (installer && !entry.installer) entry.installer = installer;
    const note = cell(row, idx.note); if (note && !entry.note) entry.note = note;

    const width = cell(row, idx.width);
    const height = cell(row, idx.height);
    const qty = cell(row, idx.qty);
    if (width && height && qty) {
      entry.items.push({
        workType: cell(row, idx.workType), material: cell(row, idx.material),
        width, height, unit: cell(row, idx.unit) || 'ft', quantity: qty,
      });
    }
  }

  return { shops: Array.from(byKey.values()) };
}
