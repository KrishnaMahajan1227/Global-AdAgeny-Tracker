# Installation Review Fix v5

This revision makes installation review authoritative at the Work Item level.

## Installer
- Every submitted Work Item needs at least one mapped installation photo.
- A Work Item can be marked Not Installed / Site Unavailable with a required reason and optional note.
- Not-installed Work Items still require photo evidence and remain excluded from installed quantity, sq.ft and billing calculations.
- Redo only reopens the exact returned Work Item(s).
- A redo resubmission requires a new replacement photo captured after the correction was created.

## Owner / Admin Installation Review
- Each pending Work Item supports three independent decisions: Approve, Redo, Reject.
- Approve accepts the Work Item. Installed metrics become billable only for actually-installed active Work Items.
- Approving a Not Installed item accepts the exception but keeps it excluded from calculations.
- Redo creates an exact correction task for the assigned installer and keeps already-approved Work Items intact.
- Reject is final for that Work Item, removes it from executable scope and keeps it excluded from calculations.
- A shop remains in Pending Review only while at least one Work Item is pending.
- When no pending Work Items remain, any Redo returns the shop to the installer; otherwise the review closes.
- Multi-shop selection supports bulk Approve / Redo / Reject for all currently-pending Work Items in selected shops.

## Shop Details
- Installation proofs are fetched directly and mapped by work_item_id.
- Not-installed evidence is labelled separately.
- Approved / Redo / Rejected Work Item decisions are reflected on the installation evidence.

## Required migration
Run all pending Supabase migrations. The new migration is:
`20261022160000_0092_work_item_installation_review_state.sql`
