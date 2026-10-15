# Focused survey-review / navigation audit

- Agency survey queue: `src/pages/SurveyReviewPage.tsx` (only `/survey-review` screen).
- Shared item decisions: `src/lib/reviewApi.ts` invoking `review_apply` RPC; unchanged.
- Marking renderer: `src/lib/markingUtils.ts` with `renderMarkedImage`, polygon and board labels; reused and unchanged.
- Previous repeated UI: photo gallery, measurement table, item-review list and PO Budget Check coexisting in one modal. Replaced with one evidence gallery and removed PO Budget Check from review.
- Survey review can have multiple work items linked to one photo, multiple photos per item, unlinked photos/items, previous approvals and redo history.
- Bulk approve: each survey has an independent atomic server transaction; batch is sequential, not a cross-shop transaction.
- Sidebar: AdminLayout previously used a fixed `calc(100vh - 200px)` height on scrollable nav and absolute bottom user card. Converted to a flex column with scrollable middle and fixed-sized header/footer.
- Header: Notification Bell unchanged; last three actual page visits added on its left via session-scoped history.
