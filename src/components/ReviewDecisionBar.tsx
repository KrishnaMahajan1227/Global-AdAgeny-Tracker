import { useEffect, useState } from 'react';
import { Check, RotateCcw, XCircle } from 'lucide-react';
import type { ShopReviewDecision, ShopReviewAction } from '@/lib/reviewDecisionQueue';

type Props = {
  shopId: string;
  stage: 'survey' | 'installation';
  evidenceReady: boolean;
  decision?: ShopReviewDecision;
  disabled?: boolean;
  onDecide: (choice: ShopReviewDecision) => void;
  onClear: () => void;
};

/** One decision per shop. Item/photo corrections remain available in the gallery above. */
export function ReviewDecisionBar({ shopId, stage, evidenceReady, decision, disabled = false, onDecide, onClear }: Props) {
  const [reason, setReason] = useState('');
  const [intent, setIntent] = useState<'redo' | 'reject' | null>(null);
  useEffect(() => { setReason(decision?.note || ''); setIntent(null); }, [shopId]);
  function queue(action: ShopReviewAction) {
    if (disabled) return;
    if (action !== 'approve' && !reason.trim()) { setIntent(action); return; }
    onDecide({ action, note: action === 'approve' ? '' : reason.trim() });
    setIntent(null);
  }
  return <section aria-label="Decision for current shop" className="sticky bottom-0 z-20 rounded-xl border border-blue-200 bg-white/95 p-3 shadow-md backdrop-blur space-y-2">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <p className="text-xs font-semibold text-slate-800">Decision for this shop <span className="font-normal text-slate-500">· item-wise corrections can be submitted above</span></p>
      {decision && <span role="status" className={`rounded-full px-2 py-1 text-xs font-semibold ${decision.action === 'approve' ? 'bg-emerald-100 text-emerald-800' : decision.action === 'reject' ? 'bg-red-100 text-red-800' : 'bg-amber-100 text-amber-900'}`}>
        {decision.action === 'approve' ? 'Queued: Approve' : decision.action === 'redo' ? 'Queued: Redo' : 'Queued: Final reject'}
      </span>}
    </div>
    {decision && decision.action !== 'approve' && <p className="rounded-lg bg-amber-50 px-2.5 py-1.5 text-xs text-amber-900"><strong>{decision.action === 'reject' ? 'Final rejection reason:' : 'Correction instructions:'}</strong> {decision.note}</p>}
    <div className="flex flex-wrap gap-2">
      <button type="button" disabled={disabled || !evidenceReady} onClick={() => queue('approve')} className="inline-flex items-center gap-1 rounded-lg bg-emerald-600 px-3 py-2 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:opacity-40"><Check className="h-4 w-4" />Approve & next</button>
      <button type="button" disabled={disabled} onClick={() => { setIntent('redo'); if (decision?.action === 'redo') setReason(decision.note); }} className="inline-flex items-center gap-1 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-900 disabled:opacity-40"><RotateCcw className="h-4 w-4" />Redo shop</button>
      {stage === 'survey' && <button type="button" disabled={disabled} onClick={() => { setIntent('reject'); if (decision?.action === 'reject') setReason(decision.note); }} className="inline-flex items-center gap-1 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs font-semibold text-red-800 disabled:opacity-40"><XCircle className="h-4 w-4" />Final reject</button>}
      {decision && <button type="button" disabled={disabled} onClick={() => { onClear(); setIntent(null); }} className="rounded-lg px-3 py-2 text-xs font-semibold text-slate-600 underline disabled:opacity-40">Undo queued decision</button>}
    </div>
    {intent && <div className="flex flex-wrap gap-2 rounded-lg border border-amber-200 bg-amber-50 p-2">
      <label className="min-w-[180px] flex-1 text-xs font-medium text-slate-700">{intent === 'reject' ? 'Why is this entire survey permanently rejected?' : 'What exactly must the field team redo?'}
        <input autoFocus value={reason} onChange={e => setReason(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && reason.trim()) { e.preventDefault(); queue(intent); } }} placeholder={intent === 'reject' ? 'Required final rejection reason' : 'Required correction instructions'} className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm" maxLength={1500}/>
      </label>
      <div className="flex items-end gap-2">
        <button type="button" disabled={disabled || !reason.trim()} onClick={() => queue(intent)} className="rounded-lg bg-slate-900 px-3 py-2 text-xs font-semibold text-white disabled:opacity-40">Queue {intent === 'reject' ? 'rejection' : 'redo'} & next</button>
        <button type="button" onClick={() => setIntent(null)} className="px-2 py-2 text-xs text-slate-600">Cancel</button>
      </div>
    </div>}
    {!evidenceReady && <p className="text-xs text-amber-700">Approval unavailable until evidence loads. You can still send this shop for redo with a reason.</p>}
    <p className="text-[11px] text-slate-500">Queued decisions are not saved until “Submit decisions”. Company approval and server validations are not skipped.</p>
  </section>;
}
