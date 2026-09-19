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
