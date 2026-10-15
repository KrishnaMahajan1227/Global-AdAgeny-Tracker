import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, CheckCircle2, Camera, RefreshCw } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { itemSizeLabel, trimNum, LENGTH_UNIT_OPTIONS } from '@/lib/units';
import { submitCorrections, refreshReviewViews } from '@/lib/reviewApi';
import { MarkedPhotoGrid } from '@/components/MarkedPhotoGrid';
import { BoardMarkerCanvas } from '@/components/BoardMarkerCanvas';
import { useOnlineStatus } from '@/lib/useOnlineStatus';
import { loadRedoDrafts, queueRedoDraft, redoDraftId, syncRedoDraft, type RedoDraft } from '@/lib/fieldRedo';
import type { MarkPoint } from '@/lib/markingUtils';

const readPhoto = (file: File): Promise<string> => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result));
  reader.onerror = () => reject(new Error('Could not read this photo'));
  reader.readAsDataURL(file);
});

type Form = { width: string; height: string; unit: string; heightUnit: string; quantity: string; notes: string };
const initialForm = (item: any): Form => ({
  width: item.entered_width != null ? String(item.entered_width) : trimNum(item.survey_width),
  height: item.entered_height != null ? String(item.entered_height) : trimNum(item.survey_height),
  unit: item.entered_width_unit || 'ft', heightUnit: item.entered_height_unit || item.entered_width_unit || 'ft',
  quantity: String(item.survey_quantity || 1), notes: item.survey_notes || '',
});

/** Rework is an in-place correction of exactly the returned IDs; evidence not selected for redo stays unchanged. */
export function SurveyCorrectionFixer({ shopId, onExit }: { shopId: string; onExit: () => void }) {
  const { profile } = useAuth();
  const qc = useQueryClient();
  const online = useOnlineStatus();
  const [forms, setForms] = useState<Record<string, Form>>({});
  const [photoDrafts, setPhotoDrafts] = useState<Record<string, { dataUrl: string; fileName: string; markings: { id: string; points: MarkPoint[] }[] }>>({});
  const [draftQueue, setDraftQueue] = useState<Record<string, RedoDraft>>({});
  const [activeBoard, setActiveBoard] = useState<Record<string, number>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [errorText, setErrorText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const activeSync = useRef(false);
  const persistedWrites = useRef<Promise<void>>(Promise.resolve());
  const persistQueued = (draft: RedoDraft) => {
    persistedWrites.current = persistedWrites.current.catch(() => {}).then(() => queueRedoDraft(draft));
    return persistedWrites.current;
  };
  const attempted = useRef(new Set<string>());

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['survey-field-corrections', shopId, profile?.id, 'fixer'],
    queryFn: async () => {
      const [corrections, shop, items, photos, markings, photoLinks] = await Promise.all([
        supabase.from('field_corrections').select('*').eq('shop_id', shopId).eq('stage', 'survey').eq('assigned_to', profile!.id).eq('status', 'open').order('created_at'),
        supabase.from('shops').select('name,clients(name)').eq('id', shopId).maybeSingle(),
        supabase.from('work_items').select('*').eq('shop_id', shopId).order('created_at'),
        supabase.from('survey_photos').select('*').eq('shop_id', shopId).order('created_at'),
        supabase.from('board_markings').select('*').eq('organization_id', profile!.organization_id),
        supabase.from('survey_photo_items').select('survey_photo_id,work_item_id').eq('organization_id', profile!.organization_id),
      ]);
      for (const result of [corrections, shop, items, photos, markings]) if (result.error) throw result.error;
      const photoIds = new Set((photos.data || []).map((p: any) => p.id));
      return {
        corr: corrections.data || [], shop: shop.data,
        items: items.data || [], photos: photos.data || [],
        markings: (markings.data || []).filter((m: any) => photoIds.has(m.survey_photo_id)),
        links: (photoLinks.data || []).filter((link: any) => photoIds.has(link.survey_photo_id)),
      };
    }, enabled: !!profile?.id,
  });

  useEffect(() => {
    if (!profile?.id) return;
    let mounted = true;
    loadRedoDrafts(profile.id, shopId, 'survey').then((drafts) => {
      if (!mounted) return;
      const queued: Record<string, RedoDraft> = {};
      const photos: typeof photoDrafts = {};
      const nextForms: typeof forms = {};
      for (const draft of drafts) {
        queued[draft.correctionId] = draft;
        if (typeof draft.payload.dataUrl === 'string') photos[draft.correctionId] = {
          dataUrl: draft.payload.dataUrl, fileName: String(draft.payload.fileName || 'redo.jpg'),
          markings: (draft.payload.markings || []) as { id: string; points: MarkPoint[] }[],
        };
        if (draft.payload.width != null) nextForms[draft.correctionId] = draft.payload as unknown as Form;
      }
      setDraftQueue(queued); setPhotoDrafts(photos); setForms((previous) => ({ ...nextForms, ...previous }));
    }).catch((err) => setErrorText(String(err)));
    return () => { mounted = false; };
  }, [profile?.id, shopId]);

  async function syncOne(draft: RedoDraft) {
    if (!draft.payload.ready || !online) return;
    setBusyId(draft.correctionId); setErrorText('');
    try {
      await syncRedoDraft(draft);
      setDraftQueue((previous) => { const next = { ...previous }; delete next[draft.correctionId]; return next; });
      setPhotoDrafts((previous) => { const next = { ...previous }; delete next[draft.correctionId]; return next; });
      await qc.invalidateQueries({ queryKey: ['survey-field-corrections', shopId] });
      await qc.invalidateQueries({ queryKey: ['shop-survey-photos'] });
      await qc.invalidateQueries({ queryKey: ['shop-board-markings'] });
      await refetch();
    } catch (err: any) { setErrorText(err?.message || 'Could not sync correction; saved locally for retry'); }
    finally { setBusyId(null); }
  }

  useEffect(() => {
    if (!online) { attempted.current.clear(); return; }
    if (activeSync.current) return;
    const pending = Object.values(draftQueue).find((d) => d.payload.ready && !attempted.current.has(d.correctionId) && busyId !== d.correctionId);
    if (!pending) return;
    activeSync.current = true;
    attempted.current.add(pending.correctionId);
    void syncOne(pending).finally(() => { activeSync.current = false; });
    // The draft object is removed after sync, so the next queued draft is automatically attempted.
  }, [online, draftQueue, busyId]);

  async function saveDraft(c: any, payload: Record<string, unknown>) {
    if (!profile) return;
    const draft: RedoDraft = { id: redoDraftId(profile.id, c.id), userId: profile.id, shopId, stage: 'survey', correctionId: c.id,
      status: 'queued', updatedAt: new Date().toISOString(), payload: { ...payload, ready: true } };
    await persistQueued(draft);
    attempted.current.delete(c.id);
    setDraftQueue((previous) => ({ ...previous, [c.id]: draft }));
    if (online) await syncOne(draft);
  }

  async function pickPhoto(c: any, photo: any, file: File) {
    if (!profile) return;
    try {
      const dataUrl = await readPhoto(file);
      const marks = (data?.markings || []).filter((m: any) => m.survey_photo_id === photo.id).map((m: any) => ({ id: m.id, points: [] as MarkPoint[] }));
      const current = { dataUrl, fileName: file.name, markings: marks };
      setPhotoDrafts((previous) => ({ ...previous, [c.id]: current }));
      const draft: RedoDraft = { id: redoDraftId(profile.id, c.id), userId: profile.id, shopId, stage: 'survey', correctionId: c.id,
        status: 'queued', updatedAt: new Date().toISOString(), payload: { ...current, organizationId: profile.organization_id, ready: false } };
      await persistQueued(draft);
      setDraftQueue((previous) => ({ ...previous, [c.id]: draft }));
    } catch (err: any) { setErrorText(err?.message || 'Unable to save selected photo locally'); }
  }

  async function updateMark(c: any, index: number, points: MarkPoint[]) {
    const old = photoDrafts[c.id];
    const queued = draftQueue[c.id];
    if (!old || !queued) return;
    const next = { ...old, markings: old.markings.map((mark, i) => i === index ? { ...mark, points } : mark) };
    setPhotoDrafts((previous) => ({ ...previous, [c.id]: next }));
    const draft = { ...queued, payload: { ...queued.payload, ...next, ready: false }, updatedAt: new Date().toISOString() };
    setDraftQueue((previous) => ({ ...previous, [c.id]: draft }));
    await persistQueued(draft);
  }

  async function submit() {
    setSubmitting(true); setErrorText('');
    try { await submitCorrections('survey', shopId); await refreshReviewViews(qc, shopId); setDone(true); }
    catch (err: any) { setErrorText(err?.message || String(err)); } finally { setSubmitting(false); }
  }

  const corrections = data?.corr || [];
  const complete = corrections.length > 0 && corrections.every((c: any) => !!c.replacement_saved_at) && !Object.keys(draftQueue).length;

  if (done) return <div className="min-h-screen bg-slate-50 p-5"><div className="mx-auto mt-16 max-w-md rounded-2xl border bg-white p-6 text-center"><CheckCircle2 className="mx-auto mb-3 h-10 w-10 text-emerald-600" /><h2 className="font-semibold">Corrections submitted</h2><p className="mt-2 text-sm text-slate-500">Updated evidence is ready for review.</p><button onClick={onExit} className="mt-5 rounded-lg bg-blue-700 px-5 py-2 text-sm font-semibold text-white">Back to work</button></div></div>;

  return <div className="mx-auto min-h-screen max-w-md bg-slate-50 pb-28">
    <div className="sticky top-0 z-20 flex items-center gap-3 border-b bg-white px-4 py-3"><button onClick={onExit} aria-label="Back" className="rounded-lg p-1 text-slate-600"><ChevronLeft className="h-5 w-5" /></button><div className="min-w-0"><h1 className="truncate text-sm font-semibold text-slate-900">Review corrections · {data?.shop?.name || 'Shop'}</h1><p className="text-xs text-slate-500">{corrections.length} returned · existing evidence stays until replacement saves</p></div></div>
    <div className="space-y-3 p-3">
      {!online && <div className="rounded-lg bg-amber-50 p-3 text-xs text-amber-800">Offline — changes stay on this device. They will retry when connection returns.</div>}
      {isLoading && <div className="rounded-xl border bg-white p-5 text-sm text-slate-500">Loading returned work and marked photos…</div>}
      {error && <div role="alert" className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">Could not load correction details: {String(error)}</div>}
      {corrections.map((c: any, index: number) => {
        const item = data!.items.find((it: any) => it.id === c.work_item_id);
        const photo = data!.photos.find((ph: any) => ph.id === c.survey_photo_id);
        const relevantPhotoIds = new Set((data!.markings || []).filter((m: any) => m.work_item_id === item?.id).map((m: any) => m.survey_photo_id));
        for (const link of data!.links || []) if (link.work_item_id === item?.id) relevantPhotoIds.add(link.survey_photo_id);
        if (photo) relevantPhotoIds.add(photo.id);
        const relatedPhotos = data!.photos.filter((ph: any) => relevantPhotoIds.has(ph.id));
        const relatedMarks = data!.markings.filter((m: any) => relevantPhotoIds.has(m.survey_photo_id));
        const preview = photoDrafts[c.id];
        const form = forms[c.id] || (item ? initialForm(item) : null);
        const syncing = busyId === c.id;
        const queued = draftQueue[c.id];
        const saved = !!c.replacement_saved_at && !queued;
        return <section key={c.id} className="rounded-2xl border border-slate-200 bg-white p-3 shadow-sm">
          <div className="flex items-start justify-between gap-2"><div className="min-w-0"><h2 className="text-sm font-semibold text-slate-900">{index + 1}. {photo ? 'Replace marked photo' : (item?.work_type_name || item?.material || 'Correct measurement')}</h2><p className="mt-0.5 text-xs text-slate-500">{c.issue_type === 'measurement' ? 'Measurement correction' : 'Photographic evidence correction'}</p></div><span className={`shrink-0 rounded-full px-2 py-1 text-[10px] font-semibold ${saved ? 'bg-emerald-50 text-emerald-700' : queued ? 'bg-blue-50 text-blue-700' : 'bg-amber-50 text-amber-800'}`}>{saved ? 'Saved' : queued ? (queued.payload.ready ? 'Queued' : 'Draft') : 'Needs correction'}</span></div>
          {c.note && <p className="mt-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-900"><strong>Reviewer feedback:</strong> {c.note}</p>}
          {item && <div className="mt-3 rounded-lg bg-slate-50 p-2.5 text-xs"><strong>{item.work_type_name || item.material || 'Work item'}</strong><p className="mt-1 text-slate-600">Previously submitted: {itemSizeLabel(item, 'survey')} · Quantity {item.survey_quantity ?? 1}</p>{item.survey_notes && <p className="mt-1 text-slate-600">{item.survey_notes}</p>}</div>}
          {photo && !item && (() => { const relatedIds = (data!.markings || []).filter((m: any) => m.survey_photo_id === photo.id && m.work_item_id).map((m: any) => m.work_item_id);
            const affected = data!.items.filter((work: any) => relatedIds.includes(work.id));
            return affected.length > 0 ? <div className="mt-3 rounded-xl bg-slate-50 p-3 text-xs"><p className="font-semibold text-slate-800">Work items on this photo</p>{affected.map((work: any) => <div key={work.id} className="mt-2 flex items-start justify-between gap-2"><span className="font-medium text-slate-700">{work.work_type_name || work.material || 'Work item'}</span><span className="shrink-0 text-slate-600">{itemSizeLabel(work,'survey')} · Qty {work.survey_quantity || 1}</span></div>)}</div> : null; })()}
          {!!relatedPhotos.length && <div className="mt-3"><p className="mb-2 text-xs font-semibold text-slate-600">Submitted marked evidence</p><MarkedPhotoGrid photos={relatedPhotos} markings={relatedMarks} workItems={data!.items} /></div>}
          {photo && !saved && <div className="mt-3 space-y-3">
            <div className="flex items-center gap-2">
              <label className="flex flex-1 cursor-pointer items-center justify-center gap-2 rounded-xl bg-blue-700 px-3 py-2.5 text-sm font-semibold text-white"><Camera className="h-4 w-4" /> Take photo<input type="file" accept="image/*" capture="environment" className="sr-only" onChange={(e) => { const file = e.target.files?.[0]; if (file) void pickPhoto(c, photo, file); e.target.value = ''; }} /></label>
              <label className="cursor-pointer rounded-xl border border-slate-300 px-3 py-2.5 text-xs font-semibold text-slate-700">Gallery<input type="file" accept="image/*" className="sr-only" onChange={(e) => { const file = e.target.files?.[0]; if (file) void pickPhoto(c, photo, file); e.target.value = ''; }} /></label>
            </div>
            {preview && <div className="space-y-3"><p className="text-xs text-slate-600">Re-mark every board on the new image. Existing markings remain available above for reference.</p>{preview.markings.length > 1 && <div className="flex flex-wrap gap-1.5">{preview.markings.map((mark, i) => <button key={mark.id} type="button" onClick={() => setActiveBoard((previous) => ({ ...previous, [c.id]: i }))} className={`rounded-lg border px-3 py-1.5 text-xs font-medium ${(activeBoard[c.id] || 0) === i ? 'border-blue-700 bg-blue-50 text-blue-700' : 'border-slate-200 text-slate-600'}`}>Board {i + 1}{mark.points.length >= 3 ? ' ✓' : ''}</button>)}</div>}
              {preview.markings.length > 0 && (() => { const i = Math.min(activeBoard[c.id] || 0, preview.markings.length - 1); const mark = preview.markings[i]; return <BoardMarkerCanvas key={mark.id} photoUrl={preview.dataUrl} points={mark.points} onChange={(pts) => void updateMark(c, i, pts)} colorIndex={i} otherPointsSets={preview.markings.filter((_,j)=>j!==i).map((m)=>m.points)} label={`Board ${i + 1} of ${preview.markings.length}`} />; })()}
              <button type="button" disabled={syncing || preview.markings.some((mark) => mark.points.length < 3)} onClick={() => void saveDraft(c, { ...preview, organizationId: profile!.organization_id })} className="w-full rounded-xl bg-blue-700 px-3 py-2.5 text-sm font-semibold text-white disabled:opacity-40">{syncing ? 'Saving…' : 'Save replacement and markings'}</button>
            </div>}
          </div>}
          {!photo && item && !saved && form && <div className="mt-3 space-y-3">
            <div className="grid grid-cols-2 gap-2">
              <label className="text-xs text-slate-600">Width<input type="number" min="0" inputMode="decimal" value={form.width} onChange={(e) => setForms((prev) => ({ ...prev, [c.id]: { ...form, width: e.target.value } }))} className="mt-1 w-full rounded-lg border px-2 py-2.5 text-sm" /></label>
              <label className="text-xs text-slate-600">Width unit<select value={form.unit} onChange={(e) => setForms((prev) => ({ ...prev, [c.id]: { ...form, unit: e.target.value } }))} className="mt-1 w-full rounded-lg border px-2 py-2.5 text-sm">{LENGTH_UNIT_OPTIONS.map((u) => <option key={u.value} value={u.value}>{u.label}</option>)}</select></label>
              <label className="text-xs text-slate-600">Height<input type="number" min="0" inputMode="decimal" value={form.height} onChange={(e) => setForms((prev) => ({ ...prev, [c.id]: { ...form, height: e.target.value } }))} className="mt-1 w-full rounded-lg border px-2 py-2.5 text-sm" /></label>
              <label className="text-xs text-slate-600">Height unit<select value={form.heightUnit || form.unit} onChange={(e) => setForms((prev) => ({ ...prev, [c.id]: { ...form, heightUnit: e.target.value } }))} className="mt-1 w-full rounded-lg border px-2 py-2.5 text-sm">{LENGTH_UNIT_OPTIONS.map((u) => <option key={u.value} value={u.value}>{u.label}</option>)}</select></label>
            </div>
            <label className="block text-xs text-slate-600">Quantity<input type="number" min="1" inputMode="numeric" value={form.quantity} onChange={(e) => setForms((prev) => ({ ...prev, [c.id]: { ...form, quantity: e.target.value } }))} className="mt-1 w-full rounded-lg border px-2 py-2.5 text-sm" /></label>
            <label className="block text-xs text-slate-600">Notes<input value={form.notes} onChange={(e) => setForms((prev) => ({ ...prev, [c.id]: { ...form, notes: e.target.value } }))} className="mt-1 w-full rounded-lg border px-2 py-2.5 text-sm" /></label>
            <button type="button" disabled={syncing || !(Number(form.width)>0 && Number(form.height)>0 && Number(form.quantity)>=1)} onClick={() => void saveDraft(c, { ...form, heightUnit: form.heightUnit || form.unit })} className="w-full rounded-xl bg-blue-700 px-3 py-2.5 text-sm font-semibold text-white disabled:opacity-40">{syncing ? 'Saving…' : 'Save updated measurement'}</button>
          </div>}
          {queued?.payload.ready && <button type="button" onClick={() => { attempted.current.delete(c.id); void syncOne(queued); }} disabled={!online || syncing} className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-blue-700 disabled:opacity-40"><RefreshCw className="h-3.5 w-3.5" /> Retry upload</button>}
        </section>;
      })}
      {errorText && <div role="alert" className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-xs text-rose-800">{errorText}</div>}
      <button disabled={!complete || submitting || !online} onClick={() => void submit()} className="w-full rounded-xl bg-emerald-700 px-3 py-3 text-sm font-semibold text-white disabled:bg-slate-300 disabled:text-slate-600">{submitting ? 'Submitting…' : complete ? 'Submit corrected items for review' : 'Save all returned items to submit'}</button>
    </div>
  </div>;
}
