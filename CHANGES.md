# Breadcrumb restoration — targeted hotfix

**Only functional change:** restore the last-three-visited-pages breadcrumbs to the agency top header, immediately left of Notification Bell.

Affected source: `src/components/AdminLayout.tsx` only.

The patch adds React Router `Link`, `useEffect`, `ChevronRight`, recent navigation state and storage handling, and the header `<nav>` region. It does **not** modify sidebar items, Work Orders, Supply Only logic, create/edit/delete, routes, roles, or database.

## Application

Run `APPLY_ONLY_BREADCRUMBS.ps1` from an extracted ZIP folder (in PowerShell). It calls an idempotent, anchor-checked edit script to preserve any unrelated changes to your existing source file. Backups go into `.git/adroute-patch-backups` and won't be accidentally committed. Alternatively `src/components/AdminLayout.tsx` is included as a ready file **only when your local version exactly matches the immediately preceding Work Orders ZIP**; prefer the installer.

## Validation

The hotfix script and TypeScript/TSX syntax have been checked on the immediately preceding Work Orders ZIP. Full project build and live browser verification require local project dependencies and were not performed here.

Manual check: visit Work Orders → Survey Review → Clients; confirm three clickable breadcrumb labels next to the Notification Bell. On refresh, current tab's history should remain for the session. Verify Supply Orders is still absent from sidebar and the Work Orders filter remains unchanged.
