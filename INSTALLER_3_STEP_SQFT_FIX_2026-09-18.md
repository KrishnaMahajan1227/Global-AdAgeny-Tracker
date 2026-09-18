# Installer 3-step + historical sq.ft normalization
- Installer job flow reduced to Shop -> Photos -> Review & Final Submit.
- Vehicle/material-load confirmation removed from installer flow.
- Installer assignment list no longer shows material details; focus is shop + Start Install.
- Approved work items are actionable: tap a work item to open camera directly with that item preselected.
- Gallery upload keeps an explicit work-item selector because gallery files need mapping context.
- Camera and gallery installation evidence are normalized to landscape before upload.
- Geo stamp uses shop/site name, shop address/city/state and stored shop coordinates; installer live-location status is not shown in UI.
- Historical work-item migration 0084 converts non-ft survey/approved/installed dimensions to feet and recalculates sq.ft including quantity.
- New application writes continue to normalize measurements through src/lib/units.ts.
