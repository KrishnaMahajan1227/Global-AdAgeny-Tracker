import { supabase } from './supabase';
import { loadImage } from './markingUtils';

export type CompanyApprovalStage = 'survey' | 'design' | 'installation';
export type CompanyApprovalStatus = {
  required: boolean;
  status: 'not_reviewed' | 'internal_checked' | 'company_approved' | 'evidence_changed' | 'legacy_optional';
  valid: boolean;
  revision?: number;
  company_approved_at?: string | null;
  reference?: string | null;
};

export async function getCompanyApprovalStatus(stage: CompanyApprovalStage, refId: string): Promise<CompanyApprovalStatus> {
  const { data, error } = await supabase.rpc('phase2_handoff_status', { p_stage: stage, p_ref: refId });
  if (error) throw new Error(error.message);
  return data as CompanyApprovalStatus;
}

export async function saveCompanyApprovalAction(stage: CompanyApprovalStage, refId: string, action: 'internal_checked' | 'company_approved', reference?: string): Promise<CompanyApprovalStatus> {
  const { data, error } = await supabase.rpc('phase2_handoff_action', { p_stage: stage, p_ref: refId, p_action: action, p_reference: reference?.trim() || null });
  if (error) throw new Error(error.message);
  return data as CompanyApprovalStatus;
}

type ReportPhoto = { url: string; caption: string };
type PreparedPhoto = { data: string; caption: string; width: number; height: number };
async function preparePhoto(url:string):Promise<{data:string;width:number;height:number}> {
  const img=await loadImage(url);
  const factor=Math.min(1,1500/Math.max(img.naturalWidth,img.naturalHeight));
  const canvas=document.createElement('canvas');
  canvas.width=Math.max(1,Math.round(img.naturalWidth*factor));canvas.height=Math.max(1,Math.round(img.naturalHeight*factor));
  const context=canvas.getContext('2d');if(!context)throw new Error('Cannot convert evidence image');
  context.fillStyle='#fff';context.fillRect(0,0,canvas.width,canvas.height);context.drawImage(img,0,0,canvas.width,canvas.height);
  return {data:canvas.toDataURL('image/jpeg',0.82),width:canvas.width,height:canvas.height};
}
type ReportData = { title: string; agency: string; client: string; order: string; site: string; city: string; evidence: ReportPhoto[]; items: string[] };
const safeFileName = (value: string) => value.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
const line = (value: unknown) => String(value ?? '').trim() || '—';

/** Uses existing stage evidence, without fabricating site/item counts or approval statuses. */
async function loadReportData(stage: CompanyApprovalStage, refId: string, shopId: string): Promise<ReportData> {
  const { data: shop, error: shopError } = await supabase.from('shops')
    .select('id,name,city,organization_id,clients(name),purchase_orders(name,po_number)')
    .eq('id',shopId).single();
  if (shopError) throw new Error(shopError.message);
  const s: any = shop;
  const { data: agency } = await supabase.from('organizations').select('name').eq('id',s.organization_id).maybeSingle();
  const evidence: ReportPhoto[] = [];
  if (stage === 'survey') {
    const { data, error } = await supabase.from('survey_photos').select('photo_url,caption,photo_type').eq('survey_id',refId).order('created_at');
    if (error) throw new Error(error.message);
    for (const p of data || []) if (p.photo_url) evidence.push({ url:p.photo_url, caption: p.caption || p.photo_type || 'Survey evidence' });
  } else if (stage === 'design') {
    const { data, error } = await supabase.from('design_versions').select('file_url,file_name,version_number').eq('design_task_id',refId).order('version_number',{ascending:false});
    if (error) throw new Error(error.message);
    for (const d of data || []) if (d.file_url) evidence.push({ url:d.file_url, caption: `${d.file_name || 'Artwork'} · v${d.version_number}` });
  } else {
    const { data, error } = await supabase.from('installation_proofs').select('photo_url,photo_type,caption').eq('installation_job_id',refId).order('captured_at');
    if (error) throw new Error(error.message);
    for (const p of data || []) if (p.photo_url) evidence.push({ url:p.photo_url, caption:p.caption || p.photo_type || 'Installation proof' });
  }
  const { data: items, error: itemError } = await supabase.from('work_items')
    .select('work_type_name,material,approved_width,approved_height,approved_quantity,installed_quantity,installed_area,survey_width,survey_height')
    .eq('shop_id',shopId).limit(60);
  if (itemError) throw new Error(itemError.message);
  const itemDescriptions = (items || []).map((x:any) => [x.work_type_name || 'Work item',x.material,
    x.approved_width && x.approved_height ? `${x.approved_width} × ${x.approved_height}` : x.survey_width && x.survey_height ? `${x.survey_width} × ${x.survey_height}` : null,
    x.installed_quantity != null ? `Installed qty ${x.installed_quantity}` : x.approved_quantity != null ? `Approved qty ${x.approved_quantity}` : null,
    x.installed_area != null ? `Installed area ${x.installed_area}` : null].filter(Boolean).join(' · '));
  return { agency:line(agency?.name), title: stage==='survey' ? 'Survey Approval' : stage==='design' ? 'Artwork Approval' : 'Installation Approval',
    client:line(s?.clients?.name),order:line(s?.purchase_orders?.name || s?.purchase_orders?.po_number),
    site:line(s?.name),city:line(s?.city),evidence,items:itemDescriptions };
}

async function reportImages(data: ReportData): Promise<PreparedPhoto[]> {
  const results: PreparedPhoto[] = [];
  // Bound report sizes to avoid very large PDF/PPT in browser memory.
  for (const photo of data.evidence.slice(0,24)) {
    // Existing reportImage utility handles authenticated/CORS images as other reporting code does.
    try { results.push({...await preparePhoto(photo.url),caption:photo.caption}); } catch { /* count verified below */ }
  }
  if (!results.length) throw new Error('Approval export needs at least one accessible evidence image. Check photo permissions / PDF artwork previews before sharing.');
  if (results.length !== data.evidence.length) throw new Error(`Only ${results.length}/${data.evidence.length} evidence files loaded. Export stopped to avoid an incomplete approval report. Check file access or reduce attachment count.`);
  return results;
}

/** Pre-filled approval pack; it explicitly says FOR APPROVAL, never claims company has signed. */
export async function exportCompanyApprovalPack(args: {stage:CompanyApprovalStage;refId:string;shopId:string;format:'pdf'|'ppt'}): Promise<void> {
  const info = await loadReportData(args.stage,args.refId,args.shopId);
  if (info.evidence.length>24) throw new Error('More than 24 evidence images. Use existing batch Reports for a complete site pack; this quick export never silently truncates evidence.');
  const images = await reportImages(info);
  const filename = safeFileName(`${info.title}-${info.site}`);
  if (args.format==='pdf') {
    const { jsPDF } = await import('jspdf');
    const doc = new jsPDF({orientation:'portrait',unit:'mm',format:'a4'});
    const pageW=210;
    doc.setFontSize(17); doc.text(info.title,12,18);
    doc.setFontSize(10); doc.setTextColor(65,75,90);
    doc.text(`FOR COMPANY APPROVAL · NOT YET APPROVED`,12,27);
    doc.text(`Prepared by: ${info.agency}`,12,33);
    doc.text(`Client: ${info.client}`,12,39);
    doc.text(`Work Order: ${info.order}`,12,45);
    doc.text(`Site: ${info.site} · ${info.city}`,12,51);
    doc.text(`Generated: ${new Date().toLocaleString('en-IN')}`,12,57);
    let y=68;
    for (const item of info.items.slice(0,18)) {
      const parts=doc.splitTextToSize(`- ${item}`,185) as string[];
      if (y+parts.length*5>270) {doc.addPage();y=18;}
      doc.text(parts,12,y); y+=parts.length*5+1;
    }
    for (const p of images) {
      doc.addPage();
      doc.setFontSize(11);doc.setTextColor(15,23,42);doc.text(doc.splitTextToSize(p.caption,185),12,18);
      const prop=doc.getImageProperties(p.data);
      const height=Math.min(238,(pageW-24)*prop.height/prop.width);
      const width=Math.min(pageW-24,height*prop.width/prop.height);
      doc.addImage(p.data,'JPEG',12,26,width,height);
      doc.setFontSize(9);doc.setTextColor(100,116,139);doc.text('FOR APPROVAL · Adroute evidence pack',12,282);
    }
    doc.save(`${filename}.pdf`);
  } else {
    const { default: PptxGenJS } = await import('pptxgenjs');
    const ppt = new PptxGenJS(); ppt.layout='LAYOUT_WIDE';ppt.author='Adroute Agency';ppt.subject=info.title;
    const cover=ppt.addSlide();cover.addText(info.title,{x:0.55,y:0.65,w:12.1,h:0.7,fontSize:30,bold:true,color:'0F172A'});
    cover.addText('FOR COMPANY APPROVAL · NOT YET APPROVED',{x:0.55,y:1.5,w:11.8,h:0.35,fontSize:13,color:'B45309'});
    cover.addText(`Prepared by: ${info.agency}\nClient: ${info.client}\nWork Order: ${info.order}\nSite: ${info.site} · ${info.city}\n${new Date().toLocaleString('en-IN')}`,{x:0.55,y:2.2,w:11.6,h:2,fontSize:16,color:'334155',breakLine:false});
    const list=info.items.slice(0,18);
    if (list.length) {const slide=ppt.addSlide();slide.addText('Work items / measurements',{x:0.55,y:0.45,w:11.8,h:0.65,fontSize:24,bold:true});slide.addText(list.map(v=>`• ${v}`).join('\n'),{x:0.65,y:1.35,w:11.5,h:5.6,fontSize:14,breakLine:false,color:'334155'});}
    for (const p of images) {const slide=ppt.addSlide();slide.addText(p.caption,{x:0.5,y:0.28,w:12.2,h:0.48,fontSize:17,bold:true,color:'0F172A'});const scale=Math.min(12.3/p.width,5.95/p.height);const w=p.width*scale,h=p.height*scale;slide.addImage({data:p.data,x:0.5+(12.3-w)/2,y:0.94+(5.95-h)/2,w,h});slide.addText('FOR APPROVAL · Adroute evidence pack',{x:0.5,y:7.01,w:12.2,h:0.22,fontSize:9,color:'64748B'});}
    await ppt.writeFile({fileName:`${filename}.pptx`});
  }
}
