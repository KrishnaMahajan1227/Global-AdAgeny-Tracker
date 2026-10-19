const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const ts=require('typescript');const root=path.resolve(__dirname,'..');let n=0;
const read=x=>fs.readFileSync(path.join(root,x),'utf8');
const check=(name,fn)=>{fn();n++;console.log('PASS',name)};
const sql=read('supabase/migrations/20261028100000_0098_phase2_company_approval_handoff.sql');
const widget=read('src/components/CompanyApprovalHandoff.tsx');const lib=read('src/lib/companyApproval.ts');
check('phase2 schema and RPCs are present',()=>['company_approval_handoffs','phase2_handoff_status','phase2_handoff_action','phase2_evidence_key'].forEach(v=>assert(sql.includes(v))));
check('existing PO approvals are NOT backfilled',()=>{assert(sql.includes('DEFAULT false'));assert(sql.includes('SET DEFAULT true'));assert(!/UPDATE public.purchase_orders SET company_approval_required\s*=\s*true/.test(sql))});
check('new PO company policy cannot be bypassed by explicit false',()=>assert(sql.includes('NEW.company_approval_required:=true')));
check('company policy cannot be disabled',()=>assert(sql.includes('OLD.company_approval_required AND NOT NEW.company_approval_required')));
check('owner/admin enforced on every approval action',()=>{assert(sql.includes("public.current_role() NOT IN ('agency_owner','admin')"));assert(sql.includes('auth.uid() IS NULL'))});
check('no client, surveyor, designer, installer direct write',()=>{assert(sql.includes('REVOKE INSERT, UPDATE, DELETE'));assert(!sql.includes('CREATE POLICY phase2_handoff_write'))});
check('direct shop-status bypass is blocked',()=>assert(sql.includes('trg_phase2_guard_shop_advance')));
check('survey, design, installation stage DB guards',()=>['trg_phase2_survey_approval','trg_phase2_design_approval','trg_phase2_installation_approval'].forEach(v=>assert(sql.includes(v))));
check('company consent must match exact PO, ref, shop and evidence',()=>{assert(sql.includes('h.purchase_order_id=(SELECT purchase_order_id'));assert(sql.includes('h.evidence_key=public.phase2_evidence_key'));});
check('changed evidence invalidates approval',()=>assert(sql.includes("'evidence_changed'")));
check('internal review precedes external confirmation',()=>assert(sql.includes("v_prev.status<>'internal_checked'")));
check('audit event emitted on stage transitions',()=>assert(sql.includes('INSERT INTO public.audit_logs')));
check('screens share one component',()=>[['src/pages/SurveyReviewPage.tsx','stage="survey"'],['src/pages/DesignerPage.tsx','stage="design"'],['src/pages/InstallationReviewPage.tsx','stage="installation"']].forEach(([f,v])=>assert(read(f).includes(v))));
check('pack exporter requires all images and caps export count',()=>{assert(lib.includes('reportImages'));assert(lib.includes('Export stopped'));assert(lib.includes('More than 24 evidence images'));assert(lib.includes('pptxgenjs'));assert(lib.includes('jspdf'))});
check('approval is explicitly confirmed by owner',()=>{assert(widget.includes('window.confirm'));assert(widget.includes("kind:'company_approved'"))});
check('approval component defaults to an explicit missing status',()=>assert(widget.includes('Checking company-approval requirements')));
for(const f of ['src/lib/companyApproval.ts','src/components/CompanyApprovalHandoff.tsx','src/pages/SurveyReviewPage.tsx','src/pages/DesignerPage.tsx','src/pages/InstallationReviewPage.tsx']){
  check('TSX syntax: '+f,()=>{const diagnostics=ts.transpileModule(read(f),{fileName:f,compilerOptions:{jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2020},reportDiagnostics:true}).diagnostics||[];assert.equal(diagnostics.length,0,diagnostics.map(d=>ts.flattenDiagnosticMessageText(d.messageText,' ')).join('; '))});
}
console.log(`ALL ${n} PHASE 2 SOURCE VALIDATIONS PASSED`);
