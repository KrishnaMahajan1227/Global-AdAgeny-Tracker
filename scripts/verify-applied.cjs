const fs=require('fs'),path=require('path');
const root=path.resolve(process.argv[2]||process.cwd());
const files={
  'src/lib/workCompletion.ts':['groupShopCompletion','isShopFinished','orderOperationalPercent'],
  'src/pages/PurchaseOrdersPage.tsx':['shopCompletionByPo','physicalCompletion','<Modal open={!!po}'],
  'src/pages/DashboardPage.tsx':['ordersOperationalPercent(own, byOrder)','refetchInterval: 20000'],
  'src/pages/ShopsPages.tsx':['groupShopCompletion','pct}% delivery'],
  'src/pages/AgencyHierarchyPage.tsx':['ordersOperationalPercent(targetOrders, progress)','orderOperationalPercent(o,progress.get(o.id))'],
  'src/pages/WorkProgressPage.tsx':['isShopFinished(flowByOrder.get(s.purchase_order_id),s.status)'],
};
let errors=0;
for(const [file,markers] of Object.entries(files)){
  const abs=path.join(root,file);
  if(!fs.existsSync(abs)){console.error('MISSING '+file);errors++;continue;}
  const txt=fs.readFileSync(abs,'utf8');
  for(const marker of markers)if(!txt.includes(marker)){console.error('NOT APPLIED '+file+': '+marker);errors++;}
  if(markers.every(m=>txt.includes(m)))console.log('OK '+file);
}
if(errors){console.error(`FAILED: ${errors} incomplete patch markers. Do not push.`);process.exit(1)}
console.log('Agency progression source changes present. Still requires npm build, browser test and Vercel deployment.');
