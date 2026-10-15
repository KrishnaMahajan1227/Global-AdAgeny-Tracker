# FIELD_QA_CHECKLIST.md

## Automated/static checks in this environment
- [x] TypeScript/TSX transpilation syntax: 12 affected TS/TSX files reported 0 parsing diagnostics.
- [x] New SQL source inspected: no DROP TABLE, TRUNCATE, evidence-row deletion or storage delete.
- [x] Patch file paths and ZIP integrity checked.
- [ ] `npm ci`, `npm run typecheck`, `npm run lint`, `npm run build`: full local dependency environment unavailable; not passed.
- [ ] Actual SQL migration in staging/production: not executed.
- [ ] Real device and Supabase access / RLS / browser console: not tested.

## Mandatory manual tests before production
- [ ] Surveyor and Installer: login, correct client and owner-defined Work Order names, search/filter combinations, role-isolated shops, status transitions, browser refresh and navigation.
- [ ] Surveyor: camera capture opens mark screen immediately; one photo with 3+ distinct polygons; second photo with separate polygons; mixed-unit measurements; offline suspend/resume; exact database links.
- [ ] Surveyor redo: measurement only; photo only; photo with multiple boards; both together; old marked photo shown during redo; new marks replace same IDs; owner current evidence updated once; historical file path in audit log.
- [ ] Installer redo: previous proof, exact work item and approved marked reference shown; offline replacement photo saved locally; reconnect; old proof ID updated without extra active copy; review sent only after all corrections saved.
- [ ] Submitted read-only: surveyor/installer reopen own completed shop, inspect every photo and relevant notes, no editable actions until redo.
- [ ] Installer normal capture: multiple photos, each mapped work item, offline photo queue, internet loss mid-upload, automatic retry, refresh with pending photos, no duplicates, safe discard.
- [ ] UI: 320/375/400/768 widths, compact actions, modal cancel/confirm and keyboard navigation, small deletions away from primary buttons, no native localhost alert dialogs.
- [ ] Parent agency: Survey Review and Installation Review show updated current proofs/marks, work-item totals unchanged outside the returned items, historical audit records readable, realtime refresh.
- [ ] Staging DB backup/restore rehearsal and no data or migration conflicts.
