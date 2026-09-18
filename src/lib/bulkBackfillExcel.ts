// Bulk Backfill via Excel — the multi-shop version of the single-shop
// Backfill panel and the "Add Shop (In Progress)" flow, combined. Every
// shop here can be at a different real-world stage with different
// boards/measurements, so this is a line-items format: one row per
// board, many rows can share a Shop ID, and each shop's own
// Stage/Surveyor/Designer/etc. only needs to be filled on one of its
// rows.
//
// Whether a row is an EXISTING shop or a NEW one is decided by the
// explicit "New Shop?" Yes/No dropdown — not by whether Shop ID happens
// to be filled in. That column is what it looks like on-screen: an
// admin can now see, per row, exactly which mode they're in, and a
// stray edit to Shop ID (it used to get accidentally blanked, which
// silently turned an existing-shop row into a "create a duplicate shop"
// row) no longer changes the outcome.
//
// The downloaded template is built with ExcelJS (not the `xlsx` package
// used elsewhere in the app) specifically because it can write real
// Excel dropdown data validation — New Shop?, Stage, Work Order,
// Client, Surveyor, Designer, Production Person and Installer are all
// click-to-select dropdowns, not free text. Reading the filled file
// back in still goes through `xlsx`/SheetJS, which reads a dropdown
// cell's chosen value like any other cell.
import * as XLSX from 'xlsx';
import ExcelJS from 'exceljs';
import type { BackfillStage } from './backfillPipeline';

export const BULK_BACKFILL_HEADERS = [
  'New Shop?', 'Shop ID', 'Shop Name', 'Phone', 'Work Order', 'Client',
  'City', 'District', 'State', 'Address', 'Owner Name', 'Current Status',
  'Stage', 'Work Type', 'Material', 'Width', 'Height', 'Unit', 'Qty',
  'Surveyor', 'Designer', 'Production Person', 'Installer', 'Note',
] as const;

const STAGE_LABELS: Record<BackfillStage, string> = {
  design_pending: 'Survey done',
  production_pending: 'Survey + Design done',
  production_done: 'Survey + Design + Production done',
  dispatched: 'Survey + Design + Production done (Dispatched)',
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
export interface BulkBackfillPoRow {
  id: string;
  po_number: string;
  client_id: string;
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
  purchaseOrders: BulkBackfillPoRow[];
}

const EXISTING_FILL: Partial<ExcelJS.Fill> = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFF4FB' } } as ExcelJS.Fill;
const NEW_FILL: Partial<ExcelJS.Fill> = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF0FAF0' } } as ExcelJS.Fill;

/** Builds and immediately downloads the .xlsx template. Short by design —
 *  a wall of instructions goes unread; the sheet itself (dropdowns +
 *  two colour-coded, clearly-labelled blocks of rows) is the real
 *  explanation. */
export async function downloadBulkBackfillTemplate(opts: BulkBackfillTemplateOptions): Promise<void> {
  const { shops, surveyors, designers, productionPeople, installers, clients, purchaseOrders } = opts;
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Bulk Backfill';
  wb.created = new Date();

  const wsInstructions = wb.addWorksheet('Read Me First');
  wsInstructions.columns = [{ width: 92 }];
  const bold = (text: string) => { const row = wsInstructions.addRow([text]); row.font = { bold: true }; return row; };
  const plain = (text: string) => wsInstructions.addRow([text]);
  bold('Bulk Backfill — 1 minute guide').font = { bold: true, size: 14 };
  plain('Use this for work already done outside the app. Open the "Backfill Data" tab.');
  wsInstructions.addRow([]);
  bold('Blue rows — shops already in the app');
  plain('Just fill in Stage onward (columns M→X). Everything left of "Current Status" is reference only — leave it as is.');
  wsInstructions.addRow([]);
  bold('Green rows — shops NOT in the app yet');
  plain('Fill in every column: Shop Name, Phone, Work Order or Client, City/State/Address, then Stage onward.');
  plain('Give every board of that shop the SAME Shop Name + Phone so they land on one shop.');
  wsInstructions.addRow([]);
  bold('Every shop, one rule');
  plain('One row = one board. 3 boards for a shop = 3 rows. Only fill Stage/Surveyor/Designer/Production/Installer/Note on ONE of that shop\'s rows.');
  wsInstructions.addRow([]);
  bold('Columns with a dropdown (click the cell, pick from the list — do not type):');
  plain('New Shop?, Work Order, Client, Stage, Surveyor, Designer, Production Person, Installer.');
  plain('Picking a Work Order is enough on its own — you don\'t need to also fill Client for that row.');
  wsInstructions.addRow([]);
  bold('Designer only needed if Stage includes Design. Production Person / Installer only needed if Stage includes Production.');
  wsInstructions.addRow([]);
  plain('Save the file and upload it back from the same screen.');

  // Hidden reference sheet the dropdowns pull their options from — kept
  // as a separate sheet (rather than an inline comma list) because a
  // long team-member/client/PO list can exceed Excel's ~255-character
  // limit for an inline dropdown formula.
  const wsLists = wb.addWorksheet('Lists');
  wsLists.state = 'veryHidden';
  const poLabels = purchaseOrders.map((p) => p.po_number);
  const listColumns: { header: string; values: string[] }[] = [
    { header: 'YesNo', values: ['Yes', 'No'] },
    { header: 'Stage', values: Object.values(STAGE_LABELS) },
    { header: 'Surveyor', values: surveyors },
    { header: 'Designer', values: designers },
    { header: 'Production', values: productionPeople },
    { header: 'Installer', values: installers },
    { header: 'Client', values: clients },
    { header: 'WorkOrder', values: poLabels },
  ];
  listColumns.forEach((col, i) => {
    const c = i + 1;
    wsLists.getCell(1, c).value = col.header;
    col.values.forEach((v, r) => { wsLists.getCell(r + 2, c).value = v; });
  });

  const wsData = wb.addWorksheet('Backfill Data');
  wsData.addRow([...BULK_BACKFILL_HEADERS]);
  wsData.getRow(1).font = { bold: true };
  wsData.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE2E8F0' } };
  wsData.columns = BULK_BACKFILL_HEADERS.map((h) => ({ width: Math.max(11, h.length + 2) }));
  wsData.views = [{ state: 'frozen', ySplit: 1 }];

  const emptyItemCols = ['', '', '', '', 'ft', '', '', '', '', '', ''];
  for (const shop of shops) {
    const row = wsData.addRow(['No', shop.id, shop.name, shop.phone || '', '', '', shop.city || '', '', '', '', '', shop.status, ...emptyItemCols]);
    row.fill = EXISTING_FILL as ExcelJS.Fill;
  }
  const newRowsStart = shops.length + 2;
  for (let i = 0; i < 30; i++) {
    const row = wsData.addRow(['Yes', '', '', '', '', '', '', '', '', '', '', '', ...emptyItemCols]);
    row.fill = NEW_FILL as ExcelJS.Fill;
  }
  const lastRow = newRowsStart + 30 - 1;

  const colOf = (label: string) => BULK_BACKFILL_HEADERS.indexOf(label as (typeof BULK_BACKFILL_HEADERS)[number]) + 1;
  const applyDropdown = (label: string, listCol: number, listLen: number) => {
    if (listLen === 0) return;
    const col = colOf(label);
    const range = `Lists!$${colLetter(listCol)}$2:$${colLetter(listCol)}$${listLen + 1}`;
    for (let r = 2; r <= lastRow; r++) {
      wsData.getCell(r, col).dataValidation = { type: 'list', allowBlank: true, formulae: [range] };
    }
  };
  applyDropdown('New Shop?', 1, 2);
  applyDropdown('Stage', 2, listColumns[1].values.length);
  applyDropdown('Surveyor', 3, surveyors.length);
  applyDropdown('Designer', 4, designers.length);
  applyDropdown('Production Person', 5, productionPeople.length);
  applyDropdown('Installer', 6, installers.length);
  applyDropdown('Client', 7, clients.length);
  applyDropdown('Work Order', 8, poLabels.length);

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
  /** '' when not known yet — for an existing-shop row where Shop ID got
   *  cleared by mistake, the caller can still recover it by matching
   *  shopName against the org's shop list. */
  shopId: string;
  isNew: boolean;
  /** True only when the sheet didn't say either way (both Shop ID and
   *  New Shop? were blank) — kept separate from a confident `isNew` so
   *  the caller can require the admin to say which, rather than guess. */
  isNewAmbiguous: boolean;
  shopName: string;
  phone: string;
  clientName: string;
  workOrderNumber: string;
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
    newShop: colIndex('New Shop?'), shopId: colIndex('Shop ID'), shopName: colIndex('Shop Name'), phone: colIndex('Phone'),
    workOrder: colIndex('Work Order'), client: colIndex('Client'),
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
    const newShopFlag = cell(row, idx.newShop).toLowerCase();
    // A completely blank row (common at the bottom of a template that
    // wasn't fully filled in) — nothing to group it by, skip silently.
    if (!shopId && !shopName) continue;

    // "New Shop?" is the authoritative signal when it's answered — Shop
    // ID presence is only a fallback for a sheet that never set it (or
    // an older download). This is what stops an accidentally-cleared
    // Shop ID cell from turning an existing shop into a duplicate.
    const isNew = newShopFlag === 'yes' ? true : newShopFlag === 'no' ? false : !shopId;
    const isNewAmbiguous = !newShopFlag && !shopId && !!shopName;
    const norm = (v: string) => v.trim().toLowerCase().replace(/\s+/g, ' ');
    // One Excel row is one board, NOT one shop. Group all board rows for
    // the same logical site into one shop even when phone is blank or
    // formatting/case differs. Work Order + client/location are included
    // to avoid merging two genuinely different outlets with the same name.
    const naturalShopKey = [norm(shopName), norm(cell(row, idx.workOrder)), norm(cell(row, idx.client)), norm(cell(row, idx.city)), norm(cell(row, idx.address))].join('|');
    const key = isNew ? `new:${naturalShopKey}` : (shopId || `byname:${naturalShopKey}`);

    let entry = byKey.get(key);
    if (!entry) {
      entry = {
        key, shopId, isNew, isNewAmbiguous, shopName, phone,
        clientName: cell(row, idx.client), workOrderNumber: cell(row, idx.workOrder),
        city: cell(row, idx.city), district: cell(row, idx.district),
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
