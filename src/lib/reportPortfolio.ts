/** Unified printable portfolio exports. One original photo = one evidence block,
 * including ALL saved polygons and the exact linked work-item measurements.
 * Existing survey/design/installation records are read only; no writes to DB.
 */
import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import ExcelJS from 'exceljs';
import pptxgen from 'pptxgenjs';
import { itemSizeLabel } from './units';
import { prepareEvidenceImage, type EvidenceMark, type PreparedEvidence } from './reportImage';
import { isPrivateStorageUrl } from './secureMedia';

export type PortfolioFormat = 'PDF' | 'PPTX' | 'XLSX';
export interface PortfolioSources {
  shops: any[]; workItems: any[]; surveys: any[]; surveyPhotos: any[];
  surveyPhotoItems?: { survey_photo_id: string; work_item_id: string }[];
  markings: any[]; installations: any[]; designVersions: any[];
  designVersionItems: any[]; invoices: any[]; utilization: any[]; vehicleRows: any[];
}
export interface PortfolioOptions {
  kind: string; format: PortfolioFormat; filePrefix: string;
  organization: string; period: string; combined: boolean;
  /** Called after each original photo is prepared, including failures. */
  onImageProgress?: (done: number, total: number) => void;
}
interface Evidence {
  id: string; type: string; url: string; lines: string[];
  marks: EvidenceMark[]; originalShop: string;
}
interface Section {
  title: string; context: string[]; evidence: Evidence[];
  rows: Record<string, string | number>[]; unlinkedRows?: Record<string, string | number>[]; links: { label: string; url: string }[];
}
interface ReadyImage { entry: Evidence; image: PreparedEvidence }
interface ReadySection extends Section { ready: ReadyImage[] }

const val = (v: unknown) => v == null || v === '' ? '—' : String(v);
const positive = (v: unknown) => Number.isFinite(Number(v)) ? Number(v) : 0;
/** Unique database rows, preserving the first occurrence and original order. */
export function uniqueRecords<T extends { id?: string | null }>(rows: T[]): T[] {
  const seen = new Set<string>();
  return rows.filter((row, index) => {
    const key = row.id || `no-id:${index}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
/** Never let user-entered text become an executable Excel formula. */
export function safeWorkbookText(v: unknown): string {
  const text = val(v);
  return /^[\s\u0000-\u001f]*[=+@\-]/.test(text) ? `’${text}` : text;
}

const slug = (v: string) => v.replace(/[^a-z0-9-_]+/gi, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 85);
const asFilename = (prefix: string, label: string, extension: string) => `${slug(prefix)}-${slug(label)}.${extension}`;
const itemText = (it: any, stage: 'survey' | 'approved' | 'installed' = 'survey') => {
  const qty = stage === 'installed' ? it.installed_quantity : stage === 'approved' ? it.approved_quantity : it.survey_quantity;
  const area = stage === 'installed' ? it.installed_area : stage === 'approved' ? it.approved_area : it.survey_area;
  const display = itemSizeLabel(it, stage);
  return `${val(it.work_type_name)} | ${display} | Qty ${val(qty ?? 1)} | ${area == null ? 'Area not recorded' : `${positive(area).toFixed(2)} sq.ft`}${it.material ? ` | ${it.material}` : ''}`;
};
const isRaster = (url: string) => !/\.(pdf|docx?|xlsx?|pptx?|zip)(\?|$)/i.test(url);
function safeExternalUrl(url: string): boolean {
  try { const parsed = new URL(url); return ['http:','https:'].includes(parsed.protocol) && !parsed.username && !parsed.password; }
  catch { return false; }
}

export function buildSections(src: PortfolioSources, kind: string): Section[] {
  if (kind === 'invoice') return uniqueRecords(src.invoices).map(inv => ({
    title: `Invoice ${val(inv.invoice_number)}`,
    context: [
      `Client: ${val(inv.bill_to_name || inv.clients?.name)}`,
      `Invoice date: ${val(inv.invoice_date)} | Due: ${val(inv.due_date)}`,
      `Payment: ${val(inv.payment_status)}`,
      `Subtotal: INR ${positive(inv.subtotal).toFixed(2)} | GST: INR ${positive(inv.tax_amount).toFixed(2)} | Total: INR ${positive(inv.total).toFixed(2)}`,
      ...(positive(inv.igst_amount) ? [`IGST: INR ${positive(inv.igst_amount).toFixed(2)}`] : [
        `CGST: INR ${positive(inv.cgst_amount).toFixed(2)} | SGST: INR ${positive(inv.sgst_amount).toFixed(2)}`]),
    ],
    evidence: [], links: [], rows: uniqueRecords(inv.invoice_items || []).map((it: any) => ({
      Item: val(it.description), Quantity: positive(it.quantity), 'Area (sq.ft)': positive(it.area),
      Rate: positive(it.rate), Amount: positive(it.amount),
    })),
  }));
  if (kind === 'po-utilization') {
    const seen = new Set<string>();
    const rows = src.utilization.filter(r=>{
      const id = String(r.po_line_item_id || r.id || '');
      if (!id || seen.has(id)) return false;
      seen.add(id);return true;
    }).map(r => {
      const areaBased=r.uom==='sqft';
      const budget=areaBased ? r.budgeted_area : r.budgeted_qty;
      const surveyed=areaBased ? r.surveyed_area : r.surveyed_qty;
      const approved=areaBased ? r.approved_area : r.approved_qty;
      const installed=areaBased ? r.installed_area : r.installed_qty;
      const finalized=r.fulfillment_type==='supply_only' ? positive(r.produced_qty) : positive(installed);
      const billed=positive(r.invoiced_amount);
      const budgetAmount=budget == null || r.rate == null ? null : positive(budget)*positive(r.rate);
      return {
        'Work Order':val(r.po_number), Client:val(r.client_name), 'Work type':val(r.work_type_name || r.description),
        UOM:val(r.uom), 'Budgeted units':budget == null ? 'Not set' : positive(budget),
        'Surveyed units':positive(surveyed), 'Approved units':positive(approved),
        'Produced pieces':positive(r.produced_qty), 'Installed units':positive(installed),
        'Finalized units':finalized, 'PO rate':r.rate == null ? 'Not set' : positive(r.rate),
        'Budget value':budgetAmount ?? 'Not set', 'Invoiced value':billed,
        'Remaining budget value':budgetAmount == null ? 'Not set' : Number((budgetAmount-billed).toFixed(2)),
        'Variance units':budget == null ? 'Not set' : Number((finalized-positive(budget)).toFixed(2)),
      };
    });
    return [{title:'Work Order Utilization',context:['Budget vs actual work and invoiced amounts; no planned quantity counted as completed.'],evidence:[],links:[],rows}];
  }
  if (kind === 'vehicle-load-log') return [{ title: 'Vehicle Load Log', context: [], evidence: [], links: [],
    rows: uniqueRecords(src.vehicleRows).map(r => ({ Vehicle: val(r.vehicle_number), Driver: val(r.driver_name), Shop: val(r.shop_name),
      Material: val(r.material), Loaded: positive(r.qty_loaded), Date: val(r.loaded_at),
    })) }];
  return uniqueRecords(src.shops).map(shop => {
    const items = uniqueRecords(src.workItems.filter(w => w.shop_id === shop.id));
    const byId = new Map<string, any>(items.map(it => [it.id, it]));
    const evidence: Evidence[] = [];
    const linkedItems = new Set<string>();
    const links: { label: string; url: string }[] = [];
    // Final installation decks need both before (survey) and after evidence.
    const includeSurvey = kind !== 'installation';
    const includeInstall = ['installation','final-report','ppt-final','excel','excel-multi'].includes(kind);
    const includeDesign = ['design-approval','final-report','excel','excel-multi'].includes(kind);

    if (includeSurvey) {
      for (const photo of uniqueRecords(src.surveyPhotos.filter(p => p.shop_id === shop.id))) {
        if (!photo.photo_url) throw new Error(`Survey image URL missing for ${shop.name}. Verify the original survey record.`);
        const marks = uniqueRecords(src.markings.filter(m => m.survey_photo_id === photo.id && Array.isArray(m.points) && m.points.length >= 3));
        const linked = new Set<string>();
        for (const marking of marks) if (marking.work_item_id && byId.has(marking.work_item_id)) linked.add(marking.work_item_id);
        for (const link of src.surveyPhotoItems || []) if (link.survey_photo_id === photo.id && byId.has(link.work_item_id)) linked.add(link.work_item_id);
        linked.forEach(id => linkedItems.add(id));
        const marked: EvidenceMark[] = marks.map(mark => ({
          points: mark.points, label: mark.work_item_id && byId.has(mark.work_item_id)
            ? `${val(byId.get(mark.work_item_id).work_type_name)} | ${itemSizeLabel(byId.get(mark.work_item_id), 'survey')}` : 'Marked area',
        }));
        const linkedDetails = Array.from(linked).map(id => itemText(byId.get(id), 'survey'));
        evidence.push({ id: `survey:${photo.id}`, type: marked.length ? 'Survey — marked photo' : 'Survey — reference photo',
          url: photo.photo_url, marks: marked, originalShop: shop.name,
          lines: [
            ...linkedDetails,
            ...(!linkedDetails.length && photo.caption ? [photo.caption] : []),
            ...(photo.captured_at ? [`Captured: ${new Date(photo.captured_at).toLocaleString('en-IN')}`] : []),
            ...(photo.gps_lat != null && photo.gps_lng != null ? [`GPS: ${photo.gps_lat}, ${photo.gps_lng}`] : []),
            ...(marked.length && !linkedDetails.length ? ['Marking has no linked work item; verify this record.'] : []),
          ],
        });
      }
    }

    if (includeInstall) {
      const seenProofs = new Set<string>();
      for (const job of uniqueRecords(src.installations.filter(j => j.shop_id === shop.id))) {
        for (const proof of uniqueRecords(job.installation_proofs || [])) {
          if (proof.id && seenProofs.has(proof.id)) continue;
          if (proof.id) seenProofs.add(proof.id);
          if (!proof.photo_url) throw new Error(`Installation proof image URL missing for ${shop.name}. Verify the original installation record.`);
          const linked = proof.work_item_id && byId.get(proof.work_item_id);
          if (linked) linkedItems.add(proof.work_item_id);
          evidence.push({ id: `installation:${proof.id}`, type: `Installation — ${val(proof.photo_type || proof.angle || 'proof')}`,
            url: proof.photo_url, marks: [], originalShop: shop.name,
            lines: [
              ...(linked ? [itemText(linked, 'installed')] : ['Photo not linked to a specific work item']),
              ...(proof.captured_at ? [`Captured: ${new Date(proof.captured_at).toLocaleString('en-IN')}`] : []),
            ],
          });
        }
      }
    }

    if (includeDesign) {
      const itemIds = new Set(items.map(it => it.id));
      for (const design of uniqueRecords(src.designVersions)) {
        const related = src.designVersionItems.filter(link => link.design_version_id === design.id && itemIds.has(link.work_item_id));
        if (!related.length || !design.file_url) continue;
        if (!isRaster(design.file_url)) {
          links.push({ label: `Design version ${val(design.version_number)} (non-image file)`, url: design.file_url });
          continue;
        }
        related.forEach(link => linkedItems.add(link.work_item_id));
        evidence.push({ id: `design:${design.id}`, type: `Design — version ${val(design.version_number)}`, originalShop: shop.name,
          url: design.file_url, marks: [],
          lines: related.map(link => itemText(byId.get(link.work_item_id), 'approved')),
        });
      }
    }

    return {
      title: val(shop.name),
      context: [`Client: ${val(shop.clients?.name)}`, `Work Order: ${val(shop.purchase_orders?.name || shop.purchase_orders?.po_number)}`,
        `Location: ${val(shop.city)}, ${val(shop.state)}`, `Zone: ${shop.zone_id ? val(shop.zones?.name || shop.zone) : 'No Zone'}`, `Status: ${val(shop.status)}`],
      rows: items.map(w => ({ 'Work item': val(w.work_type_name), Material: val(w.material),
        Measurements: itemSizeLabel(w, w.approved_width != null ? 'approved' : 'survey'), Quantity: positive(w.approved_quantity ?? w.survey_quantity ?? 0),
        'Area (sq.ft)': positive(w.approved_area ?? w.survey_area ?? 0),
      })),
      // List unlinked work items only once, after evidence. Avoid duplicating
      // every linked measurement in a separate table before the photographs.
      unlinkedRows: items.filter(w => !linkedItems.has(w.id)).map(w => ({
        'Work item': val(w.work_type_name), Material: val(w.material),
        Measurements: itemSizeLabel(w, w.approved_width != null ? 'approved' : 'survey'),
        Quantity: positive(w.approved_quantity ?? w.survey_quantity ?? 0),
        'Area (sq.ft)': positive(w.approved_area ?? w.survey_area ?? 0),
      })), evidence, links,
    };
  });
}

async function prepareSections(sections: Section[], opts: PortfolioOptions): Promise<ReadySection[]> {
  const count = sections.reduce((n, s) => n + s.evidence.length, 0);
  let done = 0;
  const cache = new Map<string, Promise<PreparedEvidence>>();
  const ready: ReadySection[] = [];
  for (const section of sections) {
    const list: ReadyImage[] = [];
    for (const entry of section.evidence) {
      const key = `${entry.url}:${JSON.stringify(entry.marks)}`;
      if (!cache.has(key)) cache.set(key, prepareEvidenceImage(entry.url, entry.marks));
      try {
        list.push({ entry, image: await cache.get(key)! });
      } catch (error) {
        // An export without the photograph is not a successful field report.
        throw new Error(`Could not embed ${entry.type} for ${section.title}. ${error instanceof Error ? error.message : String(error)}. Verify Storage access and retry.`);
      } finally { done++; opts.onImageProgress?.(done, count); }
    }
    ready.push({ ...section, ready: list });
  }
  return ready;
}

function ascii(v: string): string { return v.replace(/[^\x20-\x7e\n]/g, c => c === '—' ? '-' : c === '×' ? 'x' : c === '·' ? ' | ' : '?'); }
function pdfLabel(pdf: jsPDF, s: string, x: number, y: number, size = 9, bold = false) {
  pdf.setFont('helvetica', bold ? 'bold' : 'normal');
  pdf.setFontSize(size); pdf.setTextColor(28, 42, 62);
  pdf.text(ascii(s), x, y);
}
function pdfImage(pdf: jsPDF, data: PreparedEvidence, x: number, y: number, w: number, h: number) {
  const scale = Math.min(w / data.width, h / data.height);
  const drawW = data.width * scale, drawH = data.height * scale;
  pdf.addImage(data.dataUrl, 'JPEG', x + (w-drawW)/2, y + (h-drawH)/2, drawW, drawH);
}
/** A4 PORTRAIT report. Evidence is the primary content, not a second page after
 * a mostly empty measurement table. One original image appears once with ALL
 * of its saved marks and linked measurements in the same continuous block.
 * Blocks flow between pages without clipping long, multi-board descriptions.
 */
function writeEvidencePdf(pdf: jsPDF, section: ReadySection, opts: PortfolioOptions) {
  const margin = 14;
  const printableWidth = 182;
  const bottom = 277;
  let y = 0;
  const header = (continued = false) => {
    pdf.addPage();
    pdf.setFillColor(244, 247, 251);
    pdf.rect(0, 0, 210, 26, 'F');
    pdfLabel(pdf, opts.organization.slice(0, 60), margin, 9, 9, true);
    pdfLabel(pdf, (section.title + (continued ? ' - continued' : '')).slice(0, 76), margin, 19, 14, true);
    y = 36;
  };
  header();
  pdfLabel(pdf, `${opts.kind.replace(/-/g, ' ')}  |  ${opts.period}`.slice(0, 105), margin, y, 9);
  y += 6;
  for (const line of section.context) {
    const wrapped = pdf.splitTextToSize(ascii(line), printableWidth) as string[];
    for (const part of wrapped) {
      if (y > bottom - 8) header(true);
      pdfLabel(pdf, part, margin, y, 8);
      y += 4.5;
    }
  }
  y += 4;
  if (!section.ready.length && !section.rows.length && !section.links.length) {
    pdfLabel(pdf, 'No evidence or line items are recorded for this section.', margin, y, 9);
    return;
  }
  for (const [idx, card] of section.ready.entries()) {
    // Approximately two typical 16:9/landscape photos per A4 portrait page;
    // a large set of linked boards may require additional details space.
    if (y + 99 > bottom) header(true);
    pdfLabel(pdf, `${idx + 1}. ${card.entry.type}`.slice(0, 110), margin, y, 10, true);
    y += 5;
    // No border / pale frame: the evidence itself is the visual anchor.
    // object-contain behavior keeps original photo orientation and markings.
    pdfImage(pdf, card.image, margin, y, printableWidth, 70);
    y += 73;
    const lines = card.entry.lines.length ? card.entry.lines : ['No linked measurement recorded'];
    for (const line of lines) {
      const wrapped = pdf.splitTextToSize(ascii(line), printableWidth) as string[];
      for (const fragment of wrapped) {
        if (y + 5 > bottom) {
          header(true);
          pdfLabel(pdf, `Evidence ${idx + 1} - linked details continued`, margin, y, 9, true);
          y += 7;
        }
        pdfLabel(pdf, fragment, margin + 2, y, 8.5);
        y += 4.5;
      }
    }
    y += 8;
  }
  // Only show a separate table when NO evidence was available: do not print
  // the same linked measurements twice across table and photographic cards.
  const extraRows = section.ready.length ? section.unlinkedRows || [] : section.rows;
  if (extraRows.length) {
    if (y + 22 > bottom) header(true);
    pdfLabel(pdf, section.ready.length ? 'Other work items (no linked photo)' : 'Work items', margin, y, 9, true);
    y += 5;
    const columns = Object.keys(extraRows[0]);
    autoTable(pdf, {
      head: [columns],
      body: extraRows.map(row => columns.map(column => ascii(val(row[column])))),
      startY: Math.max(y, 60),
      theme: 'striped',
      styles: { fontSize: 8, cellPadding: 2, overflow: 'linebreak' },
      headStyles: { fillColor: [32, 55, 88] },
      margin: { left: margin, right: margin, top: 30, bottom: 20 },
    });
    y = ((pdf as any).lastAutoTable?.finalY || y) + 10;
  }
  if (section.links.length) {
    if (y + 13 > bottom) header(true);
    pdfLabel(pdf, 'Other linked documents', margin, y, 9, true);
    y += 6;
    for (const link of section.links) {
      if (y + 7 > bottom) header(true);
      const text = link.label.slice(0, 95);
      pdfLabel(pdf, isPrivateStorageUrl(link.url) ? `${text} - available in AdRoute` : text, margin + 2, y, 8);
      // A private Supabase URL is not a durable share link. Avoid a broken
      // or unauthorized click target in offline client documents.
      if (!isPrivateStorageUrl(link.url) && safeExternalUrl(link.url)) pdf.link(margin, y - 4, printableWidth, 5, { url: link.url });
      y += 5.5;
    }
  }
}

function downloadBlob(bytes: Uint8Array, filename: string, mime: string) {
  const blob=new Blob([bytes as BlobPart],{type:mime});
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a');a.href=url;a.download=filename;document.body.appendChild(a);a.click();a.remove();
  window.setTimeout(()=>URL.revokeObjectURL(url),60000);
}
async function writeExcel(data: ReadySection[], fileName: string, opts: PortfolioOptions) {
  const wb = new ExcelJS.Workbook(); wb.creator=opts.organization; wb.created=new Date();
  const summary=wb.addWorksheet('Summary', {views:[{state:'frozen',ySplit:1}]});
  summary.columns=[{header:'Shop / section',key:'shop',width:32},{header:'Client / Scope',key:'context',width:65},{header:'Work items',key:'items',width:14},{header:'Evidence',key:'evidence',width:13}];
  for(const s of data)summary.addRow({shop:safeWorkbookText(s.title),context:safeWorkbookText(s.context.join(' | ')),items:s.rows.length,evidence:s.ready.length});
  const details=wb.addWorksheet('Work items',{views:[{state:'frozen',ySplit:1}]});
  const headings=Array.from(new Set(data.flatMap(s=>s.rows.flatMap(r=>Object.keys(r)))));
  details.columns=[{header:'Shop',key:'Shop',width:30},...headings.map(k=>({header:k,key:k,width:k==='Measurements'?28:22}))];
  for(const s of data)for(const row of s.rows)details.addRow(Object.fromEntries(Object.entries({Shop:s.title,...row}).map(([k,v])=>[k,typeof v==='string'?safeWorkbookText(v):v])));
  const ev=wb.addWorksheet('Evidence',{views:[{state:'frozen',ySplit:1}]});
  ev.columns=[{header:'Shop',key:'shop',width:28},{header:'Evidence type',key:'type',width:30},{header:'Marked photo / proof',key:'picture',width:57},{header:'Linked measurements and work item',key:'details',width:72},{header:'Open full-size image',key:'url',width:32}];
  for(const s of data) for(const e of s.ready){
    const privateFile = isPrivateStorageUrl(e.entry.url);
    const row=ev.addRow({shop:safeWorkbookText(s.title),type:safeWorkbookText(e.entry.type),details:safeWorkbookText(e.entry.lines.join('\n') || 'No linked measurement'),url:privateFile?'Embedded image (private source)':'Open image'});
    row.height=185; row.getCell(4).alignment={wrapText:true,vertical:'middle'};
    if (!privateFile && safeExternalUrl(e.entry.url)) {
      row.getCell(5).value={text:'Open original image',hyperlink:e.entry.url};
      row.getCell(5).font={color:{argb:'FF1762AA'},underline:true};
    }
    const imageId=wb.addImage({base64:e.image.dataUrl.split(',')[1],extension:'jpeg'});
    // One embedded marked image for every evidence row — links are supplementary.
    ev.addImage(imageId,{tl:{col:2.05,row:row.number-0.92},br:{col:2.93,row:row.number-0.03},editAs:'oneCell'});
  }
  const design=wb.addWorksheet('Linked design files');
  design.columns=[{header:'Shop',key:'shop',width:35},{header:'File',key:'file',width:45},{header:'Open',key:'link',width:45}];
  for(const s of data)for(const link of s.links){
    const privateFile=isPrivateStorageUrl(link.url);
    const row=design.addRow({shop:safeWorkbookText(s.title),file:safeWorkbookText(link.label),link:privateFile?'Private — open in AdRoute':'Open design file'});
    if (!privateFile && safeExternalUrl(link.url)) row.getCell(3).value={text:'Open design file',hyperlink:link.url};
  }
  for(const sheet of [summary,details,ev,design]){
    sheet.getRow(1).font={bold:true,color:{argb:'FFFFFFFF'}};
    sheet.getRow(1).fill={type:'pattern',pattern:'solid',fgColor:{argb:'FF223B61'}};
    sheet.autoFilter={from:{row:1,column:1},to:{row:1,column:sheet.columnCount}};
  }
  const buffer=await wb.xlsx.writeBuffer();
  downloadBlob(new Uint8Array(buffer as ArrayBuffer),fileName,'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
}

async function writePdf(data: ReadySection[], fileName: string, opts: PortfolioOptions) {
  const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  // jsPDF creates one empty page; remove it after the first evidence page.
  for (const section of data) writeEvidencePdf(pdf, section, opts);
  if (pdf.getNumberOfPages() > 1) pdf.deletePage(1);
  const pages = pdf.getNumberOfPages();
  for (let page = 1; page <= pages; page++) {
    pdf.setPage(page);
    pdf.setTextColor(100, 116, 139);
    pdf.setFontSize(8);
    pdf.text(`Page ${page} / ${pages}`, 196, 288, { align: 'right' });
  }
  pdf.save(fileName);
}
function contain(image: PreparedEvidence, x: number,y: number,w: number,h: number) {
  const scale=Math.min(w/image.width,h/image.height);
  const drawW=image.width*scale, drawH=image.height*scale;
  return {x:x+(w-drawW)/2,y:y+(h-drawH)/2,w:drawW,h:drawH};
}
async function writePpt(data: ReadySection[], fileName: string, opts: PortfolioOptions) {
  const ppt=new pptxgen();ppt.layout='LAYOUT_WIDE';ppt.author=opts.organization;ppt.subject=`${opts.kind} | ${opts.period}`;
  for(const sec of data){
    const overview=ppt.addSlide();overview.background={color:'FFFFFF'};
    overview.addShape(ppt.ShapeType.rect,{x:0,y:0,w:13.333,h:.8,line:{color:'203F6A'},fill:{color:'203F6A'}});
    overview.addText(opts.organization,{x:.45,y:.19,w:6,h:.35,fontSize:13,bold:true,color:'FFFFFF'});
    overview.addText(`${opts.kind.replace(/-/g,' ')}  |  ${opts.period}`,{x:8,y:.2,w:4.9,h:.3,fontSize:9,color:'E2E8F0',align:'right'});
    overview.addText(sec.title,{x:.5,y:1,w:12.3,h:.55,fontSize:24,bold:true,color:'172B4D'});
    overview.addText(sec.context.join('    |    '),{x:.5,y:1.68,w:12.2,h:.8,fontSize:12,color:'52657B',breakLine:false});
    if(sec.links.length) {
      const descriptions=sec.links.map(link=>isPrivateStorageUrl(link.url) ? `${link.label} — open from authorized AdRoute account` : `${link.label} — external file`);
      overview.addText(descriptions.join('\n').slice(0,1200),{x:.5,y:2.28,w:12.2,h:.35,fontSize:9,color:'52657B',breakLine:false,fit:'shrink'} as any);
    }
    if(sec.rows.length){
      const headers=Object.keys(sec.rows[0]);
      const perSlide=9;
      for(let start=0;start<sec.rows.length;start+=perSlide){
        const slide=start?ppt.addSlide():overview;
        if(start){slide.addText(`${sec.title} — items (continued)`,{x:.5,y:.4,w:12.4,h:.45,fontSize:19,bold:true,color:'172B4D'});}
        const rows=sec.rows.slice(start,start+perSlide).map(row=>headers.map(k=>val(row[k])));
        slide.addTable([headers,...rows],{x:.5,y:start?1.2:2.7,w:12.3,h:4.2,fontSize:9,border:{pt:.5,color:'CAD5E2'},color:'213448',margin:.06,
          fill:'FFFFFF',autoFit:false,breakLine:false} as any);
      }
    }
    for(let i=0;i<sec.ready.length;i+=2){
      const slide=ppt.addSlide();slide.background={color:'FFFFFF'};
      slide.addText(sec.title,{x:.4,y:.2,w:11,h:.45,fontSize:19,bold:true,color:'1B3354'});
      slide.addText(`${opts.period}  |  Evidence ${i+1}-${Math.min(i+2,sec.ready.length)} of ${sec.ready.length}`,
        {x:.4,y:.7,w:12,h:.3,fontSize:10,color:'64748B'});
      for(let j=0;j<2;j++){
        const card=sec.ready[i+j];if(!card)continue;
        const x=.45+j*6.4;
        slide.addText(card.entry.type,{x:x+.18,y:1.28,w:5.7,h:.3,fontSize:12,bold:true,color:'1B3354'});
        const frame=contain(card.image,x+.22,1.76,5.58,3.42);
        slide.addImage({data:card.image.dataUrl,...frame});
        const details=card.entry.lines.join('\n')||'No linked measurements recorded';
        slide.addText(details,{x:x+.18,y:5.32,w:5.65,h:1.55,fontSize:9,color:'364B62',margin:.02,
          valign:'top',breakLine:false,fit:'shrink'} as any);
      }
    }
  }
  await ppt.writeFile({fileName});
}

/** Save a combined report or one file per shop, with all images preflighted first.
 * A broken evidence URL aborts the export instead of silently generating blank pages.
 */
export async function generatePortfolioReport(src: PortfolioSources, opts: PortfolioOptions): Promise<number> {
  const sections=buildSections(src,opts.kind).filter(sec=>sec.rows.length||sec.evidence.length||sec.links.length);
  if(!sections.length) throw new Error('No matching report data. Adjust your client, shop or date filters.');
  const prepared=await prepareSections(sections,opts);
  const write=async(batch: ReadySection[],label:string) => {
    const suffix=opts.format==='PDF'?'pdf':opts.format==='PPTX'?'pptx':'xlsx';
    const fileName=asFilename(opts.filePrefix,label,suffix);
    if(opts.format==='PDF')await writePdf(batch,fileName,opts);
    else if(opts.format==='PPTX')await writePpt(batch,fileName,opts);
    else await writeExcel(batch,fileName,opts);
  };
  if(opts.combined || prepared.length===1) await write(prepared,opts.organization||'portfolio');
  else for(let i=0;i<prepared.length;i++) await write([prepared[i]],`${prepared[i].title}-${i+1}`);
  return prepared.length;
}
