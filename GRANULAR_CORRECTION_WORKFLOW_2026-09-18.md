# Granular Survey + Installation Corrections

- Added `field_corrections` migration/table.
- Survey Review: Request Correction can mark exact measurement(s) and/or survey photo(s), each with its own note.
- The correction is assigned back to the same surveyor already assigned to that shop.
- Surveyor sees a Correction-only card listing only the requested issues; resubmission marks those tasks resubmitted.
- Installation Review: Reject/Redo now requires selecting exact Work Item(s) and/or installation photo(s), each with its own note.
- The same assigned installer receives the correction.
- Only rejected installation proofs are removed; accepted proofs remain in DB/storage and continue to be valid evidence.
- Installer correction mode shows only affected Work Items in Approved Installation Details.
- Resubmission marks correction tasks resubmitted; final approval resolves them.

Deploy DB migration with: `npx supabase db push --include-all`
