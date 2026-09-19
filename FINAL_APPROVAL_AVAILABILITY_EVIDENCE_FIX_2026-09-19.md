# Final approval / evidence / site-availability update

- Shop Details now fetches item-level survey + installation review decisions and shows APPROVED / REDO directly beside the exact Work Item evidence.
- Review decisions are realtime-invalidated so single/bulk approvals reflect without a manual hard refresh.
- Installer can mark a specific approved Work Item as **Not available** (renovation, site blocked, permission, scope removed, etc.) with a reason and optional note.
- Unavailable applies only to that Work Item, never the whole shop. It can be restored with **Make available**.
- Unavailable Work Items keep survey/design/history but clear installed measurements and are excluded from installed/billing calculations.
- Installer camera/gallery choices only include active installable Work Items.
- Final installation writes installed dimensions/area only for active installable Work Items.
- Shop Details shows a clear amber NOT INSTALLED · EXCLUDED state and the field reason/note.
- Client report area totals ignore excluded Work Items.

Migration: `20261022103000_0087_work_item_site_availability.sql`
