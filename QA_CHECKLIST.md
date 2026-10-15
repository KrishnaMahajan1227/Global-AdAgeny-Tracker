# QA CHECKLIST — Run on staging before production

- [ ] `npm ci` completes and `npm run typecheck`, `npm run lint`, `npm run build` each exit 0.
- [ ] Tablet 768px and phones 320/375/400px: camera fills an appropriate area without excessive black margins; close works.
- [ ] Surveyor: tap Take Photo, shutter opens the marking editor without a second Use Photo confirmation; Gallery selection also opens marking immediately.
- [ ] One photo with two/three independent boards; switching tabs shows other outlines and preserves separate work types, dimensions and quantity.
- [ ] Several photos, each with multiple markings; reopen after app restart and confirm the same active photo/editor and marks reappear.
- [ ] A missing polygon, zero/negative width, missing height, invalid quantity or orphaned photo prevents Submit Survey and shows a useful error.
- [ ] Remove one board vs remove whole photo: both show in-app confirmation, preserve unrelated boards and photos.
- [ ] Check offline capture, reload, reconnect, photo sync and duplicate prevention; verify remote survey_photos and board_markings counts and IDs.
- [ ] Survey/Installer views contain no PO budget, area totals, running-total charts or money figures; owner Work Orders still shows correct totals.
- [ ] 10 ft × 6 in × 3 boards tallies as 15 sq.ft; 1m × 100cm tallies as 10.7639 sq.ft, entered dimensions display as entered.
- [ ] Direct Install: record width 12in and height 1m; installed_width is 1 ft, installed_height ~3.28084 ft, entered units in/m remain visible.
- [ ] Redo: measurement width 6 in and height 2 ft; after 0092 staging migration, current row is updated in place and original input units remain correct.
- [ ] Redo: 1 photo / multiple boards replacement updates the original photo + mark IDs; old storage object is retained, no duplicate live rows.
- [ ] Submitted survey/installation read-only views display relevant marked reference images and proofs (no cropping) and original dimensions.
- [ ] Installer photo removal from each step uses the same confirmation + server/local handler; accidental thumbnail tap never deletes.
- [ ] Submit is blocked while local installer uploads/replacements are pending; reconnect retry verifies database rows before clearing local blobs.
- [ ] Owner/admin, surveyor, installer RLS and direct URL access tested with separate staging accounts.
- [ ] Browser console has no errors; real-time status/review counts update on other devices.
