# Global Client–Agency Platform — Full New Architecture

**Goal:** Aaj jo system single-agency ke liye bana hai (Agency apna org, apne clients, apne POs), usko ek **Global multi-tenant platform** me convert karna hai jahan:
- **Client** sabse **top** par baithega — apna khud ka login/dashboard hoga.
- Client PO/campaign create karke ek ya multiple **Agency** ko assign kar sakta hai.
- Agency ka existing operational flow (Survey → Design → Production → Installation → Billing) **bilkul waisa hi** chalega, bas ab wo Client-assigned PO par bhi kaam karegi.
- **Dono tarike** ek saath support honge: (1) Client khud PO banake Agency ko assign kare, (2) Agency khud apne client ko onboard karke khud hi kaam kare (jaise aaj hai).

---

## 1. Naya Hierarchy (Top to Bottom)

```
PLATFORM (aapka SaaS)
 │
 ├── CLIENT ORGANIZATION  (naya tenant type)
 │     ├── Client Admin (sabse top — full visibility)
 │     ├── Client Finance/Billing viewer
 │     └── Client Viewer (read-only, field team ke liye)
 │
 └── AGENCY ORGANIZATION  (existing org, jaisa aaj hai)
       ├── agency_owner
       ├── admin
       ├── client_manager   (agency-side coordinator — ab "Account Manager" bolenge)
       ├── surveyor
       ├── designer
       ├── printing
       ├── installer
       └── accounts
```

**Key idea:** `organizations` table ab do "type" ki honi chahiye — `org_type: 'client' | 'agency'`. Dono independent logins hain. Ek **relationship table** unko jodegi.

---

## 2. Naye Data Model Changes (Supabase)

### 2.1 `organizations` — extend
```sql
alter table organizations add column org_type text not null default 'agency'
  check (org_type in ('agency','client'));
```

### 2.2 Naya table: `client_agency_links`
Ye table define karega ki konsa Client kis-kis Agency se juda hai (many-to-many, kyunki ek Client multiple agencies use kar sakta hai, aur ek Agency multiple clients ke liye kaam karti hai).
```sql
create table client_agency_links (
  id uuid primary key default gen_random_uuid(),
  client_org_id uuid references organizations(id),   -- Client organization
  agency_org_id uuid references organizations(id),   -- Agency organization
  status text check (status in ('invited','active','paused','revoked')) default 'invited',
  invited_by uuid references profiles(id),
  created_at timestamptz default now()
);
```
- Client "Invite Agency" karega (code/email/phone se) → Agency accept kare → status `active`.
- Ya Agency khud Client ko invite kar sakti hai apne existing client ko platform par onboard karne ke liye.

### 2.3 `purchase_orders` — extend
```sql
alter table purchase_orders add column origin text check (origin in ('client_created','agency_created')) default 'agency_created';
alter table purchase_orders add column client_org_id uuid references organizations(id); -- naya, actual client tenant (agar client-led)
alter table purchase_orders add column assigned_agency_id uuid references organizations(id); -- kaunsi agency ko assign hua
alter table purchase_orders add column assignment_status text check (assignment_status in ('pending_acceptance','accepted','rejected','in_progress','completed')) default 'accepted';
```
- Purana `client_id` (jo `clients` table ka tha, agency ke andar ka internal client record) **retain** hoga — agency-led flow ke liye same rahega.
- Naya `client_org_id` — jab Client khud login karke PO banata hai, tab uska actual organization id yahan aayega.
- Dono flows ek hi `purchase_orders` table se chalenge, sirf `origin` field se pata chalega ki kaha se aaya.

### 2.4 Har downstream table (shops, work_items, campaigns, invoices) already `purchase_order_id` se linked hain — unme koi structural change nahi chahiye, wo automatically PO ke through Client tak "roll up" ho jayenge.

### 2.5 RLS (Row Level Security) — naya principle
- **Agency users**: apni `organization_id` ka data dekhein (jaisa aaj hai) — chahe PO client-created ho ya agency-created, jab tak `assigned_agency_id = apna org` hai.
- **Client users**: sirf apni `client_org_id` wale POs + un POs ke through jude shops/campaigns/invoices dekhein — cross-agency bhi (agar unhone 3 agencies ko kaam diya hai to teeno ka data ek jagah).
- Client ko **kabhi bhi** agency ke internal cost/margin/vendor rate data nahi dikhna chahiye — sirf **client-facing fields**: status, %, PO qty vs done qty, images, billing/invoice status.

---

## 3. Do Flow, Ek Hi System

### Flow A — **Client-Led** (naya)
1. Client Admin login karta hai apne Client Organization me.
2. "New Campaign / PO" banata hai — locations, work type, budget, timeline daalta hai.
3. Linked agencies me se ek (ya multiple, location/zone-wise split karke) ko **assign** karta hai.
4. Agency ko notification milta hai → Accept/Reject.
5. Accept hone ke baad, PO agency ke normal pipeline me chala jata hai (Survey → Design → Production → Install → Billing) — **exactly** jaisa aaj hota hai.
6. Client apne dashboard se **real-time progress** dekhta rehta hai (agla section me).

### Flow B — **Agency-Led / Self-Service** (jaisa aaj hai, as-is)
1. Agency khud apna internal `clients` record banati hai (jaise ab hai).
2. Agency khud PO create karti hai, khud hi survey/design/install/billing karti hai.
3. Optionally, agency chahe to is client ko **"upgrade to platform client"** kar sakti hai — ek invite bhejke — taaki us client ko bhi apna dashboard mil jaye (read-only login), bina operational flow disturb kiye.

**Dono flows same backend tables use karte hain** — sirf entry point alag hai. Isse "Global" system ban jata hai jisme purana agency-only mode bhi chalta rahega aur naya client-first mode bhi.

---

## 4. Client Dashboard — Screens & IA

Client-side app minimal aur bahut clean rakhna hai — sirf jo unko chahiye:

### 4.1 Top-level Nav
- **Overview** (home)
- **Campaigns / POs**
- **Map Feed**
- **Billing**
- **Agencies** (jinko kaam diya hai)
- **Reports**

### 4.2 Overview (Home)
KPI cards top par:
- Total Active Campaigns/POs
- Total Sites (planned vs live vs completed)
- Overall completion % (installed / total ordered)
- Billing summary: Invoiced ₹ / Paid ₹ / Pending ₹
- Agency-wise split (mini cards: Agency A – 60% done, Agency B – 30% done)

### 4.3 Campaigns / PO List (sabse important screen)
Table/card view, har row me:
| PO Number | Agency Assigned | Campaign/Project | Sites (Total) | Work Done % | Status | Billing Status | Last Update |

**Filters (sorted, easy):**
- Agency (dropdown, multi-select)
- Status: Pending Acceptance / In Progress / Completed / On Hold
- Billing Status: Not Invoiced / Invoiced / Paid / Overdue
- Date range (PO date / expected completion)
- City / State / Zone
- Work Type (Hoarding, Wall Paint, Digital, etc.)
- Search by PO number / site name

Click on a PO → **PO Detail Page**:
- Header: PO#, Agency, dates, total value, GST, payment terms
- Progress bar: Survey → Design → Production → Installation → Billing (stage-wise %)
- Line items table (work type, qty ordered vs qty completed, rate)
- Site-wise list with status chips + thumbnail photo
- Linked map (mini) showing only this PO's sites
- Document/invoice attachments

### 4.4 **Map Feed** (as maanga gaya hai — "map feed with proper all details")
Full-screen map, sabhi sites ek saath pins ke roop me:
- Pin color-coded by status (grey = pending, yellow = in-progress, green = installed, red = issue)
- Pin shape/icon by work type
- Click pin → popup card:
  - Site name, address, city
  - Agency name + PO number + Campaign name
  - Current stage (Survey done? Design approved? Installed?)
  - Photos (before/after)
  - Assigned installer/agency team (optional, agency decide kitna expose karna hai)
  - Billing status for this line item
- **Filters panel** on side (same as list): Agency, Status, Work type, Date range, Zone/City — map real-time filter ho.
- Cluster view jab zoom-out ho (bahut saare pins ek jagah).
- Route/heat view optional for density.

### 4.5 Billing
- Client-wide invoice list: Invoice#, PO#, Agency, Amount, Status (Pending/Paid/Overdue), Due Date
- Agency-wise outstanding summary
- Download invoice PDFs

### 4.6 Agencies
- List of linked agencies, status (active/invited/paused)
- "+ Invite New Agency" button
- Per-agency performance snapshot: on-time %, sites done, avg turnaround

### 4.7 Reports
- Campaign performance export (Excel/PDF)
- Photo compliance report
- Burndown chart (as already built — `poBurndown.ts`, `BurndownChart.tsx` — reuse for client view too, scoped)

---

## 5. Agency Dashboard — Kya Naya Add Hoga

Agency ka existing flow same rahega, bas ek naya section:

- **"Client Requests" inbox**: naye client-created POs jo accept/reject karne hain.
- PO list me ek naya column/badge: **Origin** — "Client-Assigned" vs "Self-Onboarded", taaki Account Manager pehchan sake.
- Owner Console me ek toggle: kaunse clients "platform-linked" hain vs sirf internal record hain.

---

## 6. Notifications / Handshake Flow

1. Client creates/assigns PO → Agency gets in-app + push notification: "New PO from [Client] — Accept/Reject"
2. Agency accepts → Client gets notification: "PO Accepted, work started"
3. Stage change (survey done, design approved, installed) → Client dashboard auto-updates (realtime via `useRealtimeInvalidate.ts`, already exists — extend subscription to client-scoped views)
4. Billing milestone (invoice raised/paid) → Client notified

---

## 7. Permissions Matrix (summary)

| Data | Client Admin | Client Viewer | Agency (assigned) | Other Agencies |
|---|---|---|---|---|
| Own PO status/progress | ✅ Full | ✅ Read-only | ✅ Full (edit) | ❌ |
| Site photos/map | ✅ | ✅ | ✅ | ❌ |
| Agency internal cost/vendor rates | ❌ | ❌ | ✅ | ❌ |
| Billing/invoices | ✅ | ✅ (view) | ✅ | ❌ |
| Assign new PO to agency | ✅ | ❌ | — | — |
| Accept/Reject PO | ❌ | ❌ | ✅ | ❌ |

---

## 8. Rollout Plan (Phase-wise)

**Phase 1 — Data model:** `org_type`, `client_agency_links`, PO fields (`origin`, `client_org_id`, `assigned_agency_id`, `assignment_status`) + RLS policies.

**Phase 2 — Agency side:** "Invite this client to platform" button in existing Owner Console / Shops pages; Client Requests inbox for accept/reject.

**Phase 3 — Client app:** Naya login/role (`client_admin`, `client_viewer`), Overview, Campaigns/PO list with filters, PO detail page.

**Phase 4 — Map Feed:** Client-scoped map reusing existing `FieldMapPage.tsx` / `BoardMarkerCanvas.tsx` logic, filtered to client's POs across all agencies.

**Phase 5 — Billing visibility:** Client-facing invoice/payment status view (reuse `BillingPage.tsx` logic, scoped).

**Phase 6 — Notifications & realtime polish, reports/export.**

---

## 9. Design Principle for Screens

- Har list screen ka pattern same: **KPI cards on top → filter bar → sortable table/card list → detail drill-down**.
- Filters hamesha collapsible top bar me, "Clear all" ke saath.
- Status hamesha color-coded chips (grey/yellow/green/red) — text ke saath, sirf color se dependency nahi.
- Mobile-first (existing app PWA hai) — map aur list dono responsive.
- Client side minimal fields dikhaye, agency-internal complexity hide rahe — "easy to use, easy to understand" is priority.

---

Isse aapka current single-agency tool bina apna operational core (survey→design→production→install→billing) tode, ek **true multi-tenant, Global Client+Agency platform** ban jayega, aur dono use-case (Client-led ya Agency self-service) same system me chalenge.
