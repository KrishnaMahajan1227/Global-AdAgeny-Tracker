# REQUIRED staging security test matrix (NOT RUN)

Use *separate real Supabase Auth sessions* for each role/tenant, not service_role. Call Supabase REST/PostgREST directly (not just navigate the React UI). Verify both HTTP authorization outcomes and that no rows/fields are returned. Every test is **PENDING** until a real staging DB and QA identities exist.

| ID | Caller | Direct API / URL test | Expected result |
|---|---|---|---|
| A01 | Logged out / anon | GET `/rest/v1/profiles?select=*` | No private profiles |
| A02 | Logged out / anon | RPC `get_login_email_by_phone`, `get_shared_shop_view` | Permission denied; no identity or evidence returned |
| A03 | Regular worker | PATCH own `profiles` setting `role=agency_owner` | Blocked, role unchanged |
| A04 | Regular worker | PATCH own `profiles.organization_id` to a different tenant | Blocked |
| A05 | Owner, org A | PATCH another owner or superadmin role | Blocked |
| A06 | Deactivated user, valid previous JWT | GET any org table and sign Storage file | Blocked immediately |
| A07 | Any org-A worker | GET `/rest/v1/shops?organization_id=eq.<orgB>` | No org-B rows |
| A08 | Surveyor A | GET `/rest/v1/shops?id=eq.<unassigned shop in A>` | No row |
| A09 | Installer A | GET unassigned installation jobs/proofs | No row |
| A10 | Designer A | GET another designer's shops, designs, work items | No row |
| A11 | Printing A | GET another printer's shops, productions | No row |
| A12 | Demo | GET actual non-demo shop/client by UUID | No row |
| A13 | Client admin A | GET another client org's POs, shops, proofs and invoices | No unrelated record |
| A14 | Client admin A | POST pending PO with another agency's internal client_id | Rejected |
| A15 | Client admin A | PATCH linked `client_agency_links.status=active` | Rejected |
| A16 | Surveyor | INSERT invoice, PO money, shop or another surveyor's photo | Rejected |
| A17 | Designer | INSERT file to `design-files/<org>/<unassigned-task>/...` | Rejected |
| A18 | Installer | INSERT private file to another org/job path | Rejected |
| A19 | Any user | Anonymous HTTP GET `/storage/v1/object/public/survey-photos/...` | Not public; no bytes returned |
| A20 | Assigned worker | Valid signed URL / private read for their own uploaded photo | Succeeds when authorized |
| A21 | Cross-role/unassigned user | `createSignedUrl` for another user's photo | Denied |
| A22 | Office owner | Upload/read/replace/delete site evidence as permitted | Succeeds and logs appropriately |
| A23 | Accounts | Invoice create/edit/delete and cross-org spoofed org/client foreign keys | Valid own org succeeds; spoofed cross-org rejected |
| A24 | Client admin | Own draft PO + line items; own linked agency only | Succeeds; unrelated agency denied |
| A25 | Field roles | Offline survey/installation photos upload and sync, redo shop-id path | Succeeds for assigned work only |
| A26 | Agency owner | Create/edit/deactivate/restore team account, password reset | Valid actions work, audit recorded |
| A27 | Superadmin | Aggregate platform workload without raw tenant finances | Metrics only, no tenant financial records |
| A28 | Any role | Browser deep-link to another role's admin/billing/field route | Redirect to own permitted screen |
| A29 | Role switch in same browser | React Query/cache and media signed-url cache | Old org data gone, no data flashes |
| A30 | All roles | Full role journeys: survey→design→print→dispatch→install→billing, duplicate actions | Exact transitions and role controls |
| A31 | Finance | Payment status change after invoice locked; concurrent duplicate invoice attempt | Correct restrictions / no duplicate |
| A32 | Platform operator | Change prohibited org business fields via `/rest/v1/organizations` | Rejected |
| A33 | Valid worker | Try direct UPDATE altering route_stop shop_id or worker_locations.user_id | Rejected |
| A34 | Guest vs authenticated | HTML routes, Storage signed URLs, browser cache, previously created share link | No information disclosure |
| A35 | All roles | Network timeout, reconnect, multiple tabs, refresh, logout | No leaked state; no orphan file links |
| A36 | Admin + owner | Existing 9 migrations apply in order to clone with historical data | Clean apply and correct legacy data |

**Important:** Verify older `SECURITY DEFINER` RPCs and SQL `VIEW` ownership/grants; restrictive base-table RLS may be bypassed by definer views and RPCs that must implement their own tenant and role checks. New policies are defense-in-depth, not a replacement for server checks on RPCs.
