import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, RotateCcw, Square, CheckSquare, Ban, Loader2 } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { reviewApply, refreshReviewViews, setAvailability, type ReviewEntity, type ReviewStage } from '@/lib/reviewApi';

type Props = {
  stage: ReviewStage; shopId: string;
  /** survey id (survey) / installation job id (installation) / design task id (design) */
  refId?: string; surveyId?: string; jobId?: string; taskId?: string;
  assignedTo?: string; readOnly?: boolean; variance?: Record<string, string>; onDone?: () => void;
};
type Row = {
  key: string; entity: ReviewEntity; title: string; subtitle?: string; image?: string;
  unavailable?: boolean; reason?: string | null; workItemId?: string;
};

export function ItemLevelReviewPanel(props: Props) {
  const { stage, shopId, readOnly = false, variance, onDone } = props;
  const refId = props.refId || (stage === 'survey' ? props.surveyId : stage === 'installation' ? props.jobId : props.taskId);
  const { profile } = useAuth();
  const qc = useQueryClient();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [designerId, setDesignerId] = useState('');

  const { data: items = [] } = useQuery({
    queryKey: ['item-review-items', shopId, stage, refId],
    queryFn: async () => {
      let q = supabase.from('work_items').select('*').eq('shop_id', shopId).order('created_at');
      if (stage === 'survey' && refId) q = q.eq('survey_id', refId);
      const { data, error } = await q; if (error) throw error; return (data || []) as any[];
    }, enabled: !!shopId && !!refId,
  });
  const { data: photos = [] } = useQuery({
    queryKey: ['item-review-photos', stage, refId],
    queryFn: async () => {
      if (stage === 'survey') { const { data, error } = await supabase.from('survey_photos').select('id,photo_url,caption').eq('survey_id', refId!).order('created_at'); if (error) throw error; return data || []; }
      if (stage === 'installation') { const { data, error } = await supabase.from('installation_proofs').select('id,photo_url,angle,work_item_id').eq('installation_job_id', refId!).order('captured_at'); if (error) throw error; return data || []; }
      return [] as any[];
    }, enabled: !!refId,
  });
  const { data: designFiles = [] } = useQuery({
    queryKey: ['item-review-design-files', shopId, refId],
    queryFn: async () => {
      if (stage !== 'design') return [] as any[];
      const { data, error } = await supabase.from('design_versions').select('id,file_url,version_number,design_version_items(work_item_id)').eq('design_task_id', refId!).order('version_number', { ascending: false });
      if (error) throw error; return data || [];
    }, enabled: stage === 'design' && !!refId,
  });
  const { data: decisions = [] } = useQuery({
    queryKey: ['item-review-decisions', stage, shopId, refId],
    queryFn: async () => {
      const { data, error } = await supabase.from('field_review_decisions').select('*').eq('stage', stage).eq('shop_id', shopId);
      if (error) throw error; return data || [];
    }, enabled: !!shopId,
  });
  const { data: designers = [] } = useQuery({
    queryKey: ['org-designers', profile?.organization_id],
    queryFn: async () => { const { data } = await supabase.from('profiles').select('id, full_name').eq('organization_id', profile!.organization_id).eq('role', 'designer').eq('is_active', true).order('full_name'); return data || []; },
    enabled: stage === 'survey' && !!profile?.organization_id && !readOnly,
  });

  const rows: Row[] = useMemo(() => {
    const out: Row[] = [];
    for (const it of items) {
      const useSurvey = stage === 'survey';
      const w = useSurvey ? it.survey_width : it.approved_width ?? it.survey_width;
      const h = useSurvey ? it.survey_height : it.approved_height ?? it.survey_height;
      const u = useSurvey ? it.survey_unit : it.approved_unit ?? it.survey_unit;
      const q = useSurvey ? it.survey_quantity : it.approved_quantity ?? it.survey_quantity;
      const a = useSurvey ? it.survey_area : it.approved_area ?? it.survey_area;
      const dv = stage === 'design' ? (designFiles as any[]).find((v) => (v.design_version_items || []).some((x: any) => x.work_item_id === it.id)) : null;
      out.push({
        key: `item:${it.id}`, entity: { type: stage === 'survey' ? 'measurement' : 'work_item', id: it.id }, workItemId: it.id,
        title: it.work_type_name || 'Work Item',
        subtitle: `${w ?? '—'} × ${h ?? '—'} ${u || ''} · Qty ${q ?? 1}${a != null ? ` · ${Number(a).toFixed(2)} sq.ft` : ''}`,
        image: dv?.file_url && /\.(png|jpe?g|webp|gif)(\?|$)/i.test(dv.file_url) ? dv.file_url : undefined,
        unavailable: stage === 'installation' && !!it.excluded_from_calculations, reason: it.execution_reason ? `${it.execution_reason}${it.execution_note ? ' · ' + it.execution_note : ''}` : null,
      });
    }
    for (const p of photos as any[]) {
      out.push({
        key: `photo:${p.id}`, entity: { type: stage === 'survey' ? 'survey_photo' : 'installation_photo', id: p.id }, workItemId: p.work_item_id || undefined,
        title: stage === 'survey' ? (p.caption || 'Survey Photo') : `Installation Photo${p.angle ? ` · ${p.angle}` : ''}`,
        subtitle: p.work_item_id ? `For: ${items.find((i: any) => i.id === p.work_item_id)?.work_type_name || 'work item'}` : 'Photo evidence', image: p.photo_url,
      });
    }
    return out;
  }, [items, photos, designFiles, stage]);

  const dmap = useMemo(() => new Map((decisions as any[]).map((d) => [`${d.entity_type}:${d.entity_id}`, d])), [decisions]);
  const toggle = (k: string) => setSelected((s) => { const n = new Set(s); n.has(k) ? n.delete(k) : n.add(k); return n; });
  const allSelected = rows.length > 0 && selected.size === rows.length;
  const undecided = rows.filter((r) => !dmap.get(`${r.entity.type}:${r.entity.id}`)).length;
  const redoCount = rows.filter((r) => dmap.get(`${r.entity.type}:${r.entity.id}`)?.decision === 'redo').length;

  async function run(decision: 'approved' | 'redo', scope: 'selected' | 'all') {
    if (!refId || !profile) return;
    if (scope === 'selected' && !selected.size) return;
    if (decision === 'redo' && !note.trim()) { setErr('Redo ke liye note likhna zaroori hai — kya theek karna hai?'); return; }
    setBusy(true); setErr(''); setMsg('');
    try {
      const entities = scope === 'selected' ? rows.filter((r) => selected.has(r.key)).map((r) => r.entity) : undefined;
      const res = await reviewApply({ stage, shopId, refId, entities, decision, note, designerId: designerId || null, variance });
      if (res.finalized) setMsg(stage === 'survey' ? '✅ Survey approved — design task assign ho gaya.' : stage === 'installation' ? '✅ Installation approved — shop Installed ho gaya.' : '✅ Design approved.');
      else if (res.needs_designer) setMsg('Sab items approved hain. Neeche designer chuniye aur "Approve all" dabaiye.');
      else if (decision === 'redo') setMsg('Redo bhej diya — sirf selected items wapas gaye.');
      else setMsg(`Approved. ${res.pending} item abhi review baaki, ${res.redo} redo mein.`);
      setSelected(new Set()); setNote('');
      await refreshReviewViews(qc, shopId);
      if (res.finalized || res.left_review) onDone?.();
    } catch (e: any) { setErr(e.message || String(e)); } finally { setBusy(false); }
  }

  async function markUnavailable(r: Row) {
    if (!r.workItemId) return;
    const reason = window.prompt('Yeh kaam abhi installation ke liye available kyun nahi hai? (Renovation / site blocked / permission / removed)', r.reason || 'Site renovation')?.trim();
    if (!reason) return;
    const n = window.prompt('Optional comment', '')?.trim() || null;
    try { await setAvailability(r.workItemId, true, reason, n); await refreshReviewViews(qc, shopId); } catch (e: any) { setErr(e.message); }
  }

  if (!refId) return null;
  return (
    <div className="rounded-2xl border border-slate-200 bg-white overflow-hidden">
      <div className="px-4 py-3 bg-slate-50 border-b flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-slate-900">Item-by-item review</p>
          <p className="text-xs text-slate-500">{rows.length} items · {undecided} baaki · {redoCount} redo. Ek, kai ya sab — approve ya redo.</p>
        </div>
        {!readOnly && <button onClick={() => setSelected(allSelected ? new Set() : new Set(rows.map((r) => r.key)))} className="text-xs font-medium text-blue-700 flex items-center gap-1">{allSelected ? <CheckSquare className="w-4 h-4" /> : <Square className="w-4 h-4" />} Select all</button>}
      </div>
      <div className="divide-y">
        {rows.length === 0 && <p className="p-4 text-xs text-slate-400">Is review mein koi item nahi mila.</p>}
        {rows.map((r) => {
          const d: any = dmap.get(`${r.entity.type}:${r.entity.id}`);
          return (
            <div key={r.key} className={`p-3 flex gap-3 ${r.unavailable ? 'bg-slate-50' : d?.decision === 'approved' ? 'bg-emerald-50/40' : d?.decision === 'redo' ? 'bg-amber-50/50' : ''}`}>
              <button disabled={readOnly} onClick={() => toggle(r.key)} className="pt-1">{selected.has(r.key) ? <CheckSquare className="w-5 h-5 text-blue-600" /> : <Square className="w-5 h-5 text-slate-300" />}</button>
              {r.image && <img src={r.image} alt="" className="w-24 aspect-[4/3] object-contain bg-slate-100 rounded-lg border" />}
              <div className="min-w-0 flex-1">
                <div className="flex justify-between gap-2">
                  <div>
                    <p className="text-sm font-semibold text-slate-900">{r.title}</p>
                    <p className="text-xs text-slate-500 mt-0.5">{r.subtitle}</p>
                  </div>
                  <div className="flex flex-col items-end gap-1 shrink-0">
                    {r.unavailable && <span className="rounded-full px-2 py-1 text-[10px] font-bold bg-slate-200 text-slate-700">NOT AVAILABLE · EXCLUDED</span>}
                    {d && <span className={`rounded-full px-2 py-1 text-[10px] font-bold ${d.decision === 'approved' ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'}`}>{d.decision === 'approved' ? 'APPROVED' : 'REDO'}</span>}
                  </div>
                </div>
                {r.unavailable && <p className="text-[11px] text-slate-600 mt-1">Reason: {r.reason || 'Site unavailable'} — installed/billing calculation mein count nahi hoga.</p>}
                {d?.note && <p className="text-[11px] text-slate-500 mt-1">Note: {d.note}</p>}
                {!readOnly && stage === 'installation' && r.entity.type === 'work_item' && !r.unavailable && (
                  <button onClick={() => void markUnavailable(r)} className="mt-1.5 inline-flex items-center gap-1 text-[11px] font-medium text-slate-600 border border-slate-300 rounded-md px-2 py-0.5 hover:bg-slate-100"><Ban className="w-3 h-3" /> Mark not available</button>
                )}
                {!readOnly && stage === 'installation' && r.entity.type === 'work_item' && r.unavailable && (
                  <button onClick={async () => { try { await setAvailability(r.workItemId!, false, null, null); await refreshReviewViews(qc, shopId); } catch (e: any) { setErr(e.message); } }} className="mt-1.5 text-[11px] font-medium text-emerald-700 underline">Make installable again</button>
                )}
              </div>
            </div>
          );
        })}
      </div>
      {!readOnly && (
        <div className="p-3 border-t bg-slate-50 space-y-2">
          {stage === 'survey' && (
            <select value={designerId} onChange={(e) => setDesignerId(e.target.value)} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-xs bg-white">
              <option value="">Designer chuniye (final approval ke liye)…</option>
              {(designers as any[]).map((d) => <option key={d.id} value={d.id}>{d.full_name}</option>)}
            </select>
          )}
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (redo ke liye zaroori — kya sahi karna hai)" className="w-full rounded-lg border border-slate-300 px-3 py-2 text-xs" />
          <div className="grid grid-cols-2 gap-2">
            <button disabled={!selected.size || busy} onClick={() => run('approved', 'selected')} className="rounded-lg bg-emerald-600 text-white py-2 text-sm font-semibold disabled:opacity-40 flex justify-center items-center gap-1">{busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}Approve selected ({selected.size})</button>
            <button disabled={!selected.size || busy} onClick={() => run('redo', 'selected')} className="rounded-lg bg-amber-600 text-white py-2 text-sm font-semibold disabled:opacity-40 flex justify-center items-center gap-1"><RotateCcw className="w-4 h-4" />Redo selected ({selected.size})</button>
            <button disabled={busy} onClick={() => run('approved', 'all')} className="rounded-lg bg-slate-900 text-white py-2 text-sm font-semibold disabled:opacity-40">Approve all remaining</button>
            <button disabled={busy} onClick={() => { if (window.confirm('Sab kuch redo/reject karke wapas bhej dein?')) void run('redo', 'all'); }} className="rounded-lg bg-red-600 text-white py-2 text-sm font-semibold disabled:opacity-40">Reject / redo all</button>
          </div>
          {msg && <p className="text-xs text-emerald-700 font-medium">{msg}</p>}
          {err && <p className="text-xs text-red-600">{err}</p>}
        </div>
      )}
    </div>
  );
}
