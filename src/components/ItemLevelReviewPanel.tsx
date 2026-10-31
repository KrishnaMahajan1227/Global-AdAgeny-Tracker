import { SecureImage } from '@/lib/secureMedia';
import { useMemo, useState } from 'react';
import { itemSizeLabel } from '@/lib/units';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, RotateCcw, Square, CheckSquare, Ban, Loader2, Image as ImageIcon } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { reviewApply, refreshReviewViews, setAvailability, type ReviewEntity, type ReviewStage } from '@/lib/reviewApi';
import type { BoardMarking } from '@/lib/types';

type Props = {
  stage: ReviewStage; shopId: string;
  /** survey id (survey) / installation job id (installation) / design task id (design) */
  refId?: string; surveyId?: string; jobId?: string; taskId?: string;
  assignedTo?: string; readOnly?: boolean; variance?: Record<string, string>; onDone?: () => void;
};

type RelatedImage = {
  id: string;
  url: string;
  label: string;
};

type Row = {
  key: string;
  entity: ReviewEntity;
  title: string;
  subtitle?: string;
  unavailable?: boolean;
  reason?: string | null;
  workItemId?: string;
  relatedImages: RelatedImage[];
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
  const [lightbox, setLightbox] = useState<string | null>(null);

  const { data: items = [] } = useQuery({
    queryKey: ['item-review-items', shopId, stage, refId],
    queryFn: async () => {
      let q = supabase.from('work_items').select('*').eq('shop_id', shopId).order('created_at');
      if (stage === 'survey' && refId) q = q.eq('survey_id', refId);
      const { data, error } = await q;
      if (error) throw error;
      return (data || []) as any[];
    },
    enabled: !!shopId && !!refId,
  });

  const { data: photos = [] } = useQuery({
    queryKey: ['item-review-photos', stage, refId],
    queryFn: async () => {
      if (stage === 'survey') {
        const { data, error } = await supabase.from('survey_photos').select('id,photo_url,caption').eq('survey_id', refId!).order('created_at');
        if (error) throw error;
        return data || [];
      }
      if (stage === 'installation') {
        const { data, error } = await supabase.from('installation_proofs').select('id,photo_url,angle,work_item_id').eq('installation_job_id', refId!).order('captured_at');
        if (error) throw error;
        return data || [];
      }
      return [] as any[];
    },
    enabled: !!refId,
  });

  const { data: surveyMarkings = [] } = useQuery({
    queryKey: ['item-review-board-markings', refId],
    queryFn: async () => {
      if (stage !== 'survey') return [] as BoardMarking[];
      const { data: surveyPhotos, error: photoErr } = await supabase.from('survey_photos').select('id').eq('survey_id', refId!);
      if (photoErr) throw photoErr;
      const ids = (surveyPhotos || []).map((p: any) => p.id);
      if (!ids.length) return [] as BoardMarking[];
      const { data, error } = await supabase.from('board_markings').select('*').in('survey_photo_id', ids);
      if (error) throw error;
      return (data || []) as BoardMarking[];
    },
    enabled: stage === 'survey' && !!refId,
  });

  const { data: designFiles = [] } = useQuery({
    queryKey: ['item-review-design-files', shopId, refId],
    queryFn: async () => {
      if (stage !== 'design') return [] as any[];
      const { data, error } = await supabase.from('design_versions').select('id,file_url,version_number,design_version_items(work_item_id)').eq('design_task_id', refId!).order('version_number', { ascending: false });
      if (error) throw error;
      return data || [];
    }, enabled: stage === 'design' && !!refId,
  });

  const { data: decisions = [] } = useQuery({
    queryKey: ['item-review-decisions', stage, shopId, refId],
    queryFn: async () => {
      const { data, error } = await supabase.from('field_review_decisions').select('*').eq('stage', stage).eq('shop_id', shopId);
      if (error) throw error;
      return data || [];
    }, enabled: !!shopId,
  });

  const { data: designers = [] } = useQuery({
    queryKey: ['org-designers', profile?.organization_id],
    queryFn: async () => {
      const { data } = await supabase.from('profiles').select('id, full_name').eq('organization_id', profile!.organization_id).eq('role', 'designer').eq('is_active', true).order('full_name');
      return data || [];
    },
    enabled: stage === 'survey' && !!profile?.organization_id && !readOnly,
  });

  const photoById = useMemo(() => new Map((photos as any[]).map((p) => [p.id, p])), [photos]);

  const relatedByWorkItem = useMemo(() => {
    const map = new Map<string, RelatedImage[]>();

    if (stage === 'survey') {
      for (const mark of surveyMarkings) {
        if (!mark.work_item_id) continue;
        const photo = photoById.get(mark.survey_photo_id);
        if (!photo?.photo_url) continue;
        const list = map.get(mark.work_item_id) || [];
        if (!list.some((img) => img.id === photo.id)) {
          list.push({ id: photo.id, url: photo.photo_url, label: photo.caption || 'Survey photo' });
          map.set(mark.work_item_id, list);
        }
      }
    }

    if (stage === 'installation') {
      for (const p of photos as any[]) {
        if (!p.work_item_id || !p.photo_url) continue;
        const list = map.get(p.work_item_id) || [];
        list.push({ id: p.id, url: p.photo_url, label: p.angle ? `Installation photo · ${p.angle}` : 'Installation photo' });
        map.set(p.work_item_id, list);
      }
    }

    if (stage === 'design') {
      for (const version of designFiles as any[]) {
        const linkedIds = (version.design_version_items || []).map((x: any) => x.work_item_id);
        for (const itemId of linkedIds) {
          if (!itemId || !version.file_url || !/\.(png|jpe?g|webp|gif)(\?|$)/i.test(version.file_url)) continue;
          const list = map.get(itemId) || [];
          if (!list.some((img) => img.id === version.id)) {
            list.push({ id: version.id, url: version.file_url, label: `Design v${version.version_number || ''}`.trim() });
            map.set(itemId, list);
          }
        }
      }
    }

    return map;
  }, [stage, surveyMarkings, photoById, photos, designFiles]);

  const unlinkedSurveyPhotos = useMemo(() => {
    if (stage !== 'survey') return [] as any[];
    const linked = new Set<string>();
    for (const imgs of relatedByWorkItem.values()) imgs.forEach((img) => linked.add(img.id));
    return (photos as any[]).filter((p) => !linked.has(p.id));
  }, [stage, relatedByWorkItem, photos]);

  const rows: Row[] = useMemo(() => {
    return items.map((it) => {
      const useSurvey = stage === 'survey';
      const q = useSurvey ? it.survey_quantity : it.approved_quantity ?? it.survey_quantity;
      const a = useSurvey ? it.survey_area : it.approved_area ?? it.survey_area;
      return {
        key: `item:${it.id}`,
        entity: { type: stage === 'survey' ? 'measurement' : 'work_item', id: it.id },
        workItemId: it.id,
        title: it.work_type_name || 'Work item',
        subtitle: `${itemSizeLabel(it, useSurvey ? 'survey' : 'approved')} · Qty ${q ?? 1}${a != null ? ` · ${Number(a).toFixed(2)} sq.ft` : ''}`,
        relatedImages: relatedByWorkItem.get(it.id) || [],
        unavailable: stage === 'installation' && !!it.excluded_from_calculations,
        reason: it.execution_reason ? `${it.execution_reason}${it.execution_note ? ' · ' + it.execution_note : ''}` : null,
      };
    });
  }, [items, relatedByWorkItem, stage]);

  const dmap = useMemo(() => new Map((decisions as any[]).map((d) => [`${d.entity_type}:${d.entity_id}`, d])), [decisions]);
  const toggle = (k: string) => setSelected((s) => { const n = new Set(s); n.has(k) ? n.delete(k) : n.add(k); return n; });
  const allSelected = rows.length > 0 && selected.size === rows.length;
  const undecided = rows.filter((r) => !dmap.get(`${r.entity.type}:${r.entity.id}`)).length;
  const redoCount = rows.filter((r) => dmap.get(`${r.entity.type}:${r.entity.id}`)?.decision === 'redo').length;

  async function run(decision: 'approved' | 'redo', scope: 'selected' | 'all') {
    if (!refId || !profile) return;
    if (scope === 'selected' && !selected.size) return;
    if (decision === 'redo' && !note.trim()) {
      setErr('A correction note is required so the field team knows exactly what to fix.');
      return;
    }
    setBusy(true);
    setErr('');
    setMsg('');
    try {
      const entities = scope === 'selected' ? rows.filter((r) => selected.has(r.key)).map((r) => r.entity) : undefined;
      const res = await reviewApply({ stage, shopId, refId, entities, decision, note, designerId: designerId || null, variance });
      if (res.finalized) setMsg(stage === 'survey' ? 'Survey approved and sent to design.' : stage === 'installation' ? 'Installation approved.' : 'Design approved.');
      else if (res.needs_designer) setMsg('All items are approved. Select a designer and approve again to complete the survey review.');
      else if (decision === 'redo') setMsg('Correction request sent for the selected items.');
      else setMsg(`Saved. ${res.pending} item(s) still pending and ${res.redo} item(s) are in correction.`);
      setSelected(new Set());
      setNote('');
      await refreshReviewViews(qc, shopId);
      if (res.finalized || res.left_review) onDone?.();
    } catch (e: any) {
      setErr(e.message || String(e));
    } finally {
      setBusy(false);
    }
  }

  async function markUnavailable(r: Row) {
    if (!r.workItemId) return;
    const reason = window.prompt('Why is this work item not available for installation right now?', r.reason || 'Site renovation')?.trim();
    if (!reason) return;
    const n = window.prompt('Optional comment', '')?.trim() || null;
    try {
      await setAvailability(r.workItemId, true, reason, n);
      await refreshReviewViews(qc, shopId);
    } catch (e: any) {
      setErr(e.message);
    }
  }

  if (!refId) return null;

  return (
    <div className="rounded-2xl border border-slate-200 bg-white overflow-hidden">
      <div className="px-4 py-3 bg-slate-50 border-b flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-slate-900">Item-by-item review</p>
          <p className="text-xs text-slate-500">{rows.length} review item{rows.length === 1 ? '' : 's'} · {undecided} pending · {redoCount} in correction</p>
        </div>
        {!readOnly && (
          <button onClick={() => setSelected(allSelected ? new Set() : new Set(rows.map((r) => r.key)))} className="text-xs font-medium text-blue-700 flex items-center gap-1">
            {allSelected ? <CheckSquare className="w-4 h-4" /> : <Square className="w-4 h-4" />} {allSelected ? 'Clear all' : 'Select all'}
          </button>
        )}
      </div>

      <div className="p-4 space-y-3">
        {rows.length === 0 && <p className="text-xs text-slate-400">No review items were found for this stage.</p>}
        {rows.map((r) => {
          const d: any = dmap.get(`${r.entity.type}:${r.entity.id}`);
          return (
            <div key={r.key} className={`rounded-2xl border p-3 ${r.unavailable ? 'bg-slate-50 border-slate-200' : d?.decision === 'approved' ? 'bg-emerald-50/40 border-emerald-200' : d?.decision === 'redo' ? 'bg-amber-50/50 border-amber-200' : 'bg-white border-slate-200'}`}>
              <div className="flex items-start gap-3">
                {!readOnly && (
                  <button onClick={() => toggle(r.key)} className="pt-1 shrink-0" aria-label={`Select ${r.title}`}>
                    {selected.has(r.key) ? <CheckSquare className="w-5 h-5 text-blue-600" /> : <Square className="w-5 h-5 text-slate-300" />}
                  </button>
                )}
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <p className="text-sm font-semibold text-slate-900">{r.title}</p>
                      <p className="text-xs text-slate-500 mt-0.5">{r.subtitle}</p>
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5 shrink-0">
                      {r.unavailable && <span className="rounded-full px-2 py-1 text-[10px] font-bold bg-slate-200 text-slate-700">Excluded</span>}
                      {d && <span className={`rounded-full px-2 py-1 text-[10px] font-bold ${d.decision === 'approved' ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'}`}>{d.decision === 'approved' ? 'Approved' : 'Correction'}</span>}
                    </div>
                  </div>

                  {r.relatedImages.length > 0 ? (
                    <div className="mt-3 grid grid-cols-2 md:grid-cols-3 gap-2">
                      {r.relatedImages.map((img) => (
                        <button key={img.id} type="button" onClick={() => setLightbox(img.url)} className="text-left rounded-xl overflow-hidden border border-slate-200 bg-slate-50 hover:border-blue-300 transition">
                          <SecureImage src={img.url} alt={img.label} className="w-full h-32 object-cover bg-slate-100" />
                          <div className="px-2 py-1.5 bg-white border-t border-slate-100">
                            <p className="text-[11px] text-slate-600 truncate">{img.label}</p>
                          </div>
                        </button>
                      ))}
                    </div>
                  ) : (
                    <div className="mt-3 rounded-xl border border-dashed border-slate-200 bg-slate-50 px-3 py-2 flex items-center gap-2 text-xs text-slate-400">
                      <ImageIcon className="w-4 h-4" /> No linked evidence photo for this item.
                    </div>
                  )}

                  {r.unavailable && <p className="text-[11px] text-slate-600 mt-2">Reason: {r.reason || 'Site unavailable'} — excluded from installation totals.</p>}
                  {d?.note && <p className="text-[11px] text-slate-500 mt-2">Review note: {d.note}</p>}

                  {!readOnly && stage === 'installation' && r.entity.type === 'work_item' && !r.unavailable && (
                    <button onClick={() => void markUnavailable(r)} className="mt-2 inline-flex items-center gap-1 text-[11px] font-medium text-slate-600 border border-slate-300 rounded-md px-2 py-0.5 hover:bg-slate-100">
                      <Ban className="w-3 h-3" /> Mark not available
                    </button>
                  )}
                  {!readOnly && stage === 'installation' && r.entity.type === 'work_item' && r.unavailable && (
                    <button onClick={async () => { try { await setAvailability(r.workItemId!, false, null, null); await refreshReviewViews(qc, shopId); } catch (e: any) { setErr(e.message); } }} className="mt-2 text-[11px] font-medium text-emerald-700 underline">
                      Make installable again
                    </button>
                  )}
                </div>
              </div>
            </div>
          );
        })}

        {stage === 'survey' && unlinkedSurveyPhotos.length > 0 && (
          <div className="rounded-2xl border border-slate-200 bg-slate-50 p-3">
            <p className="text-xs font-medium text-slate-700 mb-2">Additional survey photos</p>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
              {unlinkedSurveyPhotos.map((p: any) => (
                <button key={p.id} type="button" onClick={() => setLightbox(p.photo_url)} className="rounded-xl overflow-hidden border border-slate-200 bg-white text-left">
                  <SecureImage src={p.photo_url} alt={p.caption || 'Survey photo'} className="w-full h-28 object-cover bg-slate-100" />
                  <p className="px-2 py-1.5 text-[11px] text-slate-600 truncate">{p.caption || 'Survey photo'}</p>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {!readOnly && (
        <div className="sticky bottom-0 border-t bg-white/95 backdrop-blur px-4 py-3 space-y-2">
          {stage === 'survey' && (
            <select value={designerId} onChange={(e) => setDesignerId(e.target.value)} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-xs bg-white">
              <option value="">Assign designer before final approval…</option>
              {(designers as any[]).map((d) => <option key={d.id} value={d.id}>{d.full_name}</option>)}
            </select>
          )}
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Review note (required for correction requests)" className="w-full rounded-lg border border-slate-300 px-3 py-2 text-xs" />
          <div className="grid grid-cols-2 gap-2">
            <button disabled={!selected.size || busy} onClick={() => run('approved', 'selected')} className="rounded-lg bg-emerald-600 text-white py-2 text-sm font-semibold disabled:opacity-40 flex justify-center items-center gap-1">
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}Approve selected ({selected.size})
            </button>
            <button disabled={!selected.size || busy} onClick={() => run('redo', 'selected')} className="rounded-lg bg-amber-600 text-white py-2 text-sm font-semibold disabled:opacity-40 flex justify-center items-center gap-1">
              <RotateCcw className="w-4 h-4" />Request correction ({selected.size})
            </button>
            <button disabled={busy} onClick={() => run('approved', 'all')} className="rounded-lg bg-slate-900 text-white py-2 text-sm font-semibold disabled:opacity-40">Approve all remaining</button>
            <button disabled={busy} onClick={() => { if (window.confirm('Send all remaining items back for correction?')) void run('redo', 'all'); }} className="rounded-lg bg-red-600 text-white py-2 text-sm font-semibold disabled:opacity-40">Request correction for all</button>
          </div>
          {msg && <p className="text-xs text-emerald-700 font-medium">{msg}</p>}
          {err && <p className="text-xs text-red-600">{err}</p>}
        </div>
      )}

      {lightbox && (
        <div onClick={() => setLightbox(null)} className="fixed inset-0 z-[100] bg-black/80 flex items-center justify-center p-4 cursor-zoom-out">
          <SecureImage src={lightbox} alt="Evidence" className="max-w-full max-h-full rounded-lg" />
        </div>
      )}
    </div>
  );
}
