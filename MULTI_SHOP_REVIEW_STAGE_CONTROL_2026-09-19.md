# Multi-shop review + shop stage control

## Installation Review
- Multi-select now opens one professional Review Selected Shops workspace.
- Every selected shop is kept in its own expandable section with its own Survey → Measurement → Design → Installation evidence.
- Approve/Redo remains scoped to the exact evidence selected inside that exact shop.
- A shop remains Pending Review until its complete required evidence is approved.
- Cross-shop visual mixing is avoided by explicit numbered shop sections and per-shop evidence controls.

## Shops list
- Selection mode is available from the page header; selected rows get a persistent bulk action bar.
- Added Change Stage for one or many selected shops.
- For a single shop, the Status badge itself is an Owner/Admin shortcut to Change Shop Stage.
- Stage selector includes the full shop pipeline from Pending through Billing/Cancelled.
- Existing database approval gates remain authoritative; invalid forced transitions (notably Installed before installation approval) are rejected rather than bypassed.
- After stage changes, shop/detail/dashboard/navigation/review/functional queue query caches are invalidated so the new state is picked up immediately.
