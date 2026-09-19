import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, CheckCircle2, Camera, Loader2, AlertCircle } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { LENGTH_UNIT_OPTIONS, toFeet, formatDim } from '@/lib/units';
import { submitCorrections, refreshReviewViews } from '@/lib/reviewApi';

/**
 * Surveyor "Fix Redo" screen. Only the items Owner/Admin sent back are shown; each is fixed IN PLACE
 * (same work item / same photo row), so nothing is duplicated and approved work stays untouched.
 */
export function SurveyCorrectionFixer({ shopId, onExit }: { shopId: string; onExit: () => void }) {
  const { profile } = useAuth();
  const qc = useQueryClient();
  const [saved, setSaved] = useState<Set<string>>(new Set());
  const [busyId, setBusyId] = useState<string | null>(null);
  const [err, setErr] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [forms, setForms] = useState<Record<string, { w: string; h: string; unit: string; qty: string; notes: string }>>({});

  const { data: shop } = useQuery({ queryKey: ['shop', shopId], queryFn: async () => (await supabase.from('shops').select('name').eq('id', shopId).maybeSingle()).data });
  const { data } = useQuery({
    queryKey: ['survey-field-corrections', shopId, profile?.id, 'fixer'],
    queryFn: async () => {
      const { data: corr, error } = await supabase.from('field_corrections').select('*').eq('shop_id', shopId).eq('stage', 'survey').eq('assigned_to', profile!.id).eq('status', 'open').order('created_at');
      if (error) throw error;
      const wiIds = (corr || []).map((c: any) => c.work_item_id).filter(Boolean);
      const phIds = (corr || []).map((c: any) => c.survey_photo_id).filter(Boolean);
      const [wi, ph] = await Promise.all([
        wiIds.length ? supabase.from('work_items').select('*').in('id', wiIds) : Promise.resolve({ data: [] as any[] }),
        phIds.length ? supabase.from('survey_photos').select('*').in('id', phIds) : Promise.resolve({ data: [] as any[] }),
      ]);
      return { corr: corr || [], items: (wi.data || []) as any[], photos: (ph.data || []) as any[] };
    }, enabled: !!profile?.id,
  });

  const form = (it: any) => forms[it.id] || { w: String(formatDim(it.survey_width) ?? ''), h: String(formatDim(it.survey_height) ?? ''), unit: 'ft', qty: String(it.survey_quantity ?? 1), notes: it.survey_notes || '' };
  const setForm = (id: string, patch: Partial<ReturnType<typeof form>>, it: any) => setForms((f) => ({ ...f, [id]: { ...form(it), ...(f[id] || {}), ...patch } }));

  async function saveItem(it: any, corrId: string) {
    const f = form(it); setBusyId(corrId); setErr('');
    try {
      const w = toFeet(parseFloat(f.w), f.unit), h = toFeet(parseFloat(f.h), f.unit), q = Math.max(1, parseInt(f.qty) || 1);
      if (!(w > 0) || !(h > 0)) throw new Error('Sahi width aur height daliye.');
      const { error } = await supabase.from('work_items').update({ survey_width: w, survey_height: h, survey_unit: 'ft', survey_quantity: q, survey_area: Math.round(w * h * q * 100) / 100, survey_notes: f.notes || null }).eq('id', it.id);
      if (error) throw error;
      setSaved((s) => new Set(s).add(corrId));
    } catch (e: any) { setErr(e.message || String(e)); } finally { setBusyId(null); }
  }

  async function replacePhoto(photo: any, corrId: string, file: File) {
    if (!profile) return; setBusyId(corrId); setErr('');
    try {
      const safe = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
      const path = `${profile.organization_id}/${photo.survey_id}/${Date.now()}-fix-${safe}`;
      const up = await supabase.storage.from('survey-photos').upload(path, file);
      if (up.error) throw up.error;
      const url = supabase.storage.from('survey-photos').getPublicUrl(path).data.publicUrl;
      const { error } = await supabase.from('survey_photos').update({ storage_path: path, photo_url: url }).eq('id', photo.id);
      if (error) { await supabase.storage.from('survey-photos').remove([path]); throw error; }
      if (photo.storage_path) await supabase.storage.from('survey-photos').remove([photo.storage_path]);
      setSaved((s) => new Set(s).add(corrId));
      await qc.invalidateQueries({ queryKey: ['survey-field-corrections'] });
    } catch (e: any) { setErr(e.message || String(e)); } finally { setBusyId(null); }
  }

  async function submit() {
    setSubmitting(true); setErr('');
    try { await submitCorrections('survey', shopId); await refreshReviewViews(qc, shopId); setDone(true); }
    catch (e: any) { setErr(e.message || String(e)); } finally { setSubmitting(false); }
  }

  const corr = data?.corr || [];
  const allSaved = corr.length > 0 && corr.every((c: any) => saved.has(c.id));

  if (done) return (
    <div className="min-h-screen flex items-center justify-center p-6 max-w-md mx-auto"><div className="bg-white rounded-2xl border p-8 text-center w-full">
      <CheckCircle2 className="w-14 h-14 text-green-500 mx-auto mb-3" /><h2 className="text-lg font-bold">Corrections submit ho gaye</h2>
      <p className="text-sm text-slate-500 mt-1 mb-5">Owner/Admin ab sirf theek kiye hue items dobara check karenge.</p>
      <button onClick={onExit} className="w-full bg-blue-600 text-white py-3 rounded-lg font-medium">Done</button></div></div>
  );

  return (
    <div className="min-h-screen bg-slate-50 max-w-md mx-auto pb-24">
      <div className="bg-white border-b p-4 flex items-center gap-3 sticky top-0 z-30">
        <button onClick={onExit}><ChevronLeft className="w-5 h-5" /></button>
        <div><p className="font-semibold text-slate-900">Fix Redo · {shop?.name}</p><p className="text-xs text-slate-500">{corr.length} item wapas aaye hain</p></div>
      </div>
      <div className="p-4 space-y-3">
        {corr.length === 0 && <p className="text-sm text-slate-500">Koi open redo nahi hai.</p>}
        {corr.map((c: any) => {
          const it = data!.items.find((x: any) => x.id === c.work_item_id);
          const ph = data!.photos.find((x: any) => x.id === c.survey_photo_id);
          const isSaved = saved.has(c.id);
          return (
            <div key={c.id} className={`rounded-2xl border p-3 bg-white ${isSaved ? 'border-emerald-300' : 'border-amber-300'}`}>
              <div className="flex items-center gap-2 mb-2"><AlertCircle className="w-4 h-4 text-amber-600" /><p className="text-sm font-semibold">{ph ? 'Survey photo dobara lein' : `Measurement theek karein — ${it?.work_type_name || ''}`}</p>{isSaved && <span className="ml-auto text-[10px] font-bold text-emerald-700 bg-emerald-100 rounded-full px-2 py-0.5">FIXED</span>}</div>
              {c.note && <p className="text-xs text-amber-800 bg-amber-50 rounded-lg px-2 py-1.5 mb-2">Reviewer: {c.note}</p>}
              {ph && <>
                <img src={ph.photo_url} alt="" className="w-full max-h-56 object-contain bg-slate-100 rounded-lg border" />
                <label className="mt-2 w-full flex items-center justify-center gap-2 bg-blue-600 text-white text-sm font-medium py-2.5 rounded-lg cursor-pointer">
                  {busyId === c.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <Camera className="w-4 h-4" />} Nayi photo lein / upload karein
                  <input type="file" accept="image/*" capture="environment" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) void replacePhoto(ph, c.id, f); e.currentTarget.value = ''; }} />
                </label></>}
              {it && !ph && (() => { const f = form(it); return <div className="space-y-2">
                <div className="grid grid-cols-3 gap-2">
                  <label className="text-[11px] text-slate-500">Width<input value={f.w} onChange={(e) => setForm(it.id, { w: e.target.value }, it)} inputMode="decimal" className="w-full border rounded-lg px-2 py-2 text-sm" /></label>
                  <label className="text-[11px] text-slate-500">Height<input value={f.h} onChange={(e) => setForm(it.id, { h: e.target.value }, it)} inputMode="decimal" className="w-full border rounded-lg px-2 py-2 text-sm" /></label>
                  <label className="text-[11px] text-slate-500">Unit<select value={f.unit} onChange={(e) => setForm(it.id, { unit: e.target.value }, it)} className="w-full border rounded-lg px-1 py-2 text-sm bg-white">{LENGTH_UNIT_OPTIONS.map((u: any) => <option key={u.value} value={u.value}>{u.label || u.value}</option>)}</select></label>
                </div>
                <label className="text-[11px] text-slate-500 block">Quantity<input value={f.qty} onChange={(e) => setForm(it.id, { qty: e.target.value }, it)} inputMode="numeric" className="w-full border rounded-lg px-2 py-2 text-sm" /></label>
                <label className="text-[11px] text-slate-500 block">Notes<input value={f.notes} onChange={(e) => setForm(it.id, { notes: e.target.value }, it)} className="w-full border rounded-lg px-2 py-2 text-sm" /></label>
                <button disabled={busyId === c.id} onClick={() => void saveItem(it, c.id)} className="w-full bg-slate-900 text-white text-sm font-medium py-2.5 rounded-lg disabled:opacity-50">{busyId === c.id ? 'Saving…' : 'Save measurement'}</button></div>; })()}
            </div>
          );
        })}
        {err && <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg p-2">{err}</p>}
        <button disabled={!allSaved || submitting} onClick={() => void submit()} className="w-full bg-green-600 text-white font-semibold py-3.5 rounded-xl disabled:opacity-40">{submitting ? 'Submitting…' : allSaved ? 'Submit corrections for review' : 'Pehle saare items fix karein'}</button>
      </div>
    </div>
  );
}
