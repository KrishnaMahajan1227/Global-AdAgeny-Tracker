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
import { SHOP_STATUSES, STATUS_LABELS } from './types';

export const BULK_BACKFILL_HEADERS = [
  'New Shop?', 'Shop ID', 'Shop Name', 'Phone', 'Work Order', 'Client',
  'City', 'District', 'State', 'Address', 'Owner Name', 'Current Status',
  'Stage', 'Work Type', 'Material', 'Width', 'Height', 'Unit', 'Qty',
  'Surveyor', 'Designer', 'Production Person', 'Installer', 'Note',
] as const;

const UNIT_CHOICES = ['ft', 'in', 'm', 'cm', 'ft x in', 'in x ft', 'm x cm', 'cm x m', 'ft x m', 'm x ft', 'in x cm', 'cm x in', 'ft x cm', 'cm x ft', 'in x m', 'm x in'];
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
  plain('Shop ki details already bhari hain. Stage se aage (Stage, Work Type, Material, Width, Height, Unit, Qty...) bhariye  ya sirf status badalna ho to sirf "Current Status" chuniye.');
  wsInstructions.addRow([]);
  bold('Green rows — shops NOT in the app yet');
  plain('Fill in every column: Shop Name, Phone, Work Order or Client, City/State/Address, then Stage onward.');
  plain('Give every board of that shop the SAME Shop Name + Phone so they land on one shop.');
  wsInstructions.addRow([]);
  bold('Every shop, one rule');
  plain('One row = one board. 3 boards for a shop = 3 rows. Only fill Stage/Surveyor/Designer/Production/Installer/Note on ONE of that shop\'s rows.');
  wsInstructions.addRow([]);
  bold('Same shop, many works  kaise likhein');
  plain('Ek shop ke jitne kaam hain utni rows likhiye. Shop Name + Phone SAME rakhiye  bas itna kaafi hai, ye sab ek hi shop me judenge.');
  plain('Har row ka Work Order alag ho sakta hai  shop ka Work Order pehli row se liya jata hai, baaki rows ke works apne Work Order ki line se jud jate hain.');
  wsInstructions.addRow([]);
  bold('Sizes aur Unit  ek hi Unit column');
  plain('Width aur Height me sirf number likhiye (10, 4.5). Formula bhi chalega (=288/12).');
  plain('Unit dropdown se chuniye. Ek unit (ft / in / m / cm) = width aur height dono usi unit me.');
  plain('Alag alag unit ho to combo chuniye: \"ft x in\" matlab Width feet me, Height inch me. Example: width 10 ft, height 6 in -> Width 10, Height 6, Unit \"ft x in\".');
  plain('App size wahi dikhata hai jo aapne likha; sq.ft sirf totals / work-order calculation ke liye banta hai.');
  wsInstructions.addRow([]);
  bold('Stage aur Current Status');
  plain('Stage (dropdown) = bahar kitna kaam ho chuka hai (Survey / Design / Production / Dispatched)  isse records ban-te hain.');
  plain('Current Status (dropdown) = import ke baad shop ka status kya rakhna hai (Pending se Billed tak, project ke saare stages). Khaali chhodne par Stage ke hisaab se apne aap lagta hai.');
  plain('Kisi existing shop ka sirf status badalna ho to sirf Current Status chuniye  Stage/Width/Height khaali chhod dijiye.');
  wsInstructions.addRow([]);
  bold('Columns with a dropdown (click the cell, pick from the list — do not type):');
  plain('New Shop?, Work Order, Client, Current Status, Stage, Unit, Surveyor, Designer, Production Person, Installer.');
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
    { header: 'Status', values: SHOP_STATUSES.map((st) => STATUS_LABELS[st] || st) },
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

  const emptyItemCols = ['', '', '', '', '', 'ft', '', '', '', '', '', ''];
  for (const shop of shops) {
    const row = wsData.addRow(['No', shop.id, shop.name, shop.phone || '', '', '', shop.city || '', '', '', '', '', '', ...emptyItemCols]);
    row.fill = EXISTING_FILL as ExcelJS.Fill;
    row.getCell(3).note = `Abhi ka status: ${STATUS_LABELS[shop.status] || shop.status}`;
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
      wsData.getCell(r, col).dataValidation = { type: 'list', allowBlank: true, formulae: [range], errorStyle: 'warning', showErrorMessage: true, errorTitle: 'List me nahi hai', error: 'Ye value list me nahi hai. Phir bhi rakhni hai?' };
    }
  };
  // Short lists are written INLINE (work in every Excel / Google Sheets / mobile app, no hidden-sheet dependency).
  const inline = (label: string, values: string[], prompt?: string) => {
    const col = colOf(label);
    for (let r = 2; r <= lastRow; r++) wsData.getCell(r, col).dataValidation = { type: 'list', allowBlank: true, formulae: [`"${values.join(',')}"`], showInputMessage: !!prompt, promptTitle: label, prompt: prompt || '' };
  };
  inline('Unit', UNIT_CHOICES, 'Ek unit = width aur height dono. "ft x in" = width feet me, height inch me.');
  inline('New Shop?', ['Yes', 'No']);
  inline('Stage', Object.values(STAGE_LABELS), 'Bahar kitna kaam ho chuka hai.');
  applyDropdown('Current Status', 9, listColumns[8].values.length);
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
  workType: string; material: string; width: string; height: string; unit: string; heightUnit: string; quantity: string; workOrder: string;
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
  /** Optional final shop status chosen from the Current Status dropdown (a real shop status code). */
  currentStatus: string | null;
  currentStatusRaw: string;
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
    ownerName: colIndex('Owner Name'), stage: colIndex('Stage'), currentStatus: colIndex('Current Status'),
    workType: colIndex('Work Type'), material: colIndex('Material'), width: colIndex('Width'),
    height: colIndex('Height'), unit: colIndex('Unit'), heightUnit: colIndex('Height Unit'), qty: colIndex('Qty'),
    surveyor: colIndex('Surveyor'), designer: colIndex('Designer'), production: colIndex('Production Person'),
    installer: colIndex('Installer'), note: colIndex('Note'),
  };
  if (idx.shopId === -1) return { error: 'Could not find a "Shop ID" column — please use the downloaded template and don\'t rename its columns.' };
  if (idx.shopName === -1) return { error: 'Could not find a "Shop Name" column — please use the downloaded template and don\'t rename its columns.' };

  const cell = (row: unknown[], i: number) => (i === -1 || row[i] == null ? '' : String(row[i]).trim());
  const byKey = new Map<string, BulkBackfillParsedShop>();
  const UNIT_ALIASES: Record<string, string> = { ft: 'ft', feet: 'ft', foot: 'ft', "'": 'ft', in: 'in', inch: 'in', inches: 'in', '"': 'in', m: 'm', mtr: 'm', meter: 'm', meters: 'm', metre: 'm', metres: 'm', cm: 'cm', centimeter: 'cm', centimeters: 'cm', centimetre: 'cm', mm: 'mm', millimeter: 'mm' };
  const unitErrors: string[] = [];
  const normUnit = (raw: string, rowNo: number, colName: string): string => {
    const t = raw.trim().toLowerCase();
    if (!t) return '';
    const u = UNIT_ALIASES[t];
    if (!u) unitErrors.push(`Row ${rowNo} (${colName}): "${raw}" samajh nahi aaya — ft / in / m / cm use karein`);
    return u || '';
  };

  const norm = (v: string) => v.trim().toLowerCase().replace(/\s+/g, ' ');
  const phoneKey = (v: string) => v.replace(/\D/g, '').slice(-10);
  // A shop is identified by Shop Name + Phone (or + City when there is no phone) — NOT by Work Order, Client,
  // Address or the "New Shop?" flag. Every row of the same shop therefore lands on ONE shop; its rows are just more works.
  const nameKeyOf = (row: unknown[]) => `${norm(cell(row, idx.shopName))}|${phoneKey(cell(row, idx.phone)) || norm(cell(row, idx.city))}`;
  // If any row of a shop carries a Shop ID, all rows with the same name key use that ID.
  const idByNameKey = new Map<string, string>();
  for (let r = 1; r < aoa.length; r++) {
    const row = aoa[r] || []; const id = cell(row, idx.shopId);
    if (id && cell(row, idx.shopName)) idByNameKey.set(nameKeyOf(row), id);
  }
  const flags = new Map<string, { yes: boolean; no: boolean }>();
  const STATUS_LOOKUP: Record<string, string> = {};
  for (const st of SHOP_STATUSES) { STATUS_LOOKUP[st] = st; STATUS_LOOKUP[(STATUS_LABELS[st] || st).toLowerCase()] = st; STATUS_LOOKUP[st.replace(/_/g, ' ')] = st; }
  const splitUnit = (raw: string, rowNo: number): { w: string; h: string } => {
    const t = raw.trim().toLowerCase().replace(/[×*/\\|-]/g, ' x ').replace(/\s+by\s+/g, ' x ').replace(/\s+/g, ' ');
    if (!t) return { w: '', h: '' };
    const parts = t.split(/\s+x\s+/).map((x) => x.trim()).filter(Boolean);
    if (parts.length === 1) { const u = normUnit(parts[0], rowNo, 'Unit'); return { w: u, h: u }; }
    if (parts.length === 2) return { w: normUnit(parts[0], rowNo, 'Unit'), h: normUnit(parts[1], rowNo, 'Unit') };
    unitErrors.push(`Row ${rowNo} (Unit): "${raw}" samajh nahi aaya — ft / in / m / cm ya "ft x in" jaisa combo chuniye`);
    return { w: '', h: '' };
  };

  for (let r = 1; r < aoa.length; r++) {
    const row = aoa[r] || [];
    const shopName = cell(row, idx.shopName);
    const nameKey = nameKeyOf(row);
    const shopId = cell(row, idx.shopId) || (shopName ? idByNameKey.get(nameKey) || '' : '');
    const phone = cell(row, idx.phone);
    const newShopFlag = cell(row, idx.newShop).toLowerCase();
    // A completely blank row (common at the bottom of a template) — skip silently.
    if (!shopId && !shopName) continue;

    const key = shopId || `name:${nameKey}`;
    const fl = flags.get(key) || { yes: false, no: false };
    if (newShopFlag === 'yes') fl.yes = true;
    if (newShopFlag === 'no') fl.no = true;
    flags.set(key, fl);

    let entry = byKey.get(key);
    if (!entry) {
      entry = {
        key, shopId, isNew: false, isNewAmbiguous: false, shopName, phone,
        clientName: '', workOrderNumber: '', city: '', district: '', state: '', address: '', ownerName: '',
        stage: null, stageRaw: '', currentStatus: null, currentStatusRaw: '',
        items: [], surveyor: '', designer: '', production: '', installer: '', note: '',
      };
      byKey.set(key, entry);
    }
    // first non-empty value of every shop field wins
    const fill = <K extends 'clientName' | 'workOrderNumber' | 'city' | 'district' | 'state' | 'address' | 'ownerName' | 'phone'>(k: K, v: string) => { if (v && !entry![k]) (entry![k] as string) = v; };
    fill('clientName', cell(row, idx.client)); fill('workOrderNumber', cell(row, idx.workOrder)); fill('city', cell(row, idx.city));
    fill('district', cell(row, idx.district)); fill('state', cell(row, idx.state)); fill('address', cell(row, idx.address));
    fill('ownerName', cell(row, idx.ownerName)); fill('phone', phone);

    const stageRaw = cell(row, idx.stage);
    if (stageRaw && !entry.stageRaw) { entry.stageRaw = stageRaw; entry.stage = STAGE_LOOKUP[stageRaw.toLowerCase()] || null; }
    const statusRaw = cell(row, idx.currentStatus);
    if (statusRaw && !entry.currentStatusRaw) {
      entry.currentStatusRaw = statusRaw;
      entry.currentStatus = STATUS_LOOKUP[statusRaw.toLowerCase()] || null;
      if (!entry.currentStatus) unitErrors.push(`Row ${r + 1} (Current Status): "${statusRaw}" list me nahi hai — dropdown se chuniye`);
    }
    const surveyor = cell(row, idx.surveyor); if (surveyor && !entry.surveyor) entry.surveyor = surveyor;
    const designer = cell(row, idx.designer); if (designer && !entry.designer) entry.designer = designer;
    const production = cell(row, idx.production); if (production && !entry.production) entry.production = production;
    const installer = cell(row, idx.installer); if (installer && !entry.installer) entry.installer = installer;
    const note = cell(row, idx.note); if (note && !entry.note) entry.note = note;

    const width = cell(row, idx.width);
    const height = cell(row, idx.height);
    const qty = cell(row, idx.qty) || (width && height ? '1' : '');
    if (width && height && qty) {
      const combo = splitUnit(cell(row, idx.unit), r + 1);
      const legacyH = idx.heightUnit !== -1 ? normUnit(cell(row, idx.heightUnit), r + 1, 'Height Unit') : '';
      const unit = combo.w || 'ft';
      const heightUnit = legacyH || combo.h || unit;
      if (Number.isNaN(Number(width)) || Number.isNaN(Number(height))) unitErrors.push(`Row ${r + 1}: Width/Height sirf number hona chahiye (mila: "${width}" × "${height}") — unit "Unit" column me chuniye`);
      entry.items.push({ workType: cell(row, idx.workType), material: cell(row, idx.material), width, height, unit, heightUnit, quantity: qty, workOrder: cell(row, idx.workOrder) });
    }
  }
  for (const entry of byKey.values()) {
    const fl = flags.get(entry.key) || { yes: false, no: false };
    entry.isNew = !entry.shopId && !(fl.no && !fl.yes);
    entry.isNewAmbiguous = !entry.shopId && !fl.yes && !fl.no && !!entry.shopName;
    // a blank New Shop? on a named shop is fine now: it is matched by name, created only if it does not exist
    if (entry.isNewAmbiguous) { entry.isNew = true; entry.isNewAmbiguous = false; }
  }

  if (unitErrors.length) return { error: `Excel me ye sudhaarein:\n${unitErrors.slice(0, 8).join('\n')}${unitErrors.length > 8 ? `\n… aur ${unitErrors.length - 8} aur` : ''}` };
  return { shops: Array.from(byKey.values()) };
}
