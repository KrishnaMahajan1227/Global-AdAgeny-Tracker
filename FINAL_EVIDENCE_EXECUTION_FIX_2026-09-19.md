# Final evidence + non-executed work hardening

- Shop Details now fetches installation jobs and installation proofs independently by shop, avoiding nested PostgREST relationship-cache failures that could hide photos.
- Survey/install proof changes and review decisions invalidate Shop Details in realtime.
- Photo-level APPROVED/REDO badges are rendered directly on evidence thumbnails.
- Legacy/unmapped survey and installation evidence is still shown in a dedicated evidence strip instead of silently disappearing.
- Installer keeps a per-work-item Not available / Make available action. Marking unavailable stores reason/note and clears installed measurements.
- DB trigger enforces that excluded work can never regain installed area/quantity from an older/stale client.
- PO utilization/client progress installed totals exclude non-executed work.
- Legacy installation proofs are safely auto-linked when a shop has exactly one work item.
