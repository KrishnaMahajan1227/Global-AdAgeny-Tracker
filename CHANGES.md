# Vercel build syntax fix

- `src/pages/DashboardPage.tsx`: fixed broken JSX quote on the client table pagination Next button (reported at line 75).
- No other source files modified. No database or dependency changes.

Validation: TypeScript TSX parser reports zero syntax diagnostics for `DashboardPage.tsx`, `App.tsx`, and `AgencyHierarchyPage.tsx`. Full Vite build/lint/typecheck not run because project dependencies are incomplete in this environment.
