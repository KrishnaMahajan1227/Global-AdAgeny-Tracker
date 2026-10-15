# AdRoute — Field UX Targeted Update

Modified files:
- src/pages/SurveyorPage.tsx — surveyor My Work filters, survey photo flow, submission viewer
- src/pages/InstallerPage.tsx — installer My Work filters and submission viewer
- src/components/FieldNavigation.tsx — mobile field navigation

Notes:
- Extract into the project root (where package.json exists). Back up your current files first.
- No SQL or database migration included.
- This patch has NOT passed a complete local Vite build or live-browser workflow test because dependencies could not be installed in the environment.
- Do not deploy to production without npm ci, npm run typecheck, npm run lint, npm run build and role/offline/photo QA.
