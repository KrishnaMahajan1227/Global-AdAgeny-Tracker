from pathlib import Path
import re,sys
root=Path(sys.argv[1]).resolve()
if not (root/'package.json').exists(): raise SystemExit('ERROR: invalid project root')
changes=[]
def update(path,fn):
 p=root/path
 if not p.exists(): raise SystemExit(f'ERROR: missing {path}')
 s=p.read_text(encoding='utf-8'); t=fn(s)
 if t==s: print('SKIP (not applicable/already updated):',path);return
 p.write_text(t,encoding='utf-8');changes.append(path);print('FIXED:',path)
def exact(s,a,b,name):
 if a not in s:
  if b in s:return s
  raise RuntimeError(f'{name}: expected source not found; refusing unsafe edit')
 return s.replace(a,b,1)
def gallery(s):
 return exact(s,'void submit(confirm)','void submit(confirm === \'approve\' ? \'approved\' : \'redo\')','gallery review action')
def dash(s):
 return exact(s,'((batch || []) as Record<string, unknown>[])','((batch || []) as unknown as Record<string, unknown>[])','Supabase inferred error typing')
def installer(s):
 return s.replace('item.notes','(item as typeof item & { notes?: string | null }).notes') if 'item.notes' in s else s
def surveyor(s):
 return exact(s,'markings={boardMarkings} workItems={workItems}','markings={boardMarkings} workItems={workItems}','placeholder') if False else s
# Supplier field intentionally absent in legacy storage; don't add it to fallback select.
def installation(s):
 # TS infers mandatory work_item_id from first response. Explicitly use a compatible intersection in fallback only.
 pat=r'(response\s*=\s*await\s+supabase\.from\([\'\"]installation_proofs[\'\"]\)[\s\S]*?\.select\([\'\"]id,\s*storage_path,\s*photo_url,\s*photo_type,\s*angle[\'\"]\)[\s\S]*?;)' 
 m=re.search(pat,s)
 if m:
  v=m.group(1)
  # Only type-cast the fallback, do not pretend work_item_id exists at runtime.
  return s[:m.start()]+v[:-1].replace('response = await','response = (await',1)+') as unknown as typeof response;'+s[m.end():]
 return s
def reports(s):
 s=re.sub(r'ev\.addImage\(imageId,\{tl:\{col:2\.05,row:row\.number-0\.92\},br:\{col:2\.93,row:row\.number-0\.03\},editAs:\'oneCell\'\}\);',"ev.addImage(imageId, { tl: new ExcelJS.Anchor(ev, { col: 2.05, row: row.number - 0.92 }), br: new ExcelJS.Anchor(ev, { col: 2.93, row: row.number - 0.03 }), editAs: 'oneCell' });",s)
 # avoid exported ExcelJS Anchor constructor namespace mismatch: use typed cell range instead.
 s=s.replace("ev.addImage(imageId, { tl: new ExcelJS.Anchor(ev, { col: 2.05, row: row.number - 0.92 }), br: new ExcelJS.Anchor(ev, { col: 2.93, row: row.number - 0.03 }), editAs: 'oneCell' });","ev.addImage(imageId, `C${row.number}:D${row.number + 1}`);")
 s=s.replace('slide.addTable([headers,...rows],','slide.addTable([headers,...rows].map(cells => cells.map(text => ({ text: String(text) }))),')
 return s
update('src/components/SurveyReviewGallery.tsx',gallery)
update('src/pages/DashboardPage.tsx',dash)
update('src/pages/InstallerPage.tsx',installer)
update('src/lib/installationSync.ts',installation)
update('src/lib/reportPortfolio.ts',reports)
# BoardMarking photo viewer only uses survey_photo_id/work_item_id/points; widen its prop type instead of forging database fields.
def marked(s):
 return exact(s,'markings: BoardMarking[]; workItems: WorkItem[]','markings: Pick<BoardMarking, \'survey_photo_id\' | \'work_item_id\' | \'points\'>[]; workItems: WorkItem[]','viewer marking types').replace('new Map<string, BoardMarking[]>()',"new Map<string, Pick<BoardMarking, 'survey_photo_id' | 'work_item_id' | 'points'>[]>()")
update('src/components/MarkedPhotoGrid.tsx',marked)
print('Modified',len(changes),'files')
