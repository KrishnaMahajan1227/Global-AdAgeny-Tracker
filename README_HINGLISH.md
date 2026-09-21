# FINAL update — kya karna hai (2 steps)

## Step 1 — Database (sabse zaroori, sirf ek baar)
Supabase → SQL Editor → `RUN_THIS_FIRST.sql` ka poora content paste → RUN.
(Dobara chalane par bhi safe hai.) Iske bina redo / approval / installer submit theek nahi hoga.

## Step 2 — App deploy
`npm install && npm run build` → `dist/` deploy karein (dist already built hai).

## Kya fix hua
- Installer "Final Submit" fail hota tha (DB material-check gate) → ab auto-confirm, submit chalega.
- Redo corrections trigger ki wajah se cancel ho jate the → ab redo Surveyor/Installer ko turant "Fix Redo" me dikhta hai.
- Approval ab ek atomic server call: survey approve → shop design_pending + designer task; installation approve → shop `Installed`; design approve → design_approved. Shop Details me turant reflect (naya "Review & Approval Status" card).
- Item-by-item: ek, kai ya sab items Approve / Redo / Reject-all — Survey, Design aur Installation teeno me.
- Surveyor redo ab usi item ko in-place theek karta hai (duplicate nahi banta) — naya "Fix Redo" screen.
- Site available nahi (renovation etc.): installer / owner / admin item ko "Not available" + reason + comment ke saath mark karte hain. Wo installed sq.ft, qty, PO utilization, billing me count nahi hota; flow chalta rehta hai; sabhi ko notification + Shop Details me reason dikhta hai.
- Survey photos ab hamesha apne work item se link hoti hain; installation photos Shop Details me hamesha dikhti hain.
- Type errors fix, notification links fix.

## Update 2
- Installer: kaam install na ho to popup me reason + site ki photo (zaroori) -> "Not installed", calculation me count nahi.
- Review queue rule: jab tak shop ka koi bhi kaam undecided hai, shop Pending Review me rehta hai. Sab approved -> Installed, aur review se hat jata hai. Sab decide ho gaye aur kuch redo -> "Marked for Redo" me jata hai.
- Multi-shop: selected shops ke liye "Approve all remaining" / "Reject / redo all" ek saath.

## Update 3 — photos wala asli bug
Shop Details `surveys` aur `installation_jobs` ko `profiles(full_name)` se join karta tha; in dono tables ke profiles se 2-3 links hain, isliye Supabase query ambiguity error deti thi aur poori query fail ho jati thi -> survey "—", installation photos 0. Ab `profiles:surveyor_id` / `profiles:installer_id` use hota hai. "Review & Approval Status" card hata diya. RUN_THIS_FIRST.sql dobara chalayein (phantom open redo bhi saaf karta hai).

## Update 4
- Reject/redo all ya approve all par shop ab Pending Review se hat jata hai; modal apne aap band hota hai. Same shop ke duplicate pending rows bhi saath hat jate hain.
- PWA: naya deploy hone par purana version na atke — Vercel par deploy ke baad browser me Application > Service Workers > Unregister karein (ek baar).

## Update 5
- Naya page: **Work Progress** (sidebar) — kitna kaam hua/baaki, stage-wise shops, sq.ft done vs total, not-available count, per shop aur per person (surveyor/installer/designer) progress. Live update.
- Approved/finished shop ab Pending Review me nahi rahega (list filter + SQL cleanup).
- Auto-update: vercel.json me no-cache headers, service worker skipWaiting+clientsClaim, /version.json har 30 sec check; naya deploy aate hi user idle hote hi page apne aap naye version pe reload (cache wipe ke saath). Refresh ki zaroorat nahi.

## Update 6 — sizes & units
- Naye survey me size exactly wahi save/dikhta hai jo surveyor ne dala (inch / ft / m / cm, alag-alag bhi: "10 ft × 6 in") — Installer, Owner/Admin review, Shop Details, Design, Production, photo labels sab jagah.
- Calculation hamesha feet/sq.ft base par; totals (dashboard/progress/reports/billing) Work Order unit (sqft / piece / lot) me.
- Purane surveys ka original unit maloom nahi, isliye wo ft me dikhenge (naye surveys se original unit).
- Installer screen: work name ke saath size bada; "Not available" chhota, subtle control.

## Update 7 — Shop Details
- Work item ka naam ab hamesha bharta hai: saved naam → work type → PO line item → material → "Work Item n" (aur DB trigger bhi khud naam bhar deta hai; purane rows backfill).
- Work Items ka naya professional card design: header (number, naam, size/qty/sq.ft/material/PO chips, status, actions), 4-stage journey (Survey → Approved → Produced → Installed), evidence ke 3 saaf columns, PO line item neeche.
- Installation photos ab Shop Details se bhi upload: har work item me "+ Photos" aur upar "Bulk installation" (har photo ko work item se map karke).

## Update 8 — Shop Details full redesign
- Naya hero header (naam, status, city, PO, phone, works installed n/N).
- Work Items ab sabse upar: summary tiles (total / installed / sq.ft done vs baaki / not available), filters (All, Pending, Installed, Redo, Not available), Expand/Collapse all.
- Har item: collapsed row me naam + size + qty + sq.ft + status + 4-step progress + photo counters; expand karne par stage details, evidence (Survey / Design / Installation) aur PO/BOM/notes.
- Photo viewer: full-screen gallery (arrows, keyboard, thumbnails), ek photo par multiple markings — is item ka marking blue, baaki grey dashed, naam ke saath. Photo fail ho to placeholder + original link.
- Single item shop me unlinked survey/design/installation evidence bhi item par dikhta hai; multi-item me legacy/unmapped section neeche.

## Update 9 — calmer, faster Work Items UI
- Neutral palette (slate + sirf status ke liye chhota dot: green=installed, amber=redo/not available).
- Zero-click evidence: har item me Survey / Design / Installation photos seedha dikhti hain (accordion nahi).
- Ek quiet progress line, ek meta line (size • qty • sq.ft • material • PO), secondary actions ek "⋯" menu me, photo add ke liye "+" icon har group ke saath.

## Update 10
- Add/Edit Work Item: work order line item, work type aur material dropdown; width aur height ke alag-alag unit (ft / inch / m / cm); live area preview.
- Work item card se progress line hata di.
- Shop ki details ab top header me hi (alag card nahi).
- Header me "Stage" dropdown (prefilled current stage, saare stages) — Owner/Admin ke liye; RUN_THIS_FIRST.sql me set_shop_stage function hai.

## Update 11 — approval sync
- Approve ab purane/stale redo decisions ya phantom corrections se nahi atkta; sab approve hote hi shop = Installed, installer assignment = completed.
- Shop Details timeline sirf LATEST installation attempt dekhti hai — approved shop par "Sent back for redo" nahi dikhega.
- RUN_THIS_FIRST.sql purane data repair bhi karti hai (approved job par atke shops -> Installed, installer list me completed).
- Review screen ab batati hai kyu finalize nahi hua (kitne item redo / undecided).

## Update 12 — self-healing installation state
- DB me `reconcile_installation_shop`: jaise hi shop ke saare live work items approved ho jate hain, shop = Installed, job = approved, installer assignment = completed — chahe decision kisi bhi screen/purane code se likha ho (trigger).
- RUN_THIS_FIRST.sql chalate hi aaj atke hue sab shops (jaise "Installation Pending" par atka par 10/10 approved) apne aap Installed ho jate hain.
- Shop Details khulte hi bhi ek silent check chalta hai. Manual stage ko peeche karne par purane installation approvals hat jate hain (taaki wapas Installed na ho jaye).

## Update 13 — shop info in header
- Header me poori info grouped: Contact & location (owner, phone + WhatsApp, signage language, address, village, city, district, state, zone, GPS) aur Work order & record (client, project, PO, fulfilment, added on, extra details). Khaali field "— add" dikhta hai (click = Edit shop).

## Update 14 — units in Excel backfill
- Excel template me naya "Height Unit" column + Unit/Height Unit dropdown (ft, in, m, cm). Blank Height Unit = Unit jitna.
- Unit spellings (feet, inch, inches, meter, cm...) normalize hote hain; galat unit / "10 ft" jaisa text number me = row number ke saath error.
- Backfill se aaye boards me bhi original size/unit save hota hai (Shop Details, Installer, Review sab jagah wahi dikhta hai).
- Manual backfill form me Width unit aur Height unit alag.
- Template ki purani galti theek: 'ft' pehle Height column me pad jata tha.

## Update 15 — Bulk backfill fix
- Ek shop = Shop Name + Phone. Rows ka Work Order / Client / Address / "New Shop?" alag ho to bhi sab ek hi shop me jude (pehle har row alag shop ban-ti thi).
- Har row ka apna Work Order -> us board ki PO line se jud jata hai; Work Type blank ho to Material se work type match hota hai.
- Excel me ab ek hi "Unit" dropdown: ft / in / m / cm ya combo "ft x in" (width ft, height inch). Purani sheet (Height Unit column) bhi chalti hai.
- "Current Status" ab dropdown (project ke saare stages); import ke baad shop ka status wahi ho jata hai. Sirf status badalna ho to Stage/size khaali chhodkar sirf Current Status chuniye.
- Stage/New Shop?/Unit dropdown ab sheet ke andar inline (har Excel/Google Sheets me dikhta hai).
- NAYA template download karein.
