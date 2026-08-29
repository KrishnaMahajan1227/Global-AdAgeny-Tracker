import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import * as XLSX from 'xlsx';
import pptxgen from 'pptxgenjs';
import { Shop, WorkItem, Survey, SurveyPhoto, InstallationJob, InstallationProof, Invoice, InvoiceItem, Organization, Client, BoardMarking, DesignVersion, DesignVersionItem, VehicleLoadLogRow } from './types';
import { renderMarkedImage, toJpegDataUrl, loadImage, buildBoardLabel, numberMarkingsByPhoto } from './markingUtils';

function formatCurrency(amount: number, currency: string = 'INR') {
  const symbols: Record<string, string> = { INR: 'Rs', USD: '$', EUR: '€' };
  const symbol = symbols[currency] || currency;
  return `${symbol} ${amount.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
}

function formatDate(date: string | null) {
  if (!date) return 'N/A';
  return new Date(date).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

/** A shop's `clients`/`projects` embed may come back flattened (client_name)
 *  or nested (clients: { name }) depending on which query produced it. Read
 *  whichever shape is actually present instead of assuming one, so exports
 *  never silently show a blank Client/Project column. */
function shopClientName(shop: any): string {
  return shop?.clients?.name || shop?.client_name || '';
}
function shopProjectName(shop: any): string {
  return shop?.projects?.name || shop?.project_name || '';
}
/** Same flattened-or-nested handling for zone: prefer the structured
 *  zones(name) join, fall back to the legacy free-text `zone` column for
 *  shops that predate/skip the zones table. */
function shopZoneName(shop: any): string {
  return shop?.zones?.name || shop?.zone_name || shop?.zone || '';
}

/** Sanitizes a name for use inside a downloaded filename. */
function slug(name: string) {
  return (name || 'untitled').replace(/[^a-z0-9-]+/gi, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

/** One photo, ready for the report, with every board marked on it burned in together. */
type BoardImageGroup = {
  photoId: string;
  items: WorkItem[];
  dataUrl: string;
};

/**
 * Groups work items by the survey photo their marking actually lives on,
 * so a photo that has two or three boards marked on it (one wide shopfront
 * shot with a signboard + a flex board both marked on it, say) is rendered
 * ONCE with every one of its polygons and labels burned in — not repeated
 * as a separate "photo" per work item with only that one item's polygon
 * showing each time. This is what makes exports correctly show all three
 * cases: a single marked image, several markings on one shared image, or
 * several separate images — matching exactly what board_markings actually
 * recorded, the same grouping the in-app review screen already uses.
 *
 * Work items with no saved marking (or fewer than 3 points) fall back to
 * the survey's first photo shown plain, each on its own — same behaviour
 * as before for that edge case.
 */
async function buildBoardImageGroups(
  workItems: WorkItem[],
  photos: SurveyPhoto[],
  markings: BoardMarking[]
): Promise<BoardImageGroup[]> {
  const groups: BoardImageGroup[] = [];
  const byPhoto = new Map<string, WorkItem[]>();
  const unmarked: WorkItem[] = [];

  for (const item of workItems) {
    const marking = markings.find((m) => m.work_item_id === item.id);
    if (marking && marking.points?.length >= 3) {
      const list = byPhoto.get(marking.survey_photo_id) || [];
      list.push(item);
      byPhoto.set(marking.survey_photo_id, list);
    } else {
      unmarked.push(item);
    }
  }

  for (const [photoId, items] of byPhoto) {
    const photo = photos.find((p) => p.id === photoId);
    if (!photo?.photo_url) continue;
    const pointSets = items.map((item) => markings.find((m) => m.work_item_id === item.id)!.points);
    const labels = items.map((item) =>
      buildBoardLabel({
        workTypeName: item.work_type_name,
        width: item.approved_width ?? item.survey_width,
        height: item.approved_height ?? item.survey_height,
        unit: item.approved_unit ?? item.survey_unit,
      })
    );
    try {
      const { dataUrl } = await renderMarkedImage(photo.photo_url, pointSets, { labels });
      groups.push({ photoId, items, dataUrl });
    } catch {
      // Photo failed to load/render (e.g. offline) — skip it, same as the
      // old per-item behaviour did on a failed fetch.
    }
  }

  for (const item of unmarked) {
    const photo = photos[0];
    if (!photo?.photo_url) continue;
    try {
      const dataUrl = await toJpegDataUrl(photo.photo_url);
      groups.push({ photoId: photo.id, items: [item], dataUrl });
    } catch {
      // skip
    }
  }

  return groups;
}

/** Adds a data-URL image to a jsPDF doc at x/y, scaled to fit maxWidth/maxHeight while preserving aspect ratio. Returns the height actually used. */
async function addFittedImage(doc: jsPDF, dataUrl: string, x: number, y: number, maxWidth: number, maxHeight: number): Promise<number> {
  const img = await loadImage(dataUrl);
  const ratio = Math.min(maxWidth / img.naturalWidth, maxHeight / img.naturalHeight);
  const w = img.naturalWidth * ratio;
  const h = img.naturalHeight * ratio;
  // Always declared as JPEG: every dataUrl reaching this point was produced
  // either by renderMarkedImage's canvas (which encodes JPEG) or by
  // toJpegDataUrl (which normalizes to JPEG) — so the declared format
  // always matches the actual bytes. Declaring the wrong format here used
  // to be exactly what made some exported photos render broken or cut off.
  doc.addImage(dataUrl, 'JPEG', x, y, w, h);
  return h;
}

/**
 * Draws a fixed-size, bordered box and fits (letterboxes + centers) an
 * image inside it — used side-by-side for the design-comparison export so
 * the "Surveyed & Marked" and "Uploaded Design" photos always occupy the
 * exact same footprint on the page, regardless of their actual pixel
 * dimensions or aspect ratio. Before this, each column just drew its image
 * at its own aspect-fitted size with nothing else in the box, so a tall
 * design file next to a wide survey photo (or vice versa) rendered at two
 * visibly different sizes and left large uneven gaps of blank page around
 * whichever image was smaller. A missing image still reserves the same
 * box with a centered placeholder, so the two columns and the page's used
 * height never depend on which side happens to have a photo.
 */
async function addBoxedImage(
  doc: jsPDF,
  dataUrl: string | null,
  x: number,
  y: number,
  boxW: number,
  boxH: number,
  placeholder: string
): Promise<void> {
  doc.setDrawColor(226, 232, 240);
  doc.setFillColor(248, 250, 252);
  doc.roundedRect(x, y, boxW, boxH, 2, 2, 'FD');

  if (!dataUrl) {
    doc.setFontSize(9);
    doc.setFont('helvetica', 'italic');
    doc.setTextColor(148, 163, 184);
    doc.text(placeholder, x + boxW / 2, y + boxH / 2, { align: 'center', maxWidth: boxW - 12 });
    doc.setTextColor(0, 0, 0);
    return;
  }

  const pad = 4;
  try {
    const img = await loadImage(dataUrl);
    const innerW = boxW - pad * 2;
    const innerH = boxH - pad * 2;
    const ratio = Math.min(innerW / img.naturalWidth, innerH / img.naturalHeight);
    const w = img.naturalWidth * ratio;
    const h = img.naturalHeight * ratio;
    const drawX = x + (boxW - w) / 2;
    const drawY = y + (boxH - h) / 2;
    doc.addImage(dataUrl, 'JPEG', drawX, drawY, w, h);
  } catch {
    doc.setFontSize(9);
    doc.setFont('helvetica', 'italic');
    doc.setTextColor(148, 163, 184);
    doc.text('(Image unavailable)', x + boxW / 2, y + boxH / 2, { align: 'center' });
    doc.setTextColor(0, 0, 0);
  }
}

/**
 * Draws a bold caption line immediately followed by a fitted image,
 * treating the pair as one unbreakable block: if both wouldn't fit in the
 * remaining space on the current page, the whole block moves to a fresh
 * page together instead of splitting (caption stranded at the bottom of
 * one page, photo alone at the top of the next) — that split is what made
 * older exports look like a photo had been cut off or gone missing.
 * Returns the new y cursor position.
 */
async function addCaptionedImage(
  doc: jsPDF,
  caption: string,
  dataUrl: string,
  x: number,
  y: number,
  maxWidth: number,
  maxHeight: number,
  pageHeight: number
): Promise<number> {
  let imgH = maxHeight;
  try {
    const img = await loadImage(dataUrl);
    const ratio = Math.min(maxWidth / img.naturalWidth, maxHeight / img.naturalHeight);
    imgH = img.naturalHeight * ratio;
  } catch {
    // Fall back to the worst-case (full maxHeight) for the page-break
    // check below; addFittedImage will surface the real failure after.
  }

  const blockHeight = 10 + imgH + 10; // caption line + gap, image, trailing gap
  if (y + blockHeight > pageHeight - 20) {
    doc.addPage();
    y = 20;
  }

  doc.setFontSize(10);
  doc.setFont('helvetica', 'bold');
  doc.text(caption, x, y, { maxWidth });
  y += 6;
  try {
    const h = await addFittedImage(doc, dataUrl, x, y, maxWidth, maxHeight);
    y += h + 10;
  } catch {
    y += 4;
  }
  return y;
}

/**
 * Draws the heading block for one shop's section within a report. When
 * `includeOrgHeader` is false (multi-shop combined reports, which already
 * show the org letterhead once on the cover page) this is just the section
 * title; when true (a single-shop report with no cover page) it also draws
 * the organization letterhead so the lone page is still fully self-contained.
 * Returns the y cursor to continue drawing from.
 */
function drawSectionHeader(
  doc: jsPDF,
  title: string,
  org: Organization | null | undefined,
  includeOrgHeader: boolean,
  titleColor: [number, number, number] = [15, 23, 42]
): number {
  const pageWidth = doc.internal.pageSize.getWidth();
  let y = 20;
  if (includeOrgHeader && org) {
    doc.setFontSize(18);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(0, 0, 0);
    doc.text(org.name, 14, y);
    doc.setFontSize(10);
    doc.setFont('helvetica', 'normal');
    if (org.address) doc.text(org.address, 14, y + 7);
    doc.text(`GST: ${org.gst_number || 'N/A'}`, 14, y + 13);
    y += 24;
  }
  doc.setFontSize(16);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(titleColor[0], titleColor[1], titleColor[2]);
  doc.text(title, 14, y, { maxWidth: pageWidth - 28 });
  doc.setTextColor(0, 0, 0);
  doc.setDrawColor(203, 213, 225);
  doc.line(14, y + 4, pageWidth - 14, y + 4);
  return y + 15;
}

/**
 * Cover / index page for a combined multi-shop report: org letterhead, the
 * report title, when it was generated, and a table listing every shop
 * included so the reader (or the client) can see at a glance what's inside
 * this one PDF before flipping to the per-shop sections that follow.
 */
function drawCoverPage(
  doc: jsPDF,
  org: Organization | null | undefined,
  title: string,
  shops: Shop[],
  subtitle?: string
) {
  let y = 25;
  if (org) {
    doc.setFontSize(20);
    doc.setFont('helvetica', 'bold');
    doc.text(org.name, 14, y);
    y += 8;
    doc.setFontSize(10);
    doc.setFont('helvetica', 'normal');
    if (org.address) {
      doc.text(org.address, 14, y);
      y += 6;
    }
    doc.text(`GST: ${org.gst_number || 'N/A'}`, 14, y);
    y += 16;
  } else {
    y += 8;
  }

  doc.setFontSize(22);
  doc.setFont('helvetica', 'bold');
  doc.text(title, 14, y);
  y += 9;

  if (subtitle) {
    doc.setFontSize(12);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(100, 116, 139);
    doc.text(subtitle, 14, y);
    doc.setTextColor(0, 0, 0);
    y += 8;
  }

  doc.setFontSize(10);
  doc.setFont('helvetica', 'normal');
  doc.text(`Generated: ${new Date().toLocaleString('en-IN')}`, 14, y);
  y += 6;
  doc.text(`Shops Included: ${shops.length}`, 14, y);
  y += 12;

  doc.setFontSize(13);
  doc.setFont('helvetica', 'bold');
  doc.text('Included Shops', 14, y);
  y += 4;

  autoTable(doc, {
    head: [['#', 'Shop Name', 'Client', 'City', 'Status']],
    body: shops.map((s, i) => [`${i + 1}`, s.name, shopClientName(s) || 'N/A', s.city || 'N/A', s.status]),
    startY: y + 4,
    theme: 'striped',
    headStyles: { fillColor: [37, 99, 235] },
    styles: { fontSize: 9 },
  });
}

/** Stamps a consistent "Generated on ... - Page X of Y" footer on every page of the document, once, after all content has been drawn. */
function addDocumentFooters(doc: jsPDF) {
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const pageCount = doc.getNumberOfPages();
  const stamp = new Date().toLocaleString('en-IN');
  for (let i = 1; i <= pageCount; i++) {
    doc.setPage(i);
    doc.setFontSize(8);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(120, 120, 120);
    doc.text(`Generated on ${stamp} - Page ${i} of ${pageCount}`, pageWidth / 2, pageHeight - 10, { align: 'center' });
    doc.setTextColor(0, 0, 0);
  }
}

// ---------------------------------------------------------------------------
// Survey reports
// ---------------------------------------------------------------------------

export type SurveyReportEntry = {
  shop: Shop;
  survey: Survey;
  photos: SurveyPhoto[];
  workItems: WorkItem[];
  surveyorName: string;
  markings?: BoardMarking[];
};

async function drawSurveySection(doc: jsPDF, entry: SurveyReportEntry, org: Organization | null | undefined, includeOrgHeader: boolean) {
  const { shop, survey, photos, workItems, surveyorName } = entry;
  const markings = entry.markings || [];
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();

  let y = drawSectionHeader(doc, `Survey Report — ${shop.name}`, org, includeOrgHeader, [30, 64, 175]);

  doc.setFontSize(10);
  doc.setFont('helvetica', 'normal');
  doc.text(`Shop: ${shop.name}`, 14, y); y += 6;
  doc.text(`Client: ${shopClientName(shop) || 'N/A'}`, 14, y); y += 6;
  doc.text(`City: ${shop.city || 'N/A'}`, 14, y); y += 6;
  doc.text(`Address: ${shop.address || 'N/A'}`, 14, y); y += 6;
  doc.text(`Surveyor: ${surveyorName}`, 14, y); y += 6;
  doc.text(`Date: ${formatDate(survey.submitted_at || survey.created_at)}`, 14, y); y += 6;
  if (survey.gps_lat && survey.gps_lng) {
    doc.text(`GPS: ${survey.gps_lat.toFixed(6)}, ${survey.gps_lng.toFixed(6)}`, 14, y); y += 6;
    doc.text(`GPS Accuracy: ${survey.gps_accuracy?.toFixed(1) || 'N/A'}m`, 14, y); y += 6;
  }
  y += 4;

  const tableData = workItems.map((item, i) => [
    `${i + 1}`,
    item.work_type_name || 'N/A',
    item.material || 'N/A',
    `${item.survey_width || 0} x ${item.survey_height || 0} ${item.survey_unit || 'ft'}`,
    `${item.survey_quantity || 1}`,
    `${item.survey_area || 0} sq ${item.survey_unit || 'ft'}`,
    item.survey_notes || '',
  ]);

  autoTable(doc, {
    head: [['#', 'Work Type', 'Material', 'Dimensions', 'Qty', 'Area', 'Notes']],
    body: tableData,
    startY: y,
    theme: 'striped',
    headStyles: { fillColor: [37, 99, 235] },
  });

  // Marked board photos — one image per photo the surveyor marked, showing
  // every board drawn on that photo, not just a caption line.
  let py = (doc as any).lastAutoTable.finalY + 12;
  doc.setFontSize(13);
  doc.setFont('helvetica', 'bold');
  doc.text('Marked Board Photos', 14, py);
  py += 6;

  const maxImgWidth = pageWidth - 28;
  const maxImgHeight = 90;

  const boardGroups = await buildBoardImageGroups(workItems, photos, markings);
  for (let i = 0; i < boardGroups.length; i++) {
    const group = boardGroups[i];
    const names = group.items.map((it) => it.work_type_name || 'N/A').join(' + ');
    const caption = group.items.length > 1
      ? `Photo ${i + 1}: ${names} (${group.items.length} boards marked on this photo)`
      : `Photo ${i + 1}: ${names}`;
    py = await addCaptionedImage(doc, caption, group.dataUrl, 14, py, maxImgWidth, maxImgHeight, pageHeight);
  }

  // Any remaining photos not tied to a specific board (shop-front shots etc.)
  const usedPhotoIds = new Set(markings.map((m) => m.survey_photo_id));
  const extraPhotos = photos.filter((p) => !usedPhotoIds.has(p.id));
  if (extraPhotos.length > 0) {
    if (py + 12 > pageHeight - 20) { doc.addPage(); py = 20; }
    doc.setFontSize(13);
    doc.setFont('helvetica', 'bold');
    doc.text('Other Photos', 14, py);
    py += 6;
    for (const photo of extraPhotos) {
      if (!photo.photo_url) continue;
      try {
        const dataUrl = await toJpegDataUrl(photo.photo_url);
        py = await addCaptionedImage(doc, photo.caption || photo.photo_type || 'Photo', dataUrl, 14, py, maxImgWidth, maxImgHeight, pageHeight);
      } catch {
        // skip photos that fail to fetch (e.g. offline)
      }
    }
  }
}

/**
 * Builds ONE survey-report PDF covering every entry passed in. A single
 * entry produces a plain one-shop report (unchanged from before); two or
 * more entries get a cover/index page up front and then one clearly
 * separated section per shop (each starting on its own page) inside that
 * same file — this is what keeps a client with several shops to a single,
 * properly organized PDF instead of one file per shop.
 */
export async function generateSurveyReportPDF(
  entries: SurveyReportEntry[],
  org: Organization | null | undefined,
  options: { fileName?: string; groupLabel?: string } = {}
) {
  if (entries.length === 0) return;
  const doc = new jsPDF();
  const includeOrgHeader = entries.length === 1;

  if (entries.length > 1) {
    drawCoverPage(doc, org, 'Survey Reports', entries.map((e) => e.shop), options.groupLabel);
    doc.addPage();
  }

  for (let i = 0; i < entries.length; i++) {
    if (i > 0) doc.addPage();
    await drawSurveySection(doc, entries[i], org, includeOrgHeader);
  }

  addDocumentFooters(doc);
  const fileName = options.fileName || (entries.length === 1
    ? `survey-${slug(entries[0].shop.name)}.pdf`
    : `survey-reports-${entries.length}-shops.pdf`);
  doc.save(fileName);
}

// ---------------------------------------------------------------------------
// Installation reports
// ---------------------------------------------------------------------------

export type InstallationReportEntry = {
  shop: Shop;
  job: InstallationJob;
  proofs: InstallationProof[];
  workItems: WorkItem[];
  installerName: string;
};

async function drawInstallationSection(doc: jsPDF, entry: InstallationReportEntry, org: Organization | null | undefined, includeOrgHeader: boolean) {
  const { shop, job, proofs, workItems, installerName } = entry;
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();

  let y = drawSectionHeader(doc, `Installation Report — ${shop.name}`, org, includeOrgHeader, [4, 120, 87]);

  doc.setFontSize(10);
  doc.setFont('helvetica', 'normal');
  doc.text(`Shop: ${shop.name}`, 14, y); y += 6;
  doc.text(`Client: ${shopClientName(shop) || 'N/A'}`, 14, y); y += 6;
  doc.text(`City: ${shop.city || 'N/A'}`, 14, y); y += 6;
  doc.text(`Installer: ${installerName}`, 14, y); y += 6;
  doc.text(`Started: ${formatDate(job.started_at)}`, 14, y); y += 6;
  doc.text(`Completed: ${formatDate(job.completed_at)}`, 14, y); y += 6;
  if (job.gps_lat && job.gps_lng) {
    doc.text(`GPS: ${job.gps_lat.toFixed(6)}, ${job.gps_lng.toFixed(6)}`, 14, y); y += 6;
  }
  if (job.exception_reason) {
    doc.setTextColor(220, 38, 38);
    doc.text(`Exception: ${job.exception_reason} - ${job.exception_note || ''}`, 14, y, { maxWidth: pageWidth - 28 });
    doc.setTextColor(0, 0, 0);
    y += 6;
  }
  y += 4;

  const installedItems = workItems.filter((w) => w.installed_width);
  const tableData = installedItems.map((item, i) => [
    `${i + 1}`,
    item.work_type_name || 'N/A',
    `${item.installed_width || 0} x ${item.installed_height || 0} ${item.installed_unit || 'ft'}`,
    `${item.installed_quantity || 1}`,
    `${item.installed_area || 0} sq ft`,
    item.installed_notes || '',
  ]);

  let py: number;
  if (tableData.length > 0) {
    autoTable(doc, {
      head: [['#', 'Work Type', 'Installed Dimensions', 'Qty', 'Area', 'Notes']],
      body: tableData,
      startY: y,
      theme: 'striped',
      headStyles: { fillColor: [16, 185, 129] },
    });
    py = (doc as any).lastAutoTable.finalY + 15;
  } else {
    py = y + 6;
  }

  doc.setFontSize(13);
  doc.setFont('helvetica', 'bold');
  doc.text(`Installation Proof Photos (${proofs.length})`, 14, py);
  py += 6;

  const maxImgWidth = pageWidth - 28;
  const maxImgHeight = 90;
  for (const proof of proofs) {
    if (!proof.photo_url) continue;
    const caption = `${proof.photo_type.charAt(0).toUpperCase()}${proof.photo_type.slice(1)}${proof.caption ? ' — ' + proof.caption : ''}`;
    try {
      const dataUrl = await toJpegDataUrl(proof.photo_url);
      py = await addCaptionedImage(doc, caption, dataUrl, 14, py, maxImgWidth, maxImgHeight, pageHeight);
    } catch {
      // skip photos that fail to fetch (e.g. offline)
    }
  }
}

/** Same one-file-per-shop-vs-combined pattern as {@link generateSurveyReportPDF}, for installation reports. */
export async function generateInstallationReportPDF(
  entries: InstallationReportEntry[],
  org: Organization | null | undefined,
  options: { fileName?: string; groupLabel?: string } = {}
) {
  if (entries.length === 0) return;
  const doc = new jsPDF();
  const includeOrgHeader = entries.length === 1;

  if (entries.length > 1) {
    drawCoverPage(doc, org, 'Installation Reports', entries.map((e) => e.shop), options.groupLabel);
    doc.addPage();
  }

  for (let i = 0; i < entries.length; i++) {
    if (i > 0) doc.addPage();
    await drawInstallationSection(doc, entries[i], org, includeOrgHeader);
  }

  addDocumentFooters(doc);
  const fileName = options.fileName || (entries.length === 1
    ? `installation-${slug(entries[0].shop.name)}.pdf`
    : `installation-reports-${entries.length}-shops.pdf`);
  doc.save(fileName);
}

// ---------------------------------------------------------------------------
// Invoices
// ---------------------------------------------------------------------------

function drawInvoiceSection(doc: jsPDF, invoice: Invoice, items: InvoiceItem[], client: Client | null, org: Organization | null | undefined, includeOrgHeader: boolean) {
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  let y = 20;

  if (includeOrgHeader && org) {
    doc.setFontSize(22);
    doc.setFont('helvetica', 'bold');
    doc.text(org.name, 14, y + 5);
    doc.setFontSize(10);
    doc.setFont('helvetica', 'normal');
    doc.text(org.address || '', 14, y + 13);
    doc.text(`GST: ${org.gst_number || 'N/A'}  |  Phone: ${org.phone || 'N/A'}`, 14, y + 19);
    doc.text(`Email: ${org.email || 'N/A'}`, 14, y + 25);
  }

  doc.setFontSize(20);
  doc.setFont('helvetica', 'bold');
  doc.text('INVOICE', pageWidth - 60, y + 5);
  doc.setFontSize(10);
  doc.setFont('helvetica', 'normal');
  doc.text(`#${invoice.invoice_number}`, pageWidth - 60, y + 13);
  doc.text(`Date: ${formatDate(invoice.invoice_date)}`, pageWidth - 60, y + 19);
  if (invoice.due_date) {
    doc.text(`Due: ${formatDate(invoice.due_date)}`, pageWidth - 60, y + 25);
  }
  doc.text(`Status: ${invoice.payment_status.toUpperCase()}`, pageWidth - 60, y + 31);

  y += 40;
  doc.setFontSize(11);
  doc.setFont('helvetica', 'bold');
  doc.text('Bill To:', 14, y);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  // Prefer the frozen bill_to_* snapshot saved on the invoice itself (so an
  // old invoice's PDF never silently changes if the client master record
  // is edited later); fall back to the live client record for invoices
  // created before that snapshot existed.
  const billName = invoice.bill_to_name || client?.name || '';
  const billAddress = invoice.bill_to_address ?? client?.address ?? '';
  const billCity = invoice.bill_to_city ?? client?.city ?? '';
  const billState = invoice.bill_to_state ?? client?.state ?? '';
  const billGst = invoice.bill_to_gst ?? client?.gst_number ?? '';
  let by = y + 6;
  doc.setFont('helvetica', 'bold');
  doc.text(billName, 14, by);
  doc.setFont('helvetica', 'normal');
  if (billAddress) {
    const splitAddr = doc.splitTextToSize(billAddress, pageWidth / 2 - 20);
    doc.text(splitAddr, 14, by + 6);
    by += 6 * splitAddr.length;
  } else {
    by += 6;
  }
  if (billCity || billState) {
    doc.text(`${billCity || ''}${billCity && billState ? ', ' : ''}${billState || ''}`, 14, by + 6);
    by += 6;
  }
  if (billGst) {
    doc.text(`GST: ${billGst}`, 14, by + 6);
    by += 6;
  }

  const tableStartY = Math.max(y + 32, by + 10);

  const hasHsn = items.some((item) => item.hsn_code);
  const head = hasHsn
    ? [['#', 'Description', 'HSN', 'Qty', 'Area', 'Rate', 'Amount']]
    : [['#', 'Description', 'Qty', 'Area', 'Rate', 'Amount']];
  const tableData = items.map((item, i) => {
    const row = [
      `${i + 1}`,
      item.description,
      `${item.quantity}`,
      item.area ? `${item.area} sq ft` : '-',
      formatCurrency(item.rate, org?.default_currency || 'INR'),
      formatCurrency(item.amount, org?.default_currency || 'INR'),
    ];
    if (hasHsn) row.splice(2, 0, item.hsn_code || '-');
    return row;
  });

  autoTable(doc, {
    head,
    body: tableData,
    startY: tableStartY,
    theme: 'striped',
    headStyles: { fillColor: [37, 99, 235] },
    columnStyles: { 1: { cellWidth: hasHsn ? 55 : 65 } },
  });

  let ty = (doc as any).lastAutoTable.finalY + 10;
  const rightX = pageWidth - 60;

  doc.setFontSize(10);
  doc.setFont('helvetica', 'normal');
  doc.text('Subtotal:', rightX - 40, ty);
  doc.text(formatCurrency(invoice.subtotal, org?.default_currency || 'INR'), rightX, ty, { align: 'right' });
  ty += 7;
  // GST-compliant breakdown: CGST+SGST for intra-state, IGST for
  // inter-state — falls back to one combined "Tax" line only for
  // invoices created before this breakdown existed (cgst/sgst/igst all 0).
  if (invoice.igst_rate > 0) {
    doc.text(`IGST (${invoice.igst_rate}%):`, rightX - 40, ty);
    doc.text(formatCurrency(invoice.igst_amount, org?.default_currency || 'INR'), rightX, ty, { align: 'right' });
    ty += 7;
  } else if (invoice.cgst_rate > 0 || invoice.sgst_rate > 0) {
    doc.text(`CGST (${invoice.cgst_rate}%):`, rightX - 40, ty);
    doc.text(formatCurrency(invoice.cgst_amount, org?.default_currency || 'INR'), rightX, ty, { align: 'right' });
    ty += 7;
    doc.text(`SGST (${invoice.sgst_rate}%):`, rightX - 40, ty);
    doc.text(formatCurrency(invoice.sgst_amount, org?.default_currency || 'INR'), rightX, ty, { align: 'right' });
    ty += 7;
  } else {
    doc.text(`Tax (${invoice.tax_rate}%):`, rightX - 40, ty);
    doc.text(formatCurrency(invoice.tax_amount, org?.default_currency || 'INR'), rightX, ty, { align: 'right' });
    ty += 7;
  }
  doc.setDrawColor(203, 213, 225);
  doc.line(rightX - 40, ty - 2, rightX, ty - 2);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(12);
  doc.text('Total:', rightX - 40, ty + 3);
  doc.text(formatCurrency(invoice.total, org?.default_currency || 'INR'), rightX, ty + 3, { align: 'right' });
  ty += 13;

  // Leave room for payment details, terms, notes and the signature block —
  // if what's already on the page won't fit, start a fresh page rather
  // than letting the signature line collide with the footer or notes spill
  // off the bottom edge.
  const reservedFooterSpace = 55;
  if (ty > pageHeight - reservedFooterSpace) {
    doc.addPage();
    ty = 20;
  }

  const leftColX = 14;
  const leftColWidth = pageWidth / 2 - 20;
  let ly = ty;

  // Payment / bank details — tells the client HOW to actually pay.
  if (org && (org.bank_account_name || org.bank_account_number || org.upi_id)) {
    doc.setFontSize(10);
    doc.setFont('helvetica', 'bold');
    doc.text('Payment Details:', leftColX, ly);
    doc.setFont('helvetica', 'normal');
    ly += 6;
    if (org.bank_account_name) { doc.text(`Account Name: ${org.bank_account_name}`, leftColX, ly); ly += 5.5; }
    if (org.bank_name) { doc.text(`Bank: ${org.bank_name}${org.bank_branch ? ` (${org.bank_branch})` : ''}`, leftColX, ly); ly += 5.5; }
    if (org.bank_account_number) { doc.text(`Account No: ${org.bank_account_number}`, leftColX, ly); ly += 5.5; }
    if (org.bank_ifsc) { doc.text(`IFSC: ${org.bank_ifsc}`, leftColX, ly); ly += 5.5; }
    if (org.upi_id) { doc.text(`UPI: ${org.upi_id}`, leftColX, ly); ly += 5.5; }
    ly += 4;
  }

  if (invoice.terms) {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10);
    doc.text('Payment Terms:', leftColX, ly);
    doc.setFont('helvetica', 'normal');
    const splitTerms = doc.splitTextToSize(invoice.terms, leftColWidth);
    doc.text(splitTerms, leftColX, ly + 5.5);
    ly += 5.5 + 5 * splitTerms.length + 4;
  }

  if (invoice.notes) {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10);
    doc.text('Notes:', leftColX, ly);
    doc.setFont('helvetica', 'normal');
    const splitNotes = doc.splitTextToSize(invoice.notes, leftColWidth);
    doc.text(splitNotes, leftColX, ly + 5.5);
    ly += 5.5 + 5 * splitNotes.length;
  }

  // Authorized signatory block — anchored near the page bottom the way a
  // printed letterhead would be, but never above whatever was last drawn
  // (payment details / terms / notes). If there isn't ~30mm of clear space
  // for it below that content, start a fresh page instead of letting the
  // signature line collide with or land on top of the notes text.
  const sigBlockHeight = 30;
  const sigX = pageWidth - 60;
  let sigY = Math.max(ly + 10, pageHeight - 45);
  if (sigY + sigBlockHeight > pageHeight - 10) {
    doc.addPage();
    sigY = 25;
  }
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.text(`For ${org?.name || 'the Company'}`, sigX, sigY, { align: 'left' });
  doc.setDrawColor(150, 150, 150);
  doc.line(sigX, sigY + 16, sigX + 40, sigY + 16);
  doc.text('Authorized Signatory', sigX, sigY + 21);
}

/** Single-invoice PDF — unchanged behaviour, used wherever exactly one invoice is being printed (e.g. from the Billing page). */
export async function generateInvoicePDF(
  invoice: Invoice,
  items: InvoiceItem[],
  client: Client | null,
  org: Organization | null | undefined
) {
  const doc = new jsPDF();
  drawInvoiceSection(doc, invoice, items, client, org, true);
  addDocumentFooters(doc);
  doc.save(`invoice-${invoice.invoice_number}.pdf`);
}

export type InvoiceReportEntry = {
  invoice: Invoice;
  items: InvoiceItem[];
  client: Client | null;
};

/** Combines several invoices into one PDF (one invoice per page) instead of triggering a separate download for each. */
export async function generateInvoiceBundlePDF(
  entries: InvoiceReportEntry[],
  org: Organization | null | undefined,
  options: { fileName?: string } = {}
) {
  if (entries.length === 0) return;
  if (entries.length === 1) {
    const only = entries[0];
    return generateInvoicePDF(only.invoice, only.items, only.client, org);
  }

  const doc = new jsPDF();
  entries.forEach((entry, i) => {
    if (i > 0) doc.addPage();
    drawInvoiceSection(doc, entry.invoice, entry.items, entry.client, org, true);
  });
  addDocumentFooters(doc);
  doc.save(options.fileName || `invoices-${entries.length}.pdf`);
}

// ---------------------------------------------------------------------------
// Final client reports (survey through installation, end to end)
// ---------------------------------------------------------------------------

export type FinalReportEntry = {
  shop: Shop;
  survey: Survey | null;
  surveyPhotos: SurveyPhoto[];
  workItems: WorkItem[];
  proofs: InstallationProof[];
  surveyorName: string;
  installerName: string;
  markings?: BoardMarking[];
};

async function drawFinalClientSection(doc: jsPDF, entry: FinalReportEntry, org: Organization | null | undefined, includeOrgHeader: boolean) {
  const { shop, survey, surveyPhotos, workItems, proofs, surveyorName, installerName } = entry;
  const markings = entry.markings || [];
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();

  let y = drawSectionHeader(doc, `Final Client Report — ${shop.name}`, org, includeOrgHeader, [15, 23, 42]);

  doc.setFontSize(11);
  doc.setFont('helvetica', 'normal');
  doc.text(`Shop: ${shop.name}`, 14, y); y += 7;
  doc.text(`Client: ${shopClientName(shop) || 'N/A'}`, 14, y); y += 7;
  doc.text(`Address: ${shop.address || 'N/A'}`, 14, y); y += 7;
  doc.text(`City: ${shop.city || 'N/A'}, ${shop.state || 'N/A'}`, 14, y); y += 7;
  doc.text(`Owner: ${shop.owner_name || 'N/A'}`, 14, y); y += 10;

  // Timeline
  doc.setFontSize(13);
  doc.setFont('helvetica', 'bold');
  doc.text('Project Timeline', 14, y);
  y += 7;
  doc.setFontSize(10);
  doc.setFont('helvetica', 'normal');

  if (survey) {
    doc.text(`Survey Date: ${formatDate(survey.submitted_at || survey.created_at)}`, 14, y);
    y += 6;
    doc.text(`Surveyor: ${surveyorName}`, 14, y);
    y += 6;
  }
  if (proofs.length > 0) {
    doc.text(`Installation Date: ${formatDate(proofs[0].captured_at)}`, 14, y);
    y += 6;
    doc.text(`Installer: ${installerName}`, 14, y);
    y += 6;
  }

  // Work items
  y += 6;
  doc.setFontSize(13);
  doc.setFont('helvetica', 'bold');
  doc.text('Work Items Summary', 14, y);
  y += 5;

  const tableData = workItems.map((item, i) => [
    `${i + 1}`,
    item.work_type_name || 'N/A',
    item.material || 'N/A',
    `${item.survey_width || 0} x ${item.survey_height || 0} ${item.survey_unit || 'ft'}`,
    `${item.installed_width || item.survey_width || 0} x ${item.installed_height || item.survey_height || 0}`,
    `${item.survey_area || 0}`,
  ]);

  autoTable(doc, {
    head: [['#', 'Type', 'Material', 'Survey Dims', 'Installed Dims', 'Area (sq ft)']],
    body: tableData,
    startY: y + 2,
    theme: 'striped',
    headStyles: { fillColor: [37, 99, 235] },
  });

  // Photos: marked survey board photos, then before/after/installed proof photos.
  let y2 = (doc as any).lastAutoTable.finalY + 12;
  const maxImgWidth = pageWidth - 28;
  const maxImgHeight = 85;

  if (y2 + 12 > pageHeight - 20) { doc.addPage(); y2 = 20; }
  doc.setFontSize(13);
  doc.setFont('helvetica', 'bold');
  doc.text('Marked Survey Photos', 14, y2);
  y2 += 6;
  const finalReportGroups = await buildBoardImageGroups(workItems, surveyPhotos, markings);
  for (let i = 0; i < finalReportGroups.length; i++) {
    const group = finalReportGroups[i];
    const names = group.items.map((it) => it.work_type_name || 'N/A').join(' + ');
    const caption = group.items.length > 1
      ? `Photo ${i + 1}: ${names} (${group.items.length} boards marked on this photo)`
      : `Photo ${i + 1}: ${names}`;
    y2 = await addCaptionedImage(doc, caption, group.dataUrl, 14, y2, maxImgWidth, maxImgHeight, pageHeight);
  }

  if (proofs.length > 0) {
    if (y2 + 12 > pageHeight - 20) { doc.addPage(); y2 = 20; }
    doc.setFontSize(13);
    doc.setFont('helvetica', 'bold');
    doc.text('Installation Photos', 14, y2);
    y2 += 6;
    for (const proof of proofs) {
      if (!proof.photo_url) continue;
      const caption = `${proof.photo_type.charAt(0).toUpperCase()}${proof.photo_type.slice(1)}`;
      try {
        const dataUrl = await toJpegDataUrl(proof.photo_url);
        y2 = await addCaptionedImage(doc, caption, dataUrl, 14, y2, maxImgWidth, maxImgHeight, pageHeight);
      } catch { /* skip photos that fail to fetch */ }
    }
  }
}

/** Same one-file-per-shop-vs-combined pattern as {@link generateSurveyReportPDF}, for the end-to-end final client report. */
export async function generateFinalClientReportPDF(
  entries: FinalReportEntry[],
  org: Organization | null | undefined,
  options: { fileName?: string; groupLabel?: string } = {}
) {
  if (entries.length === 0) return;
  const doc = new jsPDF();
  const includeOrgHeader = entries.length === 1;

  if (entries.length > 1) {
    drawCoverPage(doc, org, 'Final Client Reports', entries.map((e) => e.shop), options.groupLabel);
    doc.addPage();
  }

  for (let i = 0; i < entries.length; i++) {
    if (i > 0) doc.addPage();
    await drawFinalClientSection(doc, entries[i], org, includeOrgHeader);
  }

  addDocumentFooters(doc);
  const fileName = options.fileName || (entries.length === 1
    ? `final-report-${slug(entries[0].shop.name)}.pdf`
    : `final-reports-${entries.length}-shops.pdf`);
  doc.save(fileName);
}

// ---------------------------------------------------------------------------
// Excel exports (single workbook, multiple sheets, for any number of shops)
// ---------------------------------------------------------------------------

/** Everything an Excel export needs to build proper, per-photo rows instead
 *  of cramming several photo URLs into one messy cell. Passing the raw
 *  tables (rather than pre-joined maps) means every sheet below is built
 *  from the same source of truth, so nothing gets silently dropped. */
export interface ExcelPhotoSources {
  surveyPhotos?: SurveyPhoto[];
  boardMarkings?: BoardMarking[];
  installationProofs?: InstallationProof[];
  designVersions?: DesignVersion[];
  designVersionItems?: DesignVersionItem[];
}

const PHOTO_TYPE_LABELS: Record<string, string> = {
  front: 'Front', side: 'Side', wide: 'Wide shot', close_up: 'Close-up', other: 'Other',
};

/** One row per survey photo (not per shop) — the only way multiple photos
 *  for the same shop each get their own clean, individually clickable
 *  link instead of being squeezed into a single cell. Every photo that
 *  has at least one saved board marking is flagged "Yes" under Marked,
 *  with the board(s) marked on it named — this is what actually answers
 *  "which photos are the marked survey photos". */
function buildSurveyPhotoRows(shops: any[], workItems: any[], src: ExcelPhotoSources) {
  const shopById = new Map(shops.map((s) => [s.id, s]));
  const workItemById = new Map((workItems || []).map((w) => [w.id, w]));
  const markingsByPhoto = new Map<string, BoardMarking[]>();
  for (const m of src.boardMarkings || []) {
    if (!m.points || m.points.length < 3) continue;
    const list = markingsByPhoto.get(m.survey_photo_id) || [];
    list.push(m);
    markingsByPhoto.set(m.survey_photo_id, list);
  }

  return (src.surveyPhotos || [])
    .filter((p) => shopById.has(p.shop_id))
    .map((p) => {
      const shop = shopById.get(p.shop_id);
      const markings = markingsByPhoto.get(p.id) || [];
      const boardNames = markings
        .map((m) => (m.work_item_id ? workItemById.get(m.work_item_id) : null))
        .map((w) => w?.work_type_name || null)
        .filter((n): n is string => !!n);
      return {
        'Shop Name': shop?.name || '',
        'Client': shopClientName(shop),
        'City': shop?.city || '',
        'Photo Type': PHOTO_TYPE_LABELS[p.photo_type] || p.photo_type || '',
        'Marked (has board outline)': markings.length > 0 ? 'Yes' : 'No',
        'Board(s) Marked': boardNames.length > 0 ? boardNames.join(', ') : '',
        'Caption': p.caption || '',
        'Uploaded On': p.created_at ? new Date(p.created_at).toLocaleString('en-IN') : '',
        'Photo Link': p.photo_url || '',
      };
    });
}

/** One row per installation proof photo — same "one photo, one row" rule as survey photos above. */
function buildInstallationPhotoRows(shops: any[], src: ExcelPhotoSources) {
  const shopById = new Map(shops.map((s) => [s.id, s]));
  const angleLabels: Record<string, string> = { front: 'Front', side: 'Side', other: 'Other' };
  return (src.installationProofs || [])
    .filter((p) => shopById.has(p.shop_id))
    .map((p) => {
      const shop = shopById.get(p.shop_id);
      return {
        'Shop Name': shop?.name || '',
        'Client': shopClientName(shop),
        'City': shop?.city || '',
        'Photo Type': PHOTO_TYPE_LABELS[p.photo_type] || p.photo_type || '',
        'Angle': angleLabels[p.angle || ''] || p.angle || '',
        'GPS Latitude': p.gps_lat ?? '',
        'GPS Longitude': p.gps_lng ?? '',
        'Caption': p.caption || '',
        'Photo Link': p.photo_url || '',
      };
    });
}

/** One row per (board, design version) — a design version can cover several
 *  boards and a board can have several versions over time, so this is the
 *  only granularity that never silently drops or merges a file. */
function buildDesignFileRows(shops: any[], workItems: any[], src: ExcelPhotoSources) {
  const shopById = new Map(shops.map((s) => [s.id, s]));
  const workItemById = new Map((workItems || []).map((w) => [w.id, w]));
  const versionById = new Map((src.designVersions || []).map((v) => [v.id, v]));

  return (src.designVersionItems || [])
    .map((link) => {
      const item = workItemById.get(link.work_item_id);
      if (!item || !shopById.has(item.shop_id)) return null;
      const version = versionById.get(link.design_version_id);
      if (!version) return null;
      const shop = shopById.get(item.shop_id);
      return {
        'Shop Name': shop?.name || '',
        'Client': shopClientName(shop),
        'Board / Work Type': item.work_type_name || '',
        'Version': `v${version.version_number}`,
        'Source': version.source === 'client_provided' ? 'Client-provided' : 'Agency-designed',
        'File Name': version.file_name || '',
        'Uploaded On': version.created_at ? new Date(version.created_at).toLocaleString('en-IN') : '',
        'File Link': version.file_url || '',
      };
    })
    .filter((row): row is NonNullable<typeof row> => row !== null);
}

/** Writes `rows` as a sheet, auto-sizing columns and turning the last
 *  column (assumed to be the link column, when `linkCol` is set) into
 *  real clickable hyperlinks instead of plain blue-looking text. */
function appendSheetWithLinks(wb: XLSX.WorkBook, sheetName: string, rows: Record<string, any>[], linkCol?: string) {
  const safeRows = rows.length > 0 ? rows : [{ 'No data': 'Nothing matched this filter' }];
  const ws = XLSX.utils.json_to_sheet(safeRows);
  if (rows.length > 0) {
    const headers = Object.keys(rows[0]);
    ws['!cols'] = headers.map((h) => ({ wch: Math.min(Math.max(h.length + 2, 14), 46) }));
    if (linkCol && headers.includes(linkCol)) {
      const colIdx = headers.indexOf(linkCol);
      const colLetter = XLSX.utils.encode_col(colIdx);
      rows.forEach((row, i) => {
        const url = row[linkCol];
        if (!url) return;
        const cellRef = `${colLetter}${i + 2}`;
        if (ws[cellRef]) ws[cellRef].l = { Target: url };
      });
    }
  }
  XLSX.utils.book_append_sheet(wb, ws, sheetName.slice(0, 31));
}

export function exportShopsToExcel(
  shops: any[],
  workItems: any[],
  fileName: string = 'shops-export',
  photoSources: ExcelPhotoSources = {}
) {
  const wb = XLSX.utils.book_new();
  const surveyRows = buildSurveyPhotoRows(shops, workItems, photoSources);
  const installRows = buildInstallationPhotoRows(shops, photoSources);
  const designRows = buildDesignFileRows(shops, workItems, photoSources);

  const surveyCountByShop = new Map<string, number>();
  for (const r of surveyRows) surveyCountByShop.set(r['Shop Name'], (surveyCountByShop.get(r['Shop Name']) || 0) + 1);
  const installCountByShop = new Map<string, number>();
  for (const r of installRows) installCountByShop.set(r['Shop Name'], (installCountByShop.get(r['Shop Name']) || 0) + 1);
  const designCountByShop = new Map<string, number>();
  for (const r of designRows) designCountByShop.set(r['Shop Name'], (designCountByShop.get(r['Shop Name']) || 0) + 1);

  const shopRows = shops.map((shop) => {
    const items = workItems.filter((w) => w.shop_id === shop.id);
    const totalArea = items.reduce((sum, i) => sum + (i.survey_area || 0), 0);
    return {
      'Shop Name': shop.name,
      'Client': shopClientName(shop),
      'Project': shopProjectName(shop),
      'City': shop.city || '',
      'District': shop.district || '',
      'Zone': shopZoneName(shop),
      'State': shop.state || '',
      'Status': shop.status,
      'Owner': shop.owner_name || '',
      'Phone': shop.contact_phone || '',
      'Address': shop.address || '',
      'Work Items': items.length,
      'Total Area (sq ft)': totalArea,
      'Latitude': shop.latitude || '',
      'Longitude': shop.longitude || '',
      'Survey Photos (count)': surveyCountByShop.get(shop.name) || 0,
      'Installation Photos (count)': installCountByShop.get(shop.name) || 0,
      'Design Files (count)': designCountByShop.get(shop.name) || 0,
    };
  });

  appendSheetWithLinks(wb, 'Shops', shopRows);
  appendSheetWithLinks(wb, 'Survey Photos', surveyRows, 'Photo Link');
  appendSheetWithLinks(wb, 'Installation Photos', installRows, 'Photo Link');
  appendSheetWithLinks(wb, 'Design Files', designRows, 'File Link');

  XLSX.writeFile(wb, `${fileName}.xlsx`);
}

export function exportMultiSheetExcel(
  shops: any[],
  workItems: any[],
  fileName: string = 'multi-sheet-export',
  photoSources: ExcelPhotoSources = {}
) {
  const wb = XLSX.utils.book_new();

  const stages = [
    { name: 'Surveyed', filter: (s: any) => ['surveyed', 'approval_pending', 'approved'].includes(s.status) },
    { name: 'Approved', filter: (s: any) => ['approved', 'design_pending', 'designing', 'design_ready', 'in_review', 'design_approved'].includes(s.status) },
    { name: 'Design', filter: (s: any) => ['design_pending', 'designing', 'design_ready', 'in_review', 'design_approved'].includes(s.status) },
    { name: 'Production', filter: (s: any) => ['production_pending', 'in_production', 'production_ready', 'production_hold', 'production_done'].includes(s.status) },
    { name: 'Installed', filter: (s: any) => ['installed', 'dispatched', 'installation_pending', 'installing'].includes(s.status) },
    { name: 'Billed', filter: (s: any) => s.status === 'billed' },
  ];

  stages.forEach((stage) => {
    const filtered = shops.filter(stage.filter);
    const rows = filtered.map((shop) => {
      const items = workItems.filter((w) => w.shop_id === shop.id);
      return {
        'Shop Name': shop.name,
        'Client': shopClientName(shop),
        'City': shop.city || '',
        'Status': shop.status,
        'Work Items': items.length,
        'Total Area': items.reduce((s, i) => s + (i.survey_area || 0), 0),
      };
    });
    appendSheetWithLinks(wb, stage.name, rows);
  });

  // Photo/design detail sheets — same normalized one-row-per-photo shape as
  // exportShopsToExcel, scoped to the full shop list passed in (not
  // filtered per stage, since a photo doesn't belong to a "stage").
  appendSheetWithLinks(wb, 'Survey Photos', buildSurveyPhotoRows(shops, workItems, photoSources), 'Photo Link');
  appendSheetWithLinks(wb, 'Installation Photos', buildInstallationPhotoRows(shops, photoSources), 'Photo Link');
  appendSheetWithLinks(wb, 'Design Files', buildDesignFileRows(shops, workItems, photoSources), 'File Link');

  XLSX.writeFile(wb, `${fileName}.xlsx`);
}

// ---------------------------------------------------------------------------
// PO Utilization / reconciliation report (Phase 6)
// ---------------------------------------------------------------------------

export interface POUtilizationExportRow {
  po_number: string;
  po_date: string;
  fulfillment_type: string;
  client_name: string | null;
  project_name: string | null;
  description: string;
  work_type_name: string | null;
  uom: string;
  budgeted_qty: number | null;
  budgeted_area: number | null;
  rate: number | null;
  surveyed_area: number;
  surveyed_qty: number;
  approved_area: number;
  approved_qty: number;
  produced_qty: number;
  installed_area: number;
  installed_qty: number;
  invoiced_amount: number;
}

// Phase 8b — flat, item-level export of every vehicle load (from
// v_vehicle_load_log via src/lib/vehicleLoadLog.ts). One row per board on
// a vehicle, so Production/Owner can check "kitna saman load hua tha,
// kisne kiya, kisko kiya" (how much material was loaded, by whom, for
// whom) offline, filter/pivot in Excel, or hand it to a client/auditor.
export function exportVehicleLoadLogToExcel(rows: VehicleLoadLogRow[], fileName: string = 'vehicle-load-log') {
  const wb = XLSX.utils.book_new();

  const data = rows.map((r) => ({
    'Loaded At': new Date(r.loaded_at).toLocaleString('en-IN'),
    'Trip Type': r.vehicle_trip_id ? 'Multi-shop trip' : 'Single shop',
    'Vehicle Number': r.vehicle_number,
    'Driver': r.driver_name || '',
    'Shop': r.shop_name,
    'City': r.shop_city || '',
    'Installer': r.installer_name || '',
    'Loaded By': r.loaded_by_name || '',
    'Work Type': r.work_type_name || '',
    'Material': r.material || '',
    'Qty Ready': r.qty_ready,
    'Qty Loaded': r.qty_loaded,
    'Qty Pending': Math.max(r.qty_ready - r.qty_loaded, 0),
    'Status': r.status,
    'Delivered At': r.delivered_at ? new Date(r.delivered_at).toLocaleString('en-IN') : '',
    'Delivered By': r.delivered_by_name || '',
    'Notes': r.notes || '',
  }));

  const ws = XLSX.utils.json_to_sheet(data.length > 0 ? data : [{ 'Vehicle Number': 'No data' }]);
  XLSX.utils.book_append_sheet(wb, ws, 'Vehicle Load Log');

  XLSX.writeFile(wb, `${fileName}.xlsx`);
}

export function exportPOUtilizationToExcel(rows: POUtilizationExportRow[], fileName: string = 'po-utilization-report') {
  const wb = XLSX.utils.book_new();

  const data = rows.map((r) => {
    const areaBased = r.uom === 'sqft';
    const budgeted = areaBased ? r.budgeted_area : r.budgeted_qty;
    const surveyed = areaBased ? r.surveyed_area : r.surveyed_qty;
    const approved = areaBased ? r.approved_area : r.approved_qty;
    const installed = areaBased ? r.installed_area : r.installed_qty;
    const budgetedAmount = budgeted != null && r.rate != null ? budgeted * r.rate : null;
    const variance = budgeted != null ? surveyed - budgeted : null;
    return {
      'PO Number': r.po_number,
      'PO Date': r.po_date ? new Date(r.po_date).toLocaleDateString('en-IN') : '',
      'Fulfillment Type': r.fulfillment_type === 'supply_only' ? 'Supply Only' : 'Survey + Install',
      'Client': r.client_name || '',
      'Project': r.project_name || '',
      'Line Item': r.description,
      'Work Type': r.work_type_name || '',
      'UOM': r.uom,
      'Budgeted': budgeted ?? '',
      'Surveyed': surveyed,
      'Approved': approved,
      'Produced (qty)': r.produced_qty,
      'Installed': installed,
      'Rate': r.rate ?? '',
      'Budgeted Amount (Rs)': budgetedAmount ?? '',
      'Invoiced Amount (Rs)': r.invoiced_amount,
      'Balance (Rs)': budgetedAmount != null ? budgetedAmount - r.invoiced_amount : '',
      'Variance (Surveyed - Budgeted)': variance ?? '',
      'Variance Flag': variance != null && Math.abs(variance) > (budgeted ? budgeted * 0.01 : 0.01) ? 'Yes' : '',
    };
  });

  const ws = XLSX.utils.json_to_sheet(data.length > 0 ? data : [{ 'PO Number': 'No data' }]);
  XLSX.utils.book_append_sheet(wb, ws, 'PO Utilization');

  XLSX.writeFile(wb, `${fileName}.xlsx`);
}

// ---------------------------------------------------------------------------
// Client Organization portal — Reports (Phase 6)
// Deliberately separate export functions from exportPOUtilizationToExcel
// above: that one carries `rate`/budgeted-amount/invoiced-amount figures,
// which a Client Organization user must never receive (see
// GLOBAL_ARCHITECTURE.md section 2.5/7 and clientPortal.ts's header
// comment). Both functions below work off data that already excludes rate
// entirely (ClientPOLineItemProgress / the client's own site+photo lists).
// ---------------------------------------------------------------------------

export interface ClientCampaignExportRow {
  campaign_name: string;
  po_number: string;
  po_date: string;
  agency_name: string;
  fulfillment_type: string;
  work_status: string;
  sites_total: number;
  completion_pct: number | null;
}

export function exportClientCampaignReport(rows: ClientCampaignExportRow[], fileName: string = 'campaign-performance-report') {
  const wb = XLSX.utils.book_new();

  const data = rows.map((r) => ({
    'Campaign': r.campaign_name,
    'PO Number': r.po_number,
    'PO Date': r.po_date ? new Date(r.po_date).toLocaleDateString('en-IN') : '',
    'Agency': r.agency_name,
    'Fulfillment Type': r.fulfillment_type === 'supply_only' ? 'Supply Only' : 'Survey + Install',
    'Status': r.work_status,
    'Sites (Total)': r.sites_total,
    'Work Done %': r.completion_pct != null ? Math.round(r.completion_pct) : '',
  }));

  const ws = XLSX.utils.json_to_sheet(data.length > 0 ? data : [{ 'PO Number': 'No data' }]);
  XLSX.utils.book_append_sheet(wb, ws, 'Campaign Performance');

  XLSX.writeFile(wb, `${fileName}.xlsx`);
}

export interface ClientPhotoComplianceRow {
  shop_name: string;
  city: string | null;
  po_number: string;
  status: string;
  survey_photo_count: number;
  installation_photo_count: number;
  compliant: boolean;
  reason: string;
}

export function exportClientPhotoComplianceReport(rows: ClientPhotoComplianceRow[], fileName: string = 'photo-compliance-report') {
  const wb = XLSX.utils.book_new();

  const data = rows.map((r) => ({
    'Site': r.shop_name,
    'City': r.city || '',
    'PO Number': r.po_number,
    'Status': r.status,
    'Survey Photos': r.survey_photo_count,
    'Installation Photos': r.installation_photo_count,
    'Compliant': r.compliant ? 'Yes' : 'No',
    'Note': r.reason,
  }));

  const ws = XLSX.utils.json_to_sheet(data.length > 0 ? data : [{ 'Site': 'No data' }]);
  XLSX.utils.book_append_sheet(wb, ws, 'Photo Compliance');

  XLSX.writeFile(wb, `${fileName}.xlsx`);
}

// Corporate-style detail report — "who was given what, when, how much is
// done, where, and what it actually looks like". Unlike
// exportClientPhotoComplianceReport above (which is deliberately compact
// — just counts, for a quick compliance scan), this is the full record:
// one Sites sheet (scope, work assigned, status, dates) plus one row per
// photo (not a count) with a real clickable link, exactly the shape a
// corporate stakeholder report uses — never a rate/₹ figure anywhere,
// same as every other client-portal export in this file.
export interface ClientSiteDetailRow {
  shop_name: string;
  city: string | null;
  district: string | null;
  address: string | null;
  campaign_name: string;
  po_label: string;
  agency_name: string;
  status_label: string;
  work_types: string;
  total_area_sqft: number | null;
  total_qty: number | null;
  assigned_on: string;
  survey_photo_count: number;
  installation_photo_count: number;
}
export interface ClientSitePhotoRow {
  shop_name: string;
  city: string | null;
  po_label: string;
  photo_type: string;
  uploaded_on: string;
  photo_url: string;
}

export function exportClientSiteDetailReport(
  sites: ClientSiteDetailRow[],
  surveyPhotos: ClientSitePhotoRow[],
  installPhotos: ClientSitePhotoRow[],
  fileName: string = 'site-detail-report'
) {
  const wb = XLSX.utils.book_new();

  const siteData = sites.map((r) => ({
    'Site': r.shop_name,
    'City': r.city || '',
    'District': r.district || '',
    'Address': r.address || '',
    'Campaign': r.campaign_name,
    'Work Order': r.po_label,
    'Agency': r.agency_name,
    'Status': r.status_label,
    'Work Type(s)': r.work_types,
    'Total Area (sq ft)': r.total_area_sqft ?? '',
    'Total Qty (pieces)': r.total_qty ?? '',
    'Assigned On': r.assigned_on,
    'Survey Photos': r.survey_photo_count,
    'Installation Photos': r.installation_photo_count,
  }));
  const sitesWs = XLSX.utils.json_to_sheet(siteData.length > 0 ? siteData : [{ 'Site': 'No data' }]);
  if (siteData.length > 0) sitesWs['!cols'] = Object.keys(siteData[0]).map((h) => ({ wch: Math.min(Math.max(h.length + 2, 12), 34) }));
  XLSX.utils.book_append_sheet(wb, sitesWs, 'Sites');

  function appendPhotoSheet(name: string, rows: ClientSitePhotoRow[]) {
    const data = rows.map((r) => ({
      'Site': r.shop_name, 'City': r.city || '', 'Work Order': r.po_label,
      'Photo Type': r.photo_type, 'Uploaded On': r.uploaded_on, 'Photo Link': r.photo_url,
    }));
    const ws = XLSX.utils.json_to_sheet(data.length > 0 ? data : [{ 'Site': 'No data' }]);
    if (data.length > 0) {
      ws['!cols'] = [{ wch: 22 }, { wch: 14 }, { wch: 20 }, { wch: 14 }, { wch: 18 }, { wch: 46 }];
      const linkCol = 5; // 'Photo Link' is the 6th column (index 5)
      rows.forEach((r, i) => {
        const cellRef = `${XLSX.utils.encode_col(linkCol)}${i + 2}`;
        if (r.photo_url && ws[cellRef]) ws[cellRef].l = { Target: r.photo_url };
      });
    }
    XLSX.utils.book_append_sheet(wb, ws, name);
  }
  appendPhotoSheet('Survey Photos', surveyPhotos);
  appendPhotoSheet('Installation Photos', installPhotos);

  XLSX.writeFile(wb, `${fileName}.xlsx`);
}

// ---------------------------------------------------------------------------
// PowerPoint exports (already single-deck for any number of shops)
// ---------------------------------------------------------------------------

export async function generatePreApprovalPPT(
  shops: Shop[],
  workItems: WorkItem[],
  surveyPhotos: SurveyPhoto[],
  org: Organization | null | undefined,
  markings: BoardMarking[] = [],
  fileName: string = 'pre-approval-proposal'
) {
  const pptx = new pptxgen();
  pptx.defineLayout({ name: 'LAYOUT_WIDE', width: 13.33, height: 7.5 });
  pptx.layout = 'LAYOUT_WIDE';

  // Title slide
  const titleSlide = pptx.addSlide();
  titleSlide.background = { color: '1E40AF' };
  titleSlide.addText(org?.name || 'Darshan Ad Agency', {
    x: 0.5, y: 2.5, w: 12, h: 1, fontSize: 36, color: 'FFFFFF', bold: true, align: 'center',
  });
  titleSlide.addText('Pre-Approval Proposal', {
    x: 0.5, y: 3.5, w: 12, h: 0.8, fontSize: 24, color: 'BFDBFE', align: 'center',
  });
  titleSlide.addText(`Generated: ${new Date().toLocaleDateString('en-IN')} — ${shops.length} shop${shops.length === 1 ? '' : 's'}`, {
    x: 0.5, y: 4.5, w: 12, h: 0.5, fontSize: 14, color: '93C5FD', align: 'center',
  });

  // One slide per shop
  for (const shop of shops) {
    const items = workItems.filter(w => w.shop_id === shop.id);
    const photos = surveyPhotos.filter(p => p.shop_id === shop.id);
    if (items.length === 0) continue;

    const slide = pptx.addSlide();
    slide.background = { color: 'F8FAFC' };

    slide.addText(shop.name, {
      x: 0.5, y: 0.3, w: 12, h: 0.6, fontSize: 24, color: '1E3A8A', bold: true,
    });
    slide.addText(`${shop.city || 'N/A'}, ${shop.state || 'N/A'}`, {
      x: 0.5, y: 0.9, w: 12, h: 0.4, fontSize: 14, color: '64748B',
    });

    // Marked board photo(s) (left half of the slide) — the actual selling
    // point of a pre-approval deck is showing the client exactly what will
    // go where, so this needs to be the real marked photo, not a count.
    // If several boards were marked on the same shop-front shot, the first
    // group already contains every one of those polygons burned into a
    // single image (see buildBoardImageGroups) — matching how the survey
    // was actually marked, whether that was one board, several boards on
    // one photo, or several separate photos.
    const shopGroups = await buildBoardImageGroups(items, photos, markings);
    if (shopGroups.length > 0) {
      try { slide.addImage({ data: shopGroups[0].dataUrl, x: 0.5, y: 1.5, w: 5.8, h: 4.8, sizing: { type: 'contain', w: 5.8, h: 4.8 } }); } catch { /* skip if unreadable */ }
    }

    // Work items table (right half)
    const tableRows = items.map((item, i) => [
      { text: `${i + 1}` },
      { text: item.work_type_name || 'N/A' },
      { text: item.material || 'N/A' },
      { text: `${item.survey_width || 0} x ${item.survey_height || 0} ${item.survey_unit || 'ft'}` },
      { text: `${item.survey_quantity || 1}` },
      { text: `${item.survey_area || 0} sq ft` },
    ]);

    slide.addTable(
      [
        [{ text: '#' }, { text: 'Work Type' }, { text: 'Material' }, { text: 'Dimensions' }, { text: 'Qty' }, { text: 'Area' }],
        ...tableRows,
      ],
      {
        x: 6.6, y: 1.5, w: 6.2, colW: [0.4, 1.6, 1.2, 1.6, 0.6, 0.8],
        border: { type: 'solid', color: 'CBD5E1' },
        fontSize: 10,
        color: '1E293B',
        valign: 'middle',
      }
    );

    // Footer
    slide.addText(org?.name || '', {
      x: 10, y: 7, w: 3, h: 0.3, fontSize: 8, color: '94A3B8', align: 'right',
    });

    // A shop can have boards marked across several separate photos, not
    // just several boards on one photo — one slide only has room for one
    // image, so any additional marked photo for this shop gets its own
    // follow-on slide instead of silently being dropped from the export.
    for (let gi = 1; gi < shopGroups.length; gi++) {
      const contSlide = pptx.addSlide();
      contSlide.background = { color: 'F8FAFC' };
      contSlide.addText(`${shop.name} — Additional Marked Photo`, {
        x: 0.5, y: 0.3, w: 12, h: 0.6, fontSize: 20, color: '1E3A8A', bold: true,
      });
      const names = shopGroups[gi].items.map((it) => it.work_type_name || 'N/A').join(' + ');
      contSlide.addText(names, {
        x: 0.5, y: 0.95, w: 12, h: 0.4, fontSize: 14, color: '64748B',
      });
      try {
        contSlide.addImage({ data: shopGroups[gi].dataUrl, x: 1.5, y: 1.5, w: 10.3, h: 5.6, sizing: { type: 'contain', w: 10.3, h: 5.6 } });
      } catch { /* skip if unreadable */ }
    }
  }

  await pptx.writeFile({ fileName: `${fileName}.pptx` });
}

export async function generateFinalInstallationPPT(
  shops: Shop[],
  workItems: WorkItem[],
  proofs: InstallationProof[],
  org: Organization | null | undefined,
  fileName: string = 'final-installation-report'
) {
  const pptx = new pptxgen();
  pptx.defineLayout({ name: 'LAYOUT_WIDE', width: 13.33, height: 7.5 });
  pptx.layout = 'LAYOUT_WIDE';

  // Title slide
  const titleSlide = pptx.addSlide();
  titleSlide.background = { color: '059669' };
  titleSlide.addText(org?.name || 'Darshan Ad Agency', {
    x: 0.5, y: 2.5, w: 12, h: 1, fontSize: 36, color: 'FFFFFF', bold: true, align: 'center',
  });
  titleSlide.addText('Final Installation Report', {
    x: 0.5, y: 3.5, w: 12, h: 0.8, fontSize: 24, color: 'A7F3D0', align: 'center',
  });
  titleSlide.addText(`Generated: ${new Date().toLocaleDateString('en-IN')} — ${shops.length} shop${shops.length === 1 ? '' : 's'}`, {
    x: 0.5, y: 4.5, w: 12, h: 0.5, fontSize: 14, color: '6EE7B7', align: 'center',
  });

  for (const shop of shops) {
    const items = workItems.filter(w => w.shop_id === shop.id && w.installed_width);
    const shopProofs = proofs.filter(p => p.shop_id === shop.id);
    if (items.length === 0 && shopProofs.length === 0) continue;

    const slide = pptx.addSlide();
    slide.background = { color: 'F0FDF4' };

    slide.addText(shop.name, {
      x: 0.5, y: 0.3, w: 12, h: 0.6, fontSize: 24, color: '064E3B', bold: true,
    });
    slide.addText(`${shop.city || 'N/A'}, ${shop.state || 'N/A'}`, {
      x: 0.5, y: 0.9, w: 12, h: 0.4, fontSize: 14, color: '64748B',
    });

    // Prefer the "installed" photo, falling back to "after" then "before"
    // — this is the final proof-of-work photo the client actually cares about.
    const bestProof = shopProofs.find(p => p.photo_type === 'installed')
      || shopProofs.find(p => p.photo_type === 'after')
      || shopProofs[0];
    if (bestProof?.photo_url) {
      try {
        const dataUrl = await toJpegDataUrl(bestProof.photo_url);
        slide.addImage({ data: dataUrl, x: 0.5, y: 1.5, w: 5.8, h: 4.8, sizing: { type: 'contain', w: 5.8, h: 4.8 } });
      } catch { /* skip if unreadable */ }
    }

    if (items.length > 0) {
      const tableRows = items.map((item, i) => [
        { text: `${i + 1}` },
        { text: item.work_type_name || 'N/A' },
        { text: `${item.installed_width || 0} x ${item.installed_height || 0} ${item.installed_unit || 'ft'}` },
        { text: `${item.installed_quantity || 1}` },
        { text: `${item.installed_area || 0} sq ft` },
      ]);

      slide.addTable(
        [
          [{ text: '#' }, { text: 'Work Type' }, { text: 'Installed Dimensions' }, { text: 'Qty' }, { text: 'Area' }],
          ...tableRows,
        ],
        {
          x: 6.6, y: 1.5, w: 6.2, colW: [0.4, 1.8, 2.2, 0.8, 1],
          border: { type: 'solid', color: 'BBF7D0' },
          fontSize: 10,
          color: '1E293B',
          valign: 'middle',
        }
      );
    }

    if (shopProofs.length > 0) {
      slide.addText(`Proof Photos: ${shopProofs.length} (${shopProofs.map(p => p.photo_type).join(', ')})`, {
        x: 0.5, y: 6.5, w: 8, h: 0.4, fontSize: 12, color: '059669',
      });
    }

    slide.addText(org?.name || '', {
      x: 10, y: 7, w: 3, h: 0.3, fontSize: 8, color: '94A3B8', align: 'right',
    });
  }

  await pptx.writeFile({ fileName: `${fileName}.pptx` });
}

// ---------------------------------------------------------------------------
// Design vs. Survey comparison report — one shop, showing exactly which
// uploaded design corresponds to which surveyed/marked board, side by
// side, with the same "Marking #N of M" numbering used on the Design
// Studio screen so a reviewer can cross-reference the two without any
// guesswork — even when several boards were marked on one shared photo.
// ---------------------------------------------------------------------------

export type DesignComparisonRow = {
  workItem: WorkItem;
  markingNumber: number | null;
  markingTotal: number | null;
  photo: SurveyPhoto | null;
  markedPhotoDataUrl: string | null;
  designVersions: DesignVersion[]; // every uploaded file that covers this board, latest first
};

/**
 * Builds one row per work item (board): its survey marking (numbered +
 * rendered with the polygon burned in, same as the survey exports), and
 * every design file that has been tagged as covering it via
 * design_version_items. This is the single data-prep step shared by both
 * the PDF and PPT design-comparison exports below, so the two formats can
 * never disagree about which design goes with which marking.
 */
export async function buildDesignComparisonRows(
  workItems: WorkItem[],
  surveyPhotos: SurveyPhoto[],
  markings: BoardMarking[],
  designVersions: DesignVersion[],
  designVersionItems: DesignVersionItem[]
): Promise<DesignComparisonRow[]> {
  const numbering = numberMarkingsByPhoto(markings);
  const versionsByItem = new Map<string, DesignVersion[]>();
  for (const link of designVersionItems) {
    const v = designVersions.find((dv) => dv.id === link.design_version_id);
    if (!v) continue;
    const list = versionsByItem.get(link.work_item_id) || [];
    list.push(v);
    versionsByItem.set(link.work_item_id, list);
  }
  for (const list of versionsByItem.values()) list.sort((a, b) => b.version_number - a.version_number);

  // Every valid marking on a given photo, sorted the same stable way
  // numberMarkingsByPhoto uses — needed so a photo with several boards
  // marked on it can render ALL of them (this board highlighted, the
  // rest dimmed) instead of only ever showing the one board in
  // isolation, per Architecture v2.0 §9.5-B ("or all of them, dimmed
  // except the active one").
  const markingsByPhoto = new Map<string, BoardMarking[]>();
  for (const m of markings) {
    if (!m.work_item_id || !m.points || m.points.length < 3) continue;
    const list = markingsByPhoto.get(m.survey_photo_id) || [];
    list.push(m);
    markingsByPhoto.set(m.survey_photo_id, list);
  }
  for (const list of markingsByPhoto.values()) list.sort((a, b) => (a.created_at || '').localeCompare(b.created_at || ''));

  const renderedByPhoto = new Map<string, string>();
  const rows: DesignComparisonRow[] = [];

  for (const item of workItems) {
    const marking = markings.find((m) => m.work_item_id === item.id && m.points?.length >= 3);
    const num = numbering.get(item.id);
    const photo = marking ? surveyPhotos.find((p) => p.id === marking.survey_photo_id) || null : null;

    let markedPhotoDataUrl: string | null = null;
    if (marking && photo?.photo_url) {
      const cacheKey = `${photo.id}:${item.id}`;
      if (!renderedByPhoto.has(cacheKey)) {
        try {
          const label = buildBoardLabel({
            workTypeName: item.work_type_name,
            width: item.approved_width ?? item.survey_width,
            height: item.approved_height ?? item.survey_height,
            unit: item.approved_unit ?? item.survey_unit,
          });
          const photoMarkings = markingsByPhoto.get(photo.id) || [marking];
          const activeIndex = photoMarkings.findIndex((m) => m.work_item_id === item.id);
          const { dataUrl } = await renderMarkedImage(
            photo.photo_url,
            photoMarkings.map((m) => m.points),
            {
              labels: photoMarkings.map((_, i) => (i === activeIndex ? (num ? `#${num.number} — ${label || ''}`.trim() : label) : null)),
              activeIndex: activeIndex >= 0 ? activeIndex : undefined,
            }
          );
          renderedByPhoto.set(cacheKey, dataUrl);
        } catch {
          renderedByPhoto.set(cacheKey, '');
        }
      }
      markedPhotoDataUrl = renderedByPhoto.get(cacheKey) || null;
    }

    rows.push({
      workItem: item,
      markingNumber: num?.number ?? null,
      markingTotal: num?.total ?? null,
      photo,
      markedPhotoDataUrl,
      designVersions: versionsByItem.get(item.id) || [],
    });
  }

  return rows;
}

/**
 * Draws one board's survey-vs-design comparison — label, marking
 * reference, and the two boxed photos side by side — inside a bounded
 * area starting at (x, y) with the given width/height. Pulled out as its
 * own function so the PDF export can place two of these per page (one
 * above the other) instead of burning a whole page on a single board,
 * which is what made even a small shop's report run to a dozen
 * mostly-empty pages.
 */
async function drawBoardComparisonBlock(
  doc: jsPDF,
  row: DesignComparisonRow,
  x: number,
  y: number,
  width: number,
  maxHeight: number
): Promise<void> {
  const gutter = 10;
  const colW = (width - gutter) / 2;

  const label = buildBoardLabel({
    workTypeName: row.workItem.work_type_name,
    width: row.workItem.approved_width ?? row.workItem.survey_width,
    height: row.workItem.approved_height ?? row.workItem.survey_height,
    unit: row.workItem.approved_unit ?? row.workItem.survey_unit,
  });
  doc.setFontSize(11);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(15, 23, 42);
  doc.text(label || row.workItem.work_type_name || 'Board', x, y, { maxWidth: width });

  let headerH = 6;
  if (row.markingNumber) {
    doc.setFontSize(8.5);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(100, 116, 139);
    doc.text(`Marking #${row.markingNumber} of ${row.markingTotal} on this survey photo`, x, y + 5.5);
    doc.setTextColor(0, 0, 0);
    headerH = 10;
  }

  const capY = y + headerH + 4;
  doc.setFontSize(8.5);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(71, 85, 105);
  doc.text('SURVEYED & MARKED', x, capY);
  doc.text('UPLOADED DESIGN', x + colW + gutter, capY);
  doc.setTextColor(0, 0, 0);

  const boxTop = capY + 3;
  const metaReserve = 10;
  const boxH = Math.max(45, maxHeight - (boxTop - y) - metaReserve);

  await addBoxedImage(doc, row.markedPhotoDataUrl, x, boxTop, colW, boxH, 'No survey marking on record for this board.');

  const latest = row.designVersions[0] || null;
  let designImageUrl: string | null = null;
  let designIsNonImage: string | null = null;
  if (latest) {
    if (latest.file_url && /\.(png|jpe?g|webp|gif)$/i.test(latest.file_name || latest.storage_path || '')) {
      try {
        designImageUrl = await toJpegDataUrl(latest.file_url);
      } catch {
        designIsNonImage = '(Design preview unavailable)';
      }
    } else {
      designIsNonImage = `${latest.file_name || 'Design file'} (PDF — see attachment)`;
    }
  }
  await addBoxedImage(
    doc,
    designImageUrl,
    x + colW + gutter,
    boxTop,
    colW,
    boxH,
    designIsNonImage || 'No design uploaded yet for this board.'
  );

  const metaY = boxTop + boxH + 6;
  if (latest) {
    doc.setFontSize(7.5);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(71, 85, 105);
    const versionLine = `v${latest.version_number} · ${latest.source === 'client_provided' ? 'Client-provided' : 'Agency-designed'} · ${formatDate(latest.created_at)}` +
      (row.designVersions.length > 1 ? ` · +${row.designVersions.length - 1} earlier version(s)` : '');
    doc.text(versionLine, x + colW + gutter, metaY, { maxWidth: colW });
    doc.setTextColor(0, 0, 0);
  }
}

/**
 * Draws every board-comparison page for one shop onto an already-open PDF
 * document. Shared by both the single-shop export and the combined
 * multi-shop export below, so "one shop's pages" always look identical
 * whether it's the only shop in the file or shop #7 of 12.
 *
 * `startFreshPage` controls whether a new page is started before this
 * shop's first board-pair — false only for the very first content drawn
 * on the document (page 1 always exists already), true everywhere else
 * (including the first shop right after a cover page).
 */
async function drawShopDesignComparisonPages(
  doc: jsPDF,
  shop: Shop,
  rows: DesignComparisonRow[],
  org: Organization | null | undefined,
  startFreshPage: boolean,
  includeOrgHeader: boolean
): Promise<boolean> {
  if (rows.length === 0) return startFreshPage;
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const bottomMargin = 14;
  const BOARDS_PER_PAGE = 2;
  const rowGap = 10;

  for (let i = 0; i < rows.length; i += BOARDS_PER_PAGE) {
    if (startFreshPage) doc.addPage();
    startFreshPage = true;

    const y = drawSectionHeader(doc, `${shop.name} — Survey vs. Design`, org, includeOrgHeader, [15, 23, 42]);
    const pageRows = rows.slice(i, i + BOARDS_PER_PAGE);
    const available = pageHeight - y - bottomMargin;
    // Slot height is always based on a full 2-board page, even when the
    // last page only has one board left — so a lone trailing board keeps
    // the same proportions as every other board in the report instead of
    // stretching to fill a whole page by itself.
    const slotH = (available - rowGap) / BOARDS_PER_PAGE;

    for (let j = 0; j < pageRows.length; j++) {
      const slotY = y + j * (slotH + rowGap);
      await drawBoardComparisonBlock(doc, pageRows[j], 14, slotY, pageWidth - 28, slotH);
      if (j < pageRows.length - 1) {
        doc.setDrawColor(226, 232, 240);
        doc.line(14, slotY + slotH + rowGap / 2, pageWidth - 14, slotY + slotH + rowGap / 2);
      }
    }
  }
  return startFreshPage;
}

/**
 * PDF version of the design-comparison report for ONE shop: two boards per
 * page (stacked, each with its own marked survey photo next to its latest
 * uploaded design), so a shop owner or client can see exactly what was
 * surveyed vs. what was designed for it, board by board, without paging
 * through one near-empty sheet per board.
 */
export async function generateDesignComparisonPDF(
  shop: Shop,
  rows: DesignComparisonRow[],
  org: Organization | null | undefined,
  fileName: string = 'design-comparison-report'
) {
  const doc = new jsPDF();
  await drawShopDesignComparisonPages(doc, shop, rows, org, false, true);
  addDocumentFooters(doc);
  doc.save(`${slug(shop.name)}-${fileName}.pdf`);
}

/**
 * PDF version of the design-comparison report for MULTIPLE shops, all
 * combined into a single file — a cover page listing every shop included,
 * then each shop's own board-by-board pages (still two boards per page)
 * one after another. This is what "one combined PDF for all/selected
 * shops" produces, as opposed to generateDesignComparisonPDF's one-file-
 * per-shop output.
 */
export async function generateDesignComparisonPDFMulti(
  entries: { shop: Shop; rows: DesignComparisonRow[] }[],
  org: Organization | null | undefined,
  fileName: string = 'design-approval-report'
) {
  const usable = entries.filter((e) => e.rows.length > 0);
  if (usable.length === 0) return;

  const doc = new jsPDF();
  const singleShop = usable.length === 1;
  let startFreshPage = false;

  if (!singleShop) {
    drawCoverPage(doc, org, 'Design Approval Report', usable.map((e) => e.shop));
    startFreshPage = true;
  }

  for (const entry of usable) {
    startFreshPage = await drawShopDesignComparisonPages(doc, entry.shop, entry.rows, org, startFreshPage, singleShop);
  }

  addDocumentFooters(doc);
  doc.save(`${fileName}.pdf`);
}

/** Adds one slide per board (survey photo vs. design, side by side) for one shop onto an already-open deck. */
async function addDesignComparisonSlides(
  pptx: pptxgen,
  shop: Shop,
  rows: DesignComparisonRow[],
  org: Organization | null | undefined,
  showShopKicker: boolean
) {
  for (const row of rows) {
    const slide = pptx.addSlide();
    slide.background = { color: 'F8FAFC' };

    const label = buildBoardLabel({
      workTypeName: row.workItem.work_type_name,
      width: row.workItem.approved_width ?? row.workItem.survey_width,
      height: row.workItem.approved_height ?? row.workItem.survey_height,
      unit: row.workItem.approved_unit ?? row.workItem.survey_unit,
    });

    if (showShopKicker) {
      slide.addText(shop.name.toUpperCase(), { x: 0.5, y: 0.08, w: 12, h: 0.3, fontSize: 10, color: '4338CA', bold: true, charSpacing: 1 });
    }
    slide.addText(label || row.workItem.work_type_name || 'Board', {
      x: 0.5, y: showShopKicker ? 0.38 : 0.25, w: 12, h: 0.5, fontSize: 20, color: '312E81', bold: true,
    });
    slide.addText(
      row.markingNumber ? `Marking #${row.markingNumber} of ${row.markingTotal} on this survey photo` : 'No survey marking on record',
      { x: 0.5, y: showShopKicker ? 0.88 : 0.75, w: 12, h: 0.35, fontSize: 12, color: '64748B' }
    );

    slide.addText('SURVEYED & MARKED', { x: 0.5, y: 1.25, w: 5.8, h: 0.3, fontSize: 10, color: '4338CA', bold: true });
    slide.addText('UPLOADED DESIGN', { x: 6.9, y: 1.25, w: 5.8, h: 0.3, fontSize: 10, color: '4338CA', bold: true });

    // Both columns use the exact same box (x width, y top, height) so the
    // two photos always occupy identical footprints on the slide — before
    // this the survey box was 5.0" tall and the design box 4.6", so the
    // same-size boards visibly didn't line up next to each other. A light
    // frame is drawn behind both boxes even when a photo is missing, so a
    // "no design yet" board still reads as a clean placeholder rather than
    // empty space of a different size than its neighbor.
    const boxY = 1.65;
    const boxH = 4.75;
    const boxW = 5.8;
    slide.addShape('rect', { x: 0.5, y: boxY, w: boxW, h: boxH, fill: { color: 'F8FAFC' }, line: { color: 'E2E8F0', width: 1 } });
    slide.addShape('rect', { x: 6.9, y: boxY, w: boxW, h: boxH, fill: { color: 'F8FAFC' }, line: { color: 'E2E8F0', width: 1 } });

    if (row.markedPhotoDataUrl) {
      try { slide.addImage({ data: row.markedPhotoDataUrl, x: 0.5, y: boxY, w: boxW, h: boxH, sizing: { type: 'contain', w: boxW, h: boxH } }); } catch { /* skip */ }
    } else {
      slide.addText('No marking on record for this board.', { x: 0.5, y: boxY, w: boxW, h: boxH, fontSize: 11, italic: true, color: '94A3B8', align: 'center', valign: 'middle' });
    }

    if (row.designVersions.length > 0) {
      const latest = row.designVersions[0];
      const isImage = /\.(png|jpe?g|webp|gif)$/i.test(latest.file_name || latest.storage_path || '');
      if (isImage && latest.file_url) {
        try {
          const dataUrl = await toJpegDataUrl(latest.file_url);
          slide.addImage({ data: dataUrl, x: 6.9, y: boxY, w: boxW, h: boxH, sizing: { type: 'contain', w: boxW, h: boxH } });
        } catch {
          slide.addText('(Design preview unavailable)', { x: 6.9, y: boxY, w: boxW, h: boxH, fontSize: 11, italic: true, color: '94A3B8', align: 'center', valign: 'middle' });
        }
      } else {
        slide.addText(`${latest.file_name || 'Design file'} (non-image file — open separately)`, {
          x: 6.9, y: boxY, w: boxW, h: boxH, fontSize: 11, italic: true, color: '94A3B8', align: 'center', valign: 'middle',
        });
      }
      const versionNote = `v${latest.version_number} · ${latest.source === 'client_provided' ? 'Client-provided' : 'Agency-designed'} · ${new Date(latest.created_at).toLocaleDateString('en-IN')}${row.designVersions.length > 1 ? ` · +${row.designVersions.length - 1} earlier version(s)` : ''}`;
      slide.addText(versionNote, { x: 6.9, y: boxY + boxH + 0.08, w: boxW, h: 0.35, fontSize: 10, color: '64748B' });
    } else {
      slide.addText('No design uploaded yet for this board.', { x: 6.9, y: boxY, w: boxW, h: boxH, fontSize: 11, italic: true, color: '94A3B8', align: 'center', valign: 'middle' });
    }

    slide.addText(org?.name || '', { x: 10, y: 7.1, w: 2.8, h: 0.3, fontSize: 8, color: '94A3B8', align: 'right' });
  }
}

/** PPT version of the same design-vs-survey comparison for ONE shop — one slide per board. */
export async function generateDesignComparisonPPT(
  shop: Shop,
  rows: DesignComparisonRow[],
  org: Organization | null | undefined,
  fileName: string = 'design-comparison-report'
) {
  const pptx = new pptxgen();
  pptx.defineLayout({ name: 'LAYOUT_WIDE', width: 13.33, height: 7.5 });
  pptx.layout = 'LAYOUT_WIDE';

  const titleSlide = pptx.addSlide();
  titleSlide.background = { color: '312E81' };
  titleSlide.addText(org?.name || 'Design Studio', {
    x: 0.5, y: 2.5, w: 12, h: 1, fontSize: 32, color: 'FFFFFF', bold: true, align: 'center',
  });
  titleSlide.addText(`${shop.name} — Survey vs. Design`, {
    x: 0.5, y: 3.4, w: 12, h: 0.7, fontSize: 20, color: 'C7D2FE', align: 'center',
  });
  titleSlide.addText(`${rows.length} board(s) · Generated ${new Date().toLocaleDateString('en-IN')}`, {
    x: 0.5, y: 4.2, w: 12, h: 0.5, fontSize: 12, color: 'A5B4FC', align: 'center',
  });

  await addDesignComparisonSlides(pptx, shop, rows, org, false);

  await pptx.writeFile({ fileName: `${slug(shop.name)}-${fileName}.pptx` });
}

/**
 * PPT version of the design-comparison report for MULTIPLE shops, all
 * combined into a single deck — one title slide, then every shop's board
 * slides back to back (each carrying a small shop-name kicker so it's
 * always clear whose board is on screen when scrolling through a deck
 * that spans several shops).
 */
export async function generateDesignComparisonPPTMulti(
  entries: { shop: Shop; rows: DesignComparisonRow[] }[],
  org: Organization | null | undefined,
  fileName: string = 'design-approval-report'
) {
  const usable = entries.filter((e) => e.rows.length > 0);
  if (usable.length === 0) return;

  const pptx = new pptxgen();
  pptx.defineLayout({ name: 'LAYOUT_WIDE', width: 13.33, height: 7.5 });
  pptx.layout = 'LAYOUT_WIDE';

  const totalBoards = usable.reduce((sum, e) => sum + e.rows.length, 0);
  const titleSlide = pptx.addSlide();
  titleSlide.background = { color: '312E81' };
  titleSlide.addText(org?.name || 'Design Studio', {
    x: 0.5, y: 2.3, w: 12, h: 1, fontSize: 32, color: 'FFFFFF', bold: true, align: 'center',
  });
  titleSlide.addText('Design Approval — Survey vs. Design', {
    x: 0.5, y: 3.2, w: 12, h: 0.7, fontSize: 20, color: 'C7D2FE', align: 'center',
  });
  titleSlide.addText(
    `${usable.length} shop(s) · ${totalBoards} board(s) · Generated ${new Date().toLocaleDateString('en-IN')}`,
    { x: 0.5, y: 4.0, w: 12, h: 0.5, fontSize: 12, color: 'A5B4FC', align: 'center' }
  );

  const singleShop = usable.length === 1;
  for (const entry of usable) {
    await addDesignComparisonSlides(pptx, entry.shop, entry.rows, org, !singleShop);
  }

  await pptx.writeFile({ fileName: `${fileName}.pptx` });
}
