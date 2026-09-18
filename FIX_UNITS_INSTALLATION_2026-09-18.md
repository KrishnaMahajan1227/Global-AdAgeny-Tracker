# AdRoute — Unit Normalization & Installation Proof Fix

- All physical board dimensions now normalize to feet before persistence in the updated survey/backfill/shop-edit paths.
- Area is calculated in square feet with explicit conversion support for ft/feet, in/inch/inches, m/meters, cm and mm aliases.
- Work Order area remains the common comparison/billing unit: sq.ft.
- Installation completion uses approved sq.ft area; its fallback also converts dimensions to sq.ft instead of multiplying raw non-foot values.
- Installer proof upload now checks database insert errors and removes orphaned storage files if metadata cannot be saved.
- Added single/multiple file selection for installation proof. Every selected image is processed sequentially; one failure does not silently discard the rest.
- React photo state uses functional updates, preventing a multi-file batch from repeatedly overwriting the same stale array state.
- Existing camera capture remains available and maps to the selected work item.
- Added compatibility fallback when installation_proofs.work_item_id is not yet visible in PostgREST schema cache.
- Installer-facing Hinglish/Hindi operational copy and voice-input error copy changed to English.
