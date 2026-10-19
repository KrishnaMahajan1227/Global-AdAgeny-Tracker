import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Download, FileText, ShieldCheck, AlertTriangle } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { useRealtimeInvalidate } from '@/lib/useRealtimeInvalidate';
import { exportCompanyApprovalPack, getCompanyApprovalStatus, saveCompanyApprovalAction, type CompanyApprovalStage } from '@/lib/companyApproval';

type Props = { stage: CompanyApprovalStage; refId: string; shopId: string };
/** Shared review handoff. Does not replace granular item review or auto-approve work. */
export function CompanyApprovalHandoff({stage,refId,shopId}:Props) {
  const {profile} = useAuth();
  const qc=useQueryClient();
  const [reference,setReference]=useState('');
  const [exporting,setExporting]=useState<'pdf'|'ppt'|null>(null);
  const [message,setMessage]=useState('');
  const permitted=profile?.role==='agency_owner'||profile?.role==='admin';
  useRealtimeInvalidate(['company_approval_handoffs'],profile?.organization_id,[['phase2-company-approval',stage,refId],['agency-operations-dashboard',profile?.organization_id]],15000);
  const {data,isPending,isError,error,refetch}=useQuery({queryKey:['phase2-company-approval',stage,refId],queryFn:()=>getCompanyApprovalStatus(stage,refId),enabled:permitted && !!refId,staleTime:8000});
  const action=useMutation({mutationFn:({kind,ref}:{kind:'internal_checked'|'company_approved';ref?:string})=>saveCompanyApprovalAction(stage,refId,kind,ref),onSuccess:()=>{setMessage('');void qc.invalidateQueries({queryKey:['phase2-company-approval',stage,refId]});void qc.invalidateQueries({queryKey:['company-approval-queue']});}});
  if (!permitted) return null;
  if (isPending) return <p role="status" className="rounded-lg bg-slate-50 p-3 text-xs text-slate-600">Checking company-approval requirements…</p>;
  if (isError) return <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-800">Company approval could not be verified. Do not finalise this work until approval data loads. {(error as Error).message} <button onClick={()=>void refetch()} className="font-semibold underline">Retry</button></div>;
  if (!data?.required) return <p className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-slate-500">Historical Work Order: the new company-approval gate is not applied retroactively. Existing review rules remain in effect.</p>;
  const confirmed=data.valid;
  const checked=data.status==='internal_checked';
  const stale=data.status==='evidence_changed';
  async function exportPack(format:'pdf'|'ppt') {setExporting(format);setMessage('');try{await exportCompanyApprovalPack({stage,refId,shopId,format});}catch(e){setMessage(e instanceof Error?e.message:'Export failed');}finally{setExporting(null);}}
  return <section aria-label="Company approval handoff" className="rounded-xl border border-blue-200 bg-blue-50/50 p-3 text-sm">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="flex items-center gap-2"><ShieldCheck size={17} className="text-blue-700"/><strong className="text-slate-900">Company approval</strong></div>
      <span className={`rounded-full px-2 py-1 text-[11px] font-semibold ${confirmed?'bg-emerald-100 text-emerald-800':checked?'bg-amber-100 text-amber-800':'bg-white text-slate-700'}`}>{confirmed?'Confirmed':checked?'Awaiting external confirmation':stale?'Evidence changed · recheck':'Internal evidence check needed'}</span>
    </div>
    <p className="mt-2 text-xs text-slate-600">Review photos and measurements on this page. Share the pre-filled approval pack outside Adroute; record the company response here. Existing final review buttons complete the stage afterward.</p>
    {stale && <p role="alert" className="mt-2 flex items-center gap-2 text-xs font-medium text-amber-800"><AlertTriangle size={15}/> Evidence changed since the last check. Re-review and regenerate the report.</p>}
    <div className="mt-3 flex flex-wrap items-center gap-2">
      <button type="button" disabled={!!exporting} onClick={()=>void exportPack('pdf')} className="inline-flex min-h-9 items-center gap-1 rounded-lg border border-slate-200 bg-white px-3 text-xs font-semibold text-slate-800 hover:bg-slate-50 disabled:opacity-50"><FileText size={14}/> {exporting==='pdf'?'Preparing…':'PDF'}</button>
      <button type="button" disabled={!!exporting} onClick={()=>void exportPack('ppt')} className="inline-flex min-h-9 items-center gap-1 rounded-lg border border-slate-200 bg-white px-3 text-xs font-semibold text-slate-800 hover:bg-slate-50 disabled:opacity-50"><Download size={14}/> {exporting==='ppt'?'Preparing…':'PPT'}</button>
      {!confirmed && !checked && <button type="button" disabled={action.isPending} onClick={()=>action.mutate({kind:'internal_checked'})} className="inline-flex min-h-9 items-center rounded-lg bg-blue-700 px-3 text-xs font-semibold text-white hover:bg-blue-800 disabled:opacity-50">{action.isPending?'Saving…':'Evidence reviewed · Send for approval'}</button>}
      {confirmed && <span className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-700"><CheckCircle2 size={15}/> Company approval recorded · Final review may proceed</span>}
    </div>
    {checked && <div className="mt-3 flex flex-wrap items-end gap-2 border-t border-blue-100 pt-3">
      <label className="min-w-40 flex-1 text-xs font-medium text-slate-700">Company approval reference (optional)
        <input value={reference} maxLength={240} onChange={e=>setReference(e.target.value)} placeholder="Email / WhatsApp reference" className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs"/>
      </label>
      <button type="button" disabled={action.isPending} onClick={()=>{if(window.confirm('Confirm that the company has approved this exact evidence/report outside Adroute?'))action.mutate({kind:'company_approved',ref:reference});}} className="min-h-9 rounded-lg bg-emerald-700 px-3 text-xs font-semibold text-white hover:bg-emerald-800 disabled:opacity-50">{action.isPending?'Saving…':'Record company approval'}</button>
    </div>}
    {data?.revision && <p className="mt-2 text-[11px] text-slate-500">Evidence revision {data.revision}{data.company_approved_at?` · Confirmed ${new Date(data.company_approved_at).toLocaleString('en-IN')}`:''}{data.reference?` · ${data.reference}`:''}</p>}
    {(message||action.isError) && <p role="alert" className="mt-2 text-xs text-red-700">{message||(action.error as Error).message}</p>}
  </section>;
}
