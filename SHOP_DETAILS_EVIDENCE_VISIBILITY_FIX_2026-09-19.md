# Shop Details evidence visibility hardening — 2026-09-19

- Installation proofs are fetched directly by `shop_id`, independent of nested PostgREST relations.
- Proofs from historical/superseded installation jobs remain visible after approval/stage reset.
- Proofs whose `work_item_id` points to a superseded/deleted work item are shown under Legacy / unmapped evidence instead of disappearing.
- Survey mappings are only considered mapped when they target a current work item; stale mappings fall back to visible legacy evidence.
- No approval action deletes approved evidence. Shop Details is treated as an audit/evidence surface.
