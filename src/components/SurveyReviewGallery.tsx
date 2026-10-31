import { SecureImage } from '@/lib/secureMedia';
import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, ImageOff, Loader2, RotateCcw, ZoomIn } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { itemSizeLabel } from '@/lib/units';
import { renderMarkedImage, buildBoardLabel } from '@/lib/markingUtils';
import { reviewApply, refreshReviewViews } from '@/lib/reviewApi';
import { surveyReviewSelectionModel, type SurveyCorrectionScope } from '@/lib/surveyReviewSelection';
import type { BoardMarking, SurveyPhoto, WorkItem } from '@/lib/types';

type Evidence = { photos: SurveyPhoto[]; items: WorkItem[]; markings: BoardMarking[]; links: { survey_photo_id: string; work_item_id: string }[]; decisions: { entity_type: string; entity_id: string; decision: string; note: string | null }[] };
type Props = { surveyId: string; shopId: string; readOnly?: boolean; batchMode?: boolean; onDone?: () => void; onEvidenceReady?: () => void; onEvidenceChanged?: () => void };

function MarkedTile({ photo, markings, items, wide }: { photo: SurveyPhoto; markings: BoardMarking[]; items: WorkItem[]; wide?: boolean }) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setSrc(null); setFailed(false);
    const valid = markings.filter(m => Array.isArray(m.points) && m.points.length >= 3);
    if (!valid.length) return;
    const labels = valid.map(m => {
      const item = items.find(it => it.id === m.work_item_id);
      return item ? buildBoardLabel({ workTypeName: item.work_type_name, sizeLabel: itemSizeLabel(item, 'survey') }) : null;
    });
    const timeout = new Promise<never>((_, reject) => { window.setTimeout(() => reject(new Error('Marking preview timed out')), 12000); });
    Promise.race([renderMarkedImage(photo.photo_url, valid.map(m => m.points), { labels }), timeout])
      .then(result => { if (!cancelled) setSrc(result.dataUrl); })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [photo.id, photo.photo_url, markings, items]);
  const hasMarkings = markings.some(m => Array.isArray(m.points) && m.points.length >= 3);
  return <div className="min-w-0">
    <button type="button" className="relative block w-full rounded-lg border border-slate-200 bg-slate-100 overflow-hidden focus-visible:ring-2 focus-visible:ring-blue-500" onClick={() => setExpanded(true)} aria-label="Inspect marked survey photo">
      <SecureImage src={src || photo.photo_url} alt={src ? 'Survey photo with marked boards and dimensions' : 'Survey photo'} className={`w-full ${wide ? 'h-64 sm:h-72' : 'h-48 sm:h-52'} object-contain`} />
      {hasMarkings && !src && !failed && <span className="absolute top-2 left-2 flex items-center gap-1 rounded bg-slate-900/80 px-2 py-1 text-[11px] text-white"><Loader2 className="w-3 h-3 animate-spin" />Rendering markings</span>}
      {failed && <span className="absolute bottom-2 left-2 rounded bg-amber-50 px-2 py-1 text-[11px] font-medium text-amber-900">Marked preview unavailable; original shown</span>}
      {src && <span className="absolute top-2 left-2 rounded bg-blue-700 px-2 py-1 text-[11px] font-medium text-white">Marked</span>}
      <span className="absolute bottom-2 right-2 rounded bg-white/95 p-1 text-slate-800"><ZoomIn className="w-4 h-4" /></span>
    </button>
    {expanded && <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/90 p-4" role="dialog" aria-modal="true" aria-label="Survey photo preview" onClick={() => setExpanded(false)}>
      <button type="button" className="absolute right-4 top-4 rounded bg-white px-3 py-1.5 text-sm font-medium text-slate-900" onClick={() => setExpanded(false)}>Close</button>
      <SecureImage src={src || photo.photo_url} alt="Survey evidence" className="max-h-[85vh] max-w-full object-contain" onClick={e => e.stopPropagation()} />
    </div>}
  </div>;
}

export function SurveyReviewGallery({ surveyId, shopId, readOnly = false, batchMode = false, onDone, onEvidenceReady, onEvidenceChanged }: Props) {
  const { profile } = useAuth();
  const qc = useQueryClient();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [designerId, setDesignerId] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<'approved' | 'redo' | null>(null);
  const [correctionScope, setCorrectionScope] = useState<SurveyCorrectionScope>('both');
  const [selectedPhotoId, setSelectedPhotoId] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const [successMessage, setSuccessMessage] = useState('');
  useEffect(() => { setSelected(new Set()); setNote(''); setDesignerId(''); setConfirm(null); setCorrectionScope('both'); setSelectedPhotoId(''); }, [surveyId]);

  const evidence = useQuery({
    queryKey: ['survey-review-gallery', shopId, surveyId],
    queryFn: async (): Promise<Evidence> => {
      const [itemsRes, photosRes, decisionsRes] = await Promise.all([
        supabase.from('work_items').select('*').eq('survey_id', surveyId).eq('shop_id', shopId).order('created_at'),
        supabase.from('survey_photos').select('*').eq('survey_id', surveyId).eq('shop_id', shopId).order('created_at'),
        supabase.from('field_review_decisions').select('entity_type,entity_id,decision,note').eq('stage', 'survey').eq('shop_id', shopId),
      ]);
      if (itemsRes.error || photosRes.error || decisionsRes.error) throw new Error(itemsRes.error?.message || photosRes.error?.message || decisionsRes.error?.message);
      const ids = (photosRes.data || []).map(photo => photo.id);
      if (!ids.length) return { items: (itemsRes.data || []) as WorkItem[], photos: [], decisions: decisionsRes.data || [], markings: [], links: [] };
      const [markRes, linksRes] = await Promise.all([
        supabase.from('board_markings').select('*').in('survey_photo_id', ids),
        supabase.from('survey_photo_items').select('survey_photo_id,work_item_id').in('survey_photo_id', ids),
      ]);
      if (markRes.error || linksRes.error) throw new Error(markRes.error?.message || linksRes.error?.message);
      return { items: (itemsRes.data || []) as WorkItem[], photos: (photosRes.data || []) as SurveyPhoto[], decisions: decisionsRes.data || [], markings: (markRes.data || []) as BoardMarking[], links: linksRes.data || [] };
    },
    enabled: !!shopId && !!surveyId,
  });
  useEffect(() => { if (evidence.isSuccess && !evidence.isFetching && evidence.data && evidence.data.photos.length > 0 && evidence.data.items.length > 0) onEvidenceReady?.(); }, [evidence.isSuccess, evidence.isFetching, evidence.dataUpdatedAt, onEvidenceReady]);
  const designers = useQuery({
    queryKey: ['org-designers', profile?.organization_id],
    queryFn: async () => {
      const { data, error } = await supabase.from('profiles').select('id,full_name').eq('organization_id', profile!.organization_id).eq('role', 'designer').eq('is_active', true).order('full_name');
      if (error) throw error;
      return data || [];
    }, enabled: !!profile?.organization_id && !readOnly,
  });

  useEffect(() => { if (designers.data?.length === 1) setDesignerId(current => current || designers.data![0].id); }, [designers.data, surveyId]);

  const groups = useMemo(() => {
    if (!evidence.data) return [];
    const { photos, items, markings, links } = evidence.data;
    const linked = new Set<string>();
    const first = new Set<string>();
    const cards = photos.map(photo => {
      const relatedIds = new Set([
        ...markings.filter(m => m.survey_photo_id === photo.id).map(m => m.work_item_id).filter(Boolean),
        ...links.filter(l => l.survey_photo_id === photo.id).map(l => l.work_item_id),
      ]);
      const newlyLinked = items.filter(it => relatedIds.has(it.id) && !first.has(it.id));
      newlyLinked.forEach(it => { first.add(it.id); linked.add(it.id); });
      return { photo, markings: markings.filter(m => m.survey_photo_id === photo.id), items: newlyLinked, isAdditional: newlyLinked.length === 0 && relatedIds.size > 0 };
    });
    return { cards, unlinked: items.filter(it => !linked.has(it.id)) };
  }, [evidence.data]);

  // UI counts logical review units, not the separate rows required by the
  // backend. A photo linked to a work item is reviewed with that work item.
  const selectionPlan = useMemo(() => surveyReviewSelectionModel({
    items: evidence.data?.items || [],
    photos: evidence.data?.photos || [],
    markings: evidence.data?.markings || [],
    links: evidence.data?.links || [],
    decisions: evidence.data?.decisions || [],
  }), [evidence.data]);
  const decisions = new Map((evidence.data?.decisions || []).map(d => [`${d.entity_type}:${d.entity_id}`, d]));
  const selectable = selectionPlan.choices;
  const isSelected = (key: string) => selected.has(key);
  const toggle = (key: string) => {
    if (!selectable.some(choice => choice.key === key)) return;
    setSelected(prev => { const next = new Set(prev); next.has(key) ? next.delete(key) : next.add(key); return next; });
  };
  const allChosen = selectable.length > 0 && selectable.every(choice => selected.has(choice.key));
  const selectedCount = selectable.filter(choice => selected.has(choice.key)).length;
  const photoCount = evidence.data?.photos.length ?? 0;

  // Pending units are ready for a normal approve/redo decision by default.
  // Their checkboxes remain available only to narrow a partial correction.
  // Refetching after a decision selects only the still-pending units.
  useEffect(() => {
    if (!readOnly && evidence.isSuccess && evidence.data) {
      setSelected(new Set(selectionPlan.choices.map(choice => choice.key)));
    }
  }, [readOnly, evidence.isSuccess, evidence.dataUpdatedAt, selectionPlan]);

  async function submit(decision: 'approved' | 'redo') {
    if (!evidence.data || !profile || !selectedCount || busy) return;
    if (decision === 'approved' && !designerId) { setErrorMessage('Select a designer before approving.'); return; }
    if (decision === 'redo' && !note.trim()) { setErrorMessage('Enter a correction reason describing exactly what must change.'); return; }
    setBusy(true); setErrorMessage(''); setSuccessMessage('');
    try {
      if (decision === 'redo' && correctionScope === 'photo' && evidence.data.photos.length > 1 && !selectedPhotoId) {
        throw new Error('Choose the exact photo to reject, or explicitly select All linked photos.');
      }
      const targets = selectionPlan.expand(selected, decision, decision === 'redo' ? correctionScope : 'both', selectedPhotoId || undefined);
      // Never pass an empty array to reviewApply: the RPC treats it as ALL.
      if (!targets.length) throw new Error('No pending review targets found. Refresh the review and try again.');
      const result = await reviewApply({ stage: 'survey', shopId, refId: surveyId, entities: targets, decision, note, designerId: designerId || null });
      await Promise.all([qc.invalidateQueries({ queryKey: ['survey-review-gallery', shopId, surveyId] }), refreshReviewViews(qc, shopId)]);
      setSelected(new Set()); setNote(''); setConfirm(null); onEvidenceChanged?.();
      if (result.finalized) { onDone?.(); return; }
      setSuccessMessage(decision === 'redo' ? 'Selected evidence returned for correction.' : `${result.pending} remaining to review${result.redo ? ` · ${result.redo} in correction` : ''}.`);
      if (result.needs_designer) setSuccessMessage('Select a designer to complete final approval.');
      if (result.left_review) onDone?.();
    } catch (e: any) { setErrorMessage(e?.message || 'Unable to save review. Please retry.'); }
    finally { setBusy(false); }
  }

  if (evidence.isPending) return <div className="flex items-center gap-2 rounded-xl bg-slate-50 p-5 text-sm text-slate-500"><Loader2 className="h-4 w-4 animate-spin" />Loading marked evidence…</div>;
  if (evidence.isError) return <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">Could not load review evidence: {(evidence.error as Error).message}<button type="button" onClick={() => void evidence.refetch()} className="ml-3 font-semibold underline">Retry</button></div>;
  const safeGroups = groups && !Array.isArray(groups) ? groups : { cards: [], unlinked: [] };

  return <div className="space-y-3">
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
      {!readOnly ? <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs font-medium text-slate-800">
        <span>{selectable.length} pending item{selectable.length === 1 ? '' : 's'} · {selectedCount} ready for action</span>
        {!allChosen && selectable.length > 0 && <button type="button" onClick={() => setSelected(new Set(selectable.map(choice => choice.key)))} className="rounded px-2 py-1 font-semibold text-blue-700 hover:bg-blue-50">Select all pending</button>}
      </div> : <span className="text-xs font-medium text-slate-600">Survey evidence</span>}
      <p className="text-xs text-slate-500">{photoCount} photo{photoCount === 1 ? '' : 's'} · {evidence.data?.items.length || 0} work item{evidence.data?.items.length === 1 ? '' : 's'}</p>
    </div>
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
      {safeGroups.cards.map(({ photo, markings, items, isAdditional }) => {
        const photoDecision = decisions.get(`survey_photo:${photo.id}`);
        return <article key={photo.id} className={`min-w-0 overflow-hidden rounded-xl border border-slate-200 bg-white ${photoCount === 1 ? 'lg:col-span-2 lg:grid lg:grid-cols-[1fr_1fr]' : ''}`} >
          <MarkedTile photo={photo} markings={markings} items={evidence.data!.items} wide={photoCount === 1} />
          <div className={`space-y-2 px-3 py-2.5 ${photoCount === 1 ? 'lg:max-h-72 lg:overflow-y-auto' : ''}`}>
            {/* No duplicate photo checkbox when its selection is covered by a
                linked work item. A standalone photo remains independently reviewable. */}
            {selectable.some(choice => choice.key === `survey_photo:${photo.id}`) ? (
              <label className="flex items-center gap-2 rounded-lg border border-slate-100 bg-slate-50 px-2.5 py-2 text-xs font-medium text-slate-800">
                {!readOnly && <input type="checkbox" aria-label={`Select photo evidence ${photo.id}`} className="h-4 w-4 shrink-0 accent-blue-600" checked={isSelected(`survey_photo:${photo.id}`)} onChange={() => toggle(`survey_photo:${photo.id}`)} />}
                Photo evidence
              </label>
            ) : photoDecision && (
              <p className="text-[11px] font-medium text-slate-600">Photo evidence · {photoDecision.decision === 'approved' ? 'Approved' : 'Correction requested'}{photoDecision.note ? ` · ${photoDecision.note}` : ''}</p>
            )}
            {items.map(item => {
              const itemDecision = decisions.get(`measurement:${item.id}`);
              return <label key={item.id} className="flex cursor-pointer items-start gap-2 rounded-lg border border-slate-100 bg-slate-50 p-2.5">
                {!readOnly && <input type="checkbox" className="mt-0.5 h-4 w-4 shrink-0 accent-blue-600" checked={isSelected(`measurement:${item.id}`)} disabled={!!itemDecision} onChange={() => toggle(`measurement:${item.id}`)} />}
                <span className="min-w-0 flex-1"><span className="block text-xs font-semibold text-slate-900">{item.work_type_name || 'Work item'}</span>
                  <span className="mt-0.5 block text-xs text-slate-600">{itemSizeLabel(item, 'survey')} · Qty {item.survey_quantity ?? 1}{item.survey_area != null ? ` · ${Number(item.survey_area).toFixed(2)} sq.ft` : ''}{item.material ? ` · ${item.material}` : ''}</span>
                  {item.survey_notes && <span className="mt-1 block text-[11px] text-slate-500">{item.survey_notes}</span>}
                  {itemDecision && <span className="mt-1 block text-[11px] text-slate-500">{itemDecision.decision === 'approved' ? 'Approved' : 'Correction requested'}{itemDecision.note ? ` · ${itemDecision.note}` : ''}</span>}
                </span>
              </label>;
            })}
            {isAdditional && <p className="text-[11px] text-slate-500">Additional image for a work item shown above; measurements are listed once.</p>}
            {!items.length && !isAdditional && <p className="text-[11px] text-slate-500">No work-item link for this photo.</p>}
          </div>
        </article>;
      })}
      {safeGroups.unlinked.map(item => {
        const itemDecision = decisions.get(`measurement:${item.id}`);
        return <label key={item.id} className="flex cursor-pointer items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3">
          {!readOnly && <input type="checkbox" className="mt-0.5 h-4 w-4 accent-blue-600" checked={isSelected(`measurement:${item.id}`)} disabled={!!itemDecision} onChange={() => toggle(`measurement:${item.id}`)} />}
          <ImageOff className="h-4 w-4 text-amber-600" />
          <span className="text-xs"><strong className="block text-slate-900">{item.work_type_name || 'Work item'}</strong><span className="text-slate-600">{itemSizeLabel(item, 'survey')} · Qty {item.survey_quantity ?? 1}</span><span className="block text-amber-800">No linked photo; verify before approving.</span>{itemDecision && <span className="block text-slate-500">{itemDecision.decision === 'approved' ? 'Approved' : 'Correction requested'}{itemDecision.note ? ` · ${itemDecision.note}` : ''}</span>}</span>
        </label>;
      })}
    </div>
    {!photoCount && !safeGroups.unlinked.length && <p className="rounded-lg bg-slate-50 p-4 text-sm text-slate-500">No survey evidence found.</p>}

    {!readOnly && <div className={`${batchMode ? 'relative' : 'sticky bottom-0 z-10'} -mx-1 rounded-xl border border-slate-200 bg-white/95 px-3 py-2.5 shadow-md backdrop-blur space-y-2`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="mr-auto text-xs font-semibold text-slate-700">{batchMode ? `Individual measurement / photo · ${selectedCount} selected` : `${selectedCount} selected`}</span>
        <label className="sr-only" htmlFor="survey-review-designer">Assign designer</label>
        <select id="survey-review-designer" value={designerId} onChange={e => setDesignerId(e.target.value)} className="min-w-[160px] max-w-[250px] flex-1 rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-xs"><option value="">Select designer</option>{(designers.data || []).map(d => <option key={d.id} value={d.id}>{d.full_name}</option>)}</select>
        <button type="button" onClick={() => setConfirm('approved')} disabled={!selectedCount || busy || !designerId || designers.isPending || designers.isError} className="inline-flex items-center gap-1 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-40"><Check className="w-3.5 h-3.5" />Approve</button>
        <button type="button" onClick={() => setConfirm('redo')} disabled={!selectedCount || busy} className="inline-flex items-center gap-1 rounded-lg border border-amber-300 bg-amber-50 px-3 py-1.5 text-xs font-semibold text-amber-800 disabled:opacity-40"><RotateCcw className="w-3.5 h-3.5" />Reject / redo</button>
      </div>
      {confirm && <div className="flex flex-wrap items-center gap-2 rounded-lg bg-slate-50 p-2.5">
        {confirm === 'redo' && <label className="flex min-w-[170px] items-center gap-2 text-xs text-slate-600">Return
          <select aria-label="Correction target" value={correctionScope} onChange={e => setCorrectionScope(e.target.value as SurveyCorrectionScope)} className="rounded border border-slate-300 bg-white px-2 py-1.5 text-xs">
            <option value="both">Measurement + photo</option>
            <option value="measurement">Measurement only</option>
            <option value="photo">Photo only</option>
          </select>
        </label>}
        {confirm === 'redo' && correctionScope === 'photo' && photoCount > 1 && <select aria-label="Choose photo to reject" value={selectedPhotoId} onChange={e => setSelectedPhotoId(e.target.value)} className="min-w-[170px] rounded border border-slate-300 bg-white px-2 py-1.5 text-xs">
          <option value="">Choose exact photo…</option>
          {evidence.data?.photos.map((p, idx) => <option key={p.id} value={p.id}>Photo {idx + 1}{p.caption ? ` · ${p.caption}` : ''}</option>)}
          <option value="all">All linked photos</option>
        </select>}
        {confirm === 'redo' && <input aria-label="Correction instructions" value={note} onChange={e => setNote(e.target.value)} placeholder="Describe the required correction" className="min-w-[150px] flex-1 rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs" />}
        <span className="text-xs text-slate-600">{confirm === 'approved' ? `Approve ${selectedCount} selected review item(s)?` : `Reject selected evidence and request correction for ${selectedCount} review item(s)?`}</span>
        <button type="button" onClick={() => setConfirm(null)} className="rounded px-2 py-1 text-xs text-slate-600">Cancel</button>
        <button type="button" onClick={() => void submit(confirm)} disabled={busy || (confirm === 'redo' && !note.trim())} className="rounded bg-slate-900 px-2.5 py-1.5 text-xs font-semibold text-white disabled:opacity-40">{busy ? 'Saving…' : 'Confirm review decision'}</button>
      </div>}
      {errorMessage && <p role="alert" className="text-xs text-red-700">{errorMessage}</p>}
      {successMessage && <p role="status" className="text-xs text-emerald-700">{successMessage}</p>}
    </div>}
  </div>;
}
