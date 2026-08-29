export type Role = 'agency_owner' | 'admin' | 'client_manager' | 'surveyor' | 'designer' | 'printing' | 'installer' | 'accounts' | 'demo' | 'client_admin' | 'client_viewer' | 'super_admin';

export interface Profile {
  id: string;
  // Always a real org for every role except 'super_admin' (where it's
  // actually null in the DB — a platform account that sits above every
  // organization). Kept as `string` here rather than `string | null`
  // since every other role treats this as guaranteed, and super_admin
  // never reaches any of those org-scoped pages (route-guarded to its
  // own /superadmin screen only) — widening this type would have forced
  // a defensive null-check into ~25 unrelated call sites for a case that
  // can only ever occur on a page none of them run on.
  organization_id: string;
  full_name: string;
  role: Role;
  phone: string | null;
  is_active: boolean;
  is_demo: boolean;
  // Only meaningful when role === 'client_manager'. Null = unscoped
  // (sees every client, old behaviour). Set = hard-restricted at RLS
  // level to that one client's shops/PO/rate/invoice data.
  client_id: string | null;
  created_at: string;
}

export interface Organization {
  id: string;
  name: string;
  logo_url: string | null;
  address: string | null;
  gst_number: string | null;
  default_currency: string;
  default_unit: string;
  phone: string | null;
  email: string | null;
  // 'agency' = normal agency tenant (existing behaviour). 'client' = a
  // Client Organization tenant — its users can see across every agency
  // they are linked to (see ClientAgencyLink), read-only, via
  // purchase_orders.client_org_id.
  org_type: 'agency' | 'client';
  // Payment/bank details (migration 0064) — shown on the invoice PDF so
  // the client knows how to actually pay. All optional/nullable.
  bank_account_name: string | null;
  bank_name: string | null;
  bank_account_number: string | null;
  bank_ifsc: string | null;
  bank_branch: string | null;
  upi_id: string | null;
  // Short, human-shareable code (migration 0050) an agency hands to a
  // client so the client can self-serve request a link via
  // client_request_agency_link — auto-generated per agency org.
  agency_invite_code: string | null;
}

export interface ClientAgencyLink {
  id: string;
  client_org_id: string;
  agency_org_id: string;
  status: 'invited' | 'active' | 'paused' | 'revoked';
  invited_by: string | null;
  created_at: string;
  // Phase 2 — the agency's own internal `clients` row that represents this
  // client org (auto-created by agency_invite_client_org). Null for a
  // link that hasn't been resolved to a clients record yet.
  agency_client_id: string | null;
  // Convenience fields the UI can hydrate via a join — not columns on the table itself.
  client_org_name?: string;
  agency_org_name?: string;
}

export interface Client {
  id: string;
  organization_id: string;
  name: string;
  contact_person: string | null;
  contact_phone: string | null;
  contact_email: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  gst_number: string | null;
  is_active: boolean;
  is_demo: boolean;
  created_at: string;
}

export interface Project {
  id: string;
  organization_id: string;
  client_id: string;
  name: string;
  description: string | null;
  start_date: string | null;
  end_date: string | null;
  status: string;
  is_demo: boolean;
  created_at: string;
}

export interface PurchaseOrder {
  id: string;
  organization_id: string;
  client_id: string;
  project_id: string | null;
  po_number: string;
  // Optional human-readable label (migration 0067) — e.g. "Q3 Andheri
  // Dealer Boards" — shown alongside po_number everywhere a PO is listed.
  name: string | null;
  po_date: string;
  fulfillment_type: 'survey_install' | 'supply_only';
  storage_path: string | null;
  file_url: string | null;
  total_amount: number | null;
  status: 'active' | 'closed' | 'cancelled';
  notes: string | null;
  payment_terms: string | null;
  gst_percentage: number | null;
  gst_amount: number | null;
  created_by: string | null;
  is_demo: boolean;
  created_at: string;
  // Client + Agency platform fields (Phase 1). For every PO that predates
  // this, origin='agency_created', assigned_agency_id=organization_id,
  // assignment_status='accepted' — i.e. behaves exactly as before.
  origin: 'client_created' | 'agency_created';
  client_org_id: string | null;
  assigned_agency_id: string | null;
  assignment_status: 'pending_acceptance' | 'accepted' | 'rejected' | 'in_progress' | 'completed';
  // The Campaign this PO was added under, if any — only ever set on
  // client-created POs (see Campaign below). Nullable so every
  // pre-existing / agency-created PO is unaffected.
  campaign_id: string | null;
}

// A client-owned grouping level ABOVE the PO: the client decides what
// campaign to run first, then adds one or more POs under it (each PO
// deciding which agency it goes to). Never touched by the agency side —
// an agency's own operational grouping is still just "a PO".
export interface Campaign {
  id: string;
  client_org_id: string;
  name: string;
  description: string | null;
  start_date: string | null;
  end_date: string | null;
  status: 'active' | 'completed' | 'cancelled';
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface POLineItem {
  id: string;
  organization_id: string;
  purchase_order_id: string;
  work_type_id: string | null;
  description: string;
  uom: 'sqft' | 'piece' | 'lot';
  budgeted_qty: number | null;
  budgeted_area: number | null;
  rate: number | null;
  hsn_code: string | null;
  created_at: string;
}

export interface WorkType {
  id: string;
  organization_id: string;
  name: string;
  description: string | null;
  is_active: boolean;
  created_at: string;
}

export interface WorkTypeConsumable {
  id: string;
  organization_id: string;
  work_type_id: string;
  consumable_name: string;
  qty_per_unit: number | null;
  created_at: string;
}

export interface Zone {
  id: string;
  organization_id: string;
  project_id: string | null;
  name: string;
  created_at: string;
}

export interface Shop {
  id: string;
  organization_id: string;
  client_id: string;
  project_id: string | null;
  name: string;
  owner_name: string | null;
  contact_phone: string | null;
  address: string | null;
  city: string | null;
  district: string | null;
  village: string | null;
  zone: string | null;
  zone_id: string | null;
  state: string | null;
  latitude: number | null;
  longitude: number | null;
  signage_language: string | null;
  status: string;
  is_demo: boolean;
  purchase_order_id: string | null;
  // Client-specific custom fields beyond the standard set (e.g. a
  // landmark, GST number, internal site code) — captured during bulk
  // upload when the client's file has columns we don't otherwise
  // recognize. See migration 0054.
  extra_details: Record<string, string>;
  created_at: string;
}

export interface ShopAssignment {
  id: string;
  organization_id: string;
  shop_id: string;
  user_id: string;
  role: string;
  status: string;
  assigned_at: string;
  completed_at: string | null;
}

export interface Route {
  id: string;
  organization_id: string;
  user_id: string | null;
  name: string | null;
  route_date: string;
  status: 'planned' | 'active' | 'completed';
  transport_mode: string | null;
  tracking_reference: string | null;
  zone_id: string | null;
  optimized: boolean;
  total_distance_meters: number | null;
  total_duration_seconds: number | null;
  origin_lat: number | null;
  origin_lng: number | null;
  origin_label: string | null;
  notes: string | null;
  created_at: string;
  // Supply-Only "Confirm to Owner" checkpoint (migration 0045) — flags
  // that an Owner/Admin has actually looked at this dispatch, between
  // Dispatch and Billing. Never blocks billing; visibility only.
  owner_confirmed_at: string | null;
  owner_confirmed_by: string | null;
}

export interface RouteStop {
  id: string;
  organization_id: string;
  route_id: string;
  shop_id: string;
  stop_order: number;
  status: 'pending' | 'visited' | 'skipped';
  leg_distance_meters: number | null;
  leg_duration_seconds: number | null;
  created_at: string;
}

export interface Survey {
  id: string;
  organization_id: string;
  shop_id: string;
  surveyor_id: string;
  status: string;
  gps_lat: number | null;
  gps_lng: number | null;
  gps_accuracy: number | null;
  gps_captured_at: string | null;
  notes: string | null;
  submitted_at: string | null;
  reviewed_at: string | null;
  reviewed_by: string | null;
  review_note: string | null;
  created_at: string;
  updated_at: string;
}

export interface SurveyPhoto {
  id: string;
  organization_id: string;
  survey_id: string;
  shop_id: string;
  storage_path: string;
  photo_url: string;
  caption: string | null;
  photo_type: string;
  created_at: string;
}

export interface WorkItem {
  id: string;
  organization_id: string;
  shop_id: string;
  survey_id: string | null;
  work_type_id: string | null;
  work_type_name: string | null;
  material: string | null;
  survey_width: number | null;
  survey_height: number | null;
  survey_unit: string | null;
  survey_quantity: number | null;
  survey_area: number | null;
  survey_notes: string | null;
  approved_width: number | null;
  approved_height: number | null;
  approved_unit: string | null;
  approved_quantity: number | null;
  approved_area: number | null;
  approved_notes: string | null;
  produced_quantity: number | null;
  produced_notes: string | null;
  produced_at: string | null;
  installed_width: number | null;
  installed_height: number | null;
  installed_unit: string | null;
  installed_quantity: number | null;
  installed_area: number | null;
  installed_notes: string | null;
  installed_at: string | null;
  status: string;
  po_line_item_id: string | null;
  po_variance_note: string | null;
  po_variance_acknowledged_by: string | null;
  po_variance_acknowledged_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface WorkItemComponent {
  id: string;
  organization_id: string;
  work_item_id: string;
  component_name: string;
  required_qty: number | null;
  status: 'pending' | 'in_progress' | 'ready';
  source: 'component' | 'consumable';
  assigned_to: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export const COMPONENT_STATUSES: { value: WorkItemComponent['status']; label: string }[] = [
  { value: 'pending', label: 'Not Started' },
  { value: 'in_progress', label: 'In Progress' },
  { value: 'ready', label: 'Ready' },
];

export interface DesignTask {
  id: string;
  organization_id: string;
  shop_id: string;
  designer_id: string | null;
  status: string;
  notes: string | null;
  assigned_at: string;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface DesignVersion {
  id: string;
  organization_id: string;
  design_task_id: string;
  version_number: number;
  storage_path: string;
  file_url: string;
  file_name: string | null;
  uploaded_by: string;
  notes: string | null;
  status: string;
  source: 'agency_designed' | 'client_provided';
  created_at: string;
}

export interface DesignVersionItem {
  id: string;
  organization_id: string;
  design_version_id: string;
  work_item_id: string;
  created_at: string;
}

export interface ProductionOrder {
  id: string;
  organization_id: string;
  shop_id: string;
  design_task_id: string | null;
  assigned_to: string | null;
  status: string;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface ProductionItem {
  id: string;
  organization_id: string;
  production_order_id: string;
  work_item_id: string | null;
  requested_qty: number | null;
  approved_qty: number | null;
  produced_qty: number | null;
  notes: string | null;
  created_at: string;
}

export interface InstallationJob {
  id: string;
  organization_id: string;
  shop_id: string;
  installer_id: string;
  production_order_id: string | null;
  status: string;
  gps_lat: number | null;
  gps_lng: number | null;
  gps_accuracy: number | null;
  gps_captured_at: string | null;
  exception_reason: string | null;
  exception_note: string | null;
  started_at: string | null;
  completed_at: string | null;
  notes: string | null;
  review_status: string;
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_note: string | null;
  // Section 7 (optional, gOGig-inspired) fraud-proofing — how far the
  // installer's captured GPS was from the shop's stored lat/long.
  // Non-blocking: informational for Admin/Owner at Installation Review.
  gps_distance_meters: number | null;
  gps_distance_flag: boolean;
  // Phase 7 — installer-side loading register (migration 0044).
  material_check_confirmed: boolean;
  material_check_confirmed_by: string | null;
  material_check_confirmed_at: string | null;
  material_check_photo_url: string | null;
  material_check_items: { work_item_id: string; work_type_name: string; approved_quantity: number; loaded_quantity: number }[];
  // Phase 8 — links back to the Production-side vehicle load this job's
  // material check was pre-filled from, if one exists (migration 0062).
  vehicle_load_id: string | null;
  created_at: string;
  updated_at: string;
}

// Phase 8 — Production-side Vehicle Load register (migration 0062).
// A header row per loading event (one shop, one installer, one vehicle)
// plus one VehicleLoadItem per board on that load.
export interface VehicleLoad {
  id: string;
  organization_id: string;
  shop_id: string;
  production_order_id: string | null;
  installer_id: string;
  loaded_by: string;
  vehicle_number: string;
  driver_name: string | null;
  status: 'loaded' | 'delivered' | 'cancelled';
  notes: string | null;
  loaded_at: string;
  delivered_at: string | null;
  delivered_by: string | null;
  // Phase 8b — correlation id (not a FK) shared by every per-shop
  // vehicle_loads row created together in one multi-shop loading action.
  // NULL for single-shop loads created the original way.
  vehicle_trip_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface VehicleLoadItem {
  id: string;
  organization_id: string;
  vehicle_load_id: string;
  work_item_id: string;
  work_type_name: string | null;
  material: string | null;
  qty_ready: number;
  qty_loaded: number;
  created_at: string;
}

// One row per shop from `v_vehicle_load_shop_summary` — ready vs. loaded
// qty side by side, exactly what Production's Vehicle Load tab and the
// Owner/Admin overview render.
export interface VehicleLoadShopSummary {
  shop_id: string;
  organization_id: string;
  shop_name: string;
  shop_city: string | null;
  shop_address: string | null;
  shop_status: string;
  zone_name: string | null;
  client_name: string | null;
  po_number: string | null;
  fulfillment_type: string | null;
  assigned_installer_id: string | null;
  assigned_installer_name: string | null;
  boards_total: number;
  boards_fully_loaded: number;
  total_ready_qty: number;
  total_loaded_qty: number;
  pending_qty: number;
  load_status: 'no_boards' | 'not_loaded' | 'partial' | 'loaded';
  latest_vehicle_load_id: string | null;
  latest_vehicle_number: string | null;
  latest_driver_name: string | null;
  latest_load_status: 'loaded' | 'delivered' | 'cancelled' | null;
  latest_loaded_at: string | null;
  latest_loaded_by_name: string | null;
  latest_installer_name: string | null;
}

export interface VehicleLoadStats {
  shops_not_loaded: number;
  shops_partial: number;
  shops_loaded: number;
  total_ready_qty: number;
  total_loaded_qty: number;
  total_pending_qty: number;
  vehicles_today: number;
  // Phase 8b — distinct loading events today; a multi-shop trip counts
  // once here (grouped by vehicle_trip_id), unlike vehicles_today which
  // counts distinct vehicle numbers and would double-count a vehicle
  // that did two separate trips today, or single-count a multi-shop trip.
  trips_today: number;
}

// Phase 8b — one row per board on any vehicle load, org-wide, from
// `v_vehicle_load_log`. This is the flat "kitna saman load hua, kisne
// kiya, kisko kiya" log Owner/Admin and Production both check reports
// against. Group rows sharing the same (vehicle_trip_id ?? vehicle_load_id)
// to reconstruct one trip/loading-event card — see
// src/lib/vehicleLoadLog.ts.
export interface VehicleLoadLogRow {
  item_id: string;
  vehicle_load_id: string;
  vehicle_trip_id: string | null;
  organization_id: string;
  vehicle_number: string;
  driver_name: string | null;
  status: 'loaded' | 'delivered' | 'cancelled';
  notes: string | null;
  loaded_at: string;
  delivered_at: string | null;
  shop_id: string;
  shop_name: string;
  shop_city: string | null;
  loaded_by: string;
  loaded_by_name: string | null;
  installer_id: string;
  installer_name: string | null;
  delivered_by: string | null;
  delivered_by_name: string | null;
  work_type_name: string | null;
  material: string | null;
  qty_ready: number;
  qty_loaded: number;
}

export interface InstallationProof {
  id: string;
  organization_id: string;
  installation_job_id: string;
  shop_id: string;
  storage_path: string;
  photo_url: string;
  photo_type: string;
  caption: string | null;
  gps_lat: number | null;
  gps_lng: number | null;
  gps_accuracy: number | null;
  // Section 7 — which angle this proof photo covers. Required to be at
  // least 'front' + 'side' before an installation can be submitted.
  angle: 'front' | 'side' | 'other' | null;
  // Section 7 — perceptual hash of the image + duplicate-detection result.
  phash: string | null;
  duplicate_flag: boolean;
  duplicate_of: string | null;
  captured_at: string;
}

// Section 4.2 — standalone Supply Only delivery-destination record.
// Lives alongside the shop-based supply_only pipeline (shop_id links back
// to it); see supabase/migrations/..._0034_supply_destinations.sql for why.
export interface SupplyDestination {
  id: string;
  organization_id: string;
  purchase_order_id: string;
  po_line_item_id: string | null;
  zone_id: string | null;
  shop_id: string | null;
  destination_name: string;
  contact_person: string | null;
  contact_phone: string | null;
  address: string | null;
  quantity: number;
  uom: string;
  status: 'pending' | 'in_production' | 'packed' | 'dispatched' | 'delivered';
  route_id: string | null;
  created_at: string;
}

export interface RateCard {
  id: string;
  organization_id: string;
  client_id: string | null;
  work_type_id: string | null;
  pricing_type: string;
  rate: number;
  is_active: boolean;
  created_at: string;
}

export interface Invoice {
  id: string;
  organization_id: string;
  client_id: string;
  project_id: string | null;
  purchase_order_id: string | null;
  invoice_number: string;
  invoice_date: string;
  due_date: string | null;
  subtotal: number;
  tax_rate: number;
  tax_amount: number;
  // GST breakdown (migration 0071) — tax_rate/tax_amount above stay as the
  // combined total for backward compatibility; these are the actual
  // components a GST-compliant Indian invoice has to itemize.
  cgst_rate: number;
  cgst_amount: number;
  sgst_rate: number;
  sgst_amount: number;
  igst_rate: number;
  igst_amount: number;
  total: number;
  payment_status: string;
  notes: string | null;
  created_at: string;
  // Bill To snapshot (migration 0064) — frozen at create/edit time from the
  // client record, but always owner-editable on the invoice itself so a
  // legal billing document never silently changes if the client master
  // record is edited later. Falls back to `clients` (via the join below)
  // for invoices created before this migration.
  bill_to_name: string | null;
  bill_to_address: string | null;
  bill_to_city: string | null;
  bill_to_state: string | null;
  bill_to_gst: string | null;
  terms: string | null;
  updated_at: string | null;
  clients?: { name: string; address?: string | null; city?: string | null; state?: string | null; gst_number?: string | null };
  purchase_orders?: { po_number: string; payment_terms?: string | null } | null;
  invoice_items?: InvoiceItem[];
}

export interface InvoiceItem {
  id: string;
  organization_id: string;
  invoice_id: string;
  shop_id: string | null;
  work_item_id: string | null;
  po_line_item_id: string | null;
  description: string;
  quantity: number;
  area: number | null;
  rate: number;
  amount: number;
  // HSN/SAC code for GST-compliant invoicing (migration 0064) — auto-filled
  // from the linked PO line item's hsn_code when one is picked, editable.
  hsn_code: string | null;
  // Internal note for this specific line item (migration 0070) — e.g.
  // "3 shops excluded after client review". Not shown on the PDF.
  notes: string | null;
  created_at: string;
}

// Mirrors public.v_po_line_item_utilization (migration 0025) — one row per
// PO line item, budgeted vs actual at every pipeline stage plus amount
// already invoiced against it. Read-only.
export interface POLineItemUtilization {
  po_line_item_id: string;
  organization_id: string;
  purchase_order_id: string;
  po_number: string;
  po_date: string;
  fulfillment_type: 'survey_install' | 'supply_only';
  po_status: 'active' | 'closed' | 'cancelled';
  client_id: string;
  client_name: string | null;
  project_id: string | null;
  project_name: string | null;
  description: string;
  hsn_code: string | null;
  work_type_id: string | null;
  work_type_name: string | null;
  uom: 'sqft' | 'piece' | 'lot';
  budgeted_qty: number | null;
  budgeted_area: number | null;
  rate: number | null;
  surveyed_area: number;
  surveyed_qty: number;
  approved_area: number;
  approved_qty: number;
  produced_qty: number;
  installed_area: number;
  installed_qty: number;
  linked_work_item_count: number;
  invoiced_amount: number;
}

// Mirrors public.v_po_line_item_work_context (migration 0029) — the
// non-financial counterpart to POLineItemUtilization: everything a
// Production/Survey/Design screen needs to show budget context (PO number,
// fulfillment type, budgeted qty/area) without ever carrying `rate`. Open
// to every role via RLS, unlike the base po_line_items table.
export interface POLineItemWorkContext {
  id: string;
  organization_id: string;
  purchase_order_id: string;
  po_number: string;
  // Optional human-readable Work Order label (migration 0068) — surfaced
  // here so field-safe screens (Survey Review, Surveyor) can show it
  // without ever touching the financial-locked purchase_orders table.
  name: string | null;
  fulfillment_type: 'survey_install' | 'supply_only';
  po_status: 'active' | 'closed' | 'cancelled';
  work_type_id: string | null;
  description: string;
  uom: 'sqft' | 'piece' | 'lot';
  budgeted_qty: number | null;
  budgeted_area: number | null;
}

// Mirrors public.v_po_line_item_burndown_events (migration 0032) — one row
// per work item per pipeline stage it has reached, dated by when that stage
// actually happened. The frontend buckets these by day and cumulatively
// sums them (per stage) to draw a burndown chart against the line item's
// budgeted_area/budgeted_qty. Read-only.
export interface POLineItemBurndownEvent {
  work_item_id: string;
  po_line_item_id: string;
  organization_id: string;
  stage: 'surveyed' | 'approved' | 'produced' | 'installed';
  event_date: string; // YYYY-MM-DD
  area_delta: number;
  qty_delta: number;
}

// Mirrors public.v_client_po_line_item_progress (migration 0039) — the
// Client Organization portal's counterpart to POLineItemUtilization: same
// budgeted-vs-actual qty/area rollup per PO line item, but with `rate` and
// `invoiced_amount` deliberately left out entirely (a Client Organization
// user must never receive agency rate/cost data — see
// GLOBAL_ARCHITECTURE.md section 2.5 / 7). Billing figures for a client
// come from the `invoices` table directly (their own bill — fine for them
// to see), never from this view.
export interface ClientPOLineItemProgress {
  po_line_item_id: string;
  purchase_order_id: string;
  agency_org_id: string;
  client_org_id: string;
  po_number: string;
  po_date: string;
  fulfillment_type: 'survey_install' | 'supply_only';
  po_status: 'active' | 'closed' | 'cancelled';
  assignment_status: 'pending_acceptance' | 'accepted' | 'rejected' | 'in_progress' | 'completed';
  description: string;
  work_type_id: string | null;
  work_type_name: string | null;
  uom: 'sqft' | 'piece' | 'lot';
  budgeted_qty: number | null;
  budgeted_area: number | null;
  surveyed_area: number;
  surveyed_qty: number;
  approved_area: number;
  approved_qty: number;
  produced_qty: number;
  installed_area: number;
  installed_qty: number;
  linked_work_item_count: number;
}

export interface WorkerLocation {
  id: string;
  organization_id: string;
  user_id: string;
  latitude: number;
  longitude: number;
  accuracy: number | null;
  recorded_at: string;
}

export interface AuditLog {
  id: string;
  organization_id: string;
  user_id: string | null;
  table_name: string;
  record_id: string | null;
  action: string;
  field_name: string | null;
  old_value: string | null;
  new_value: string | null;
  description: string | null;
  created_at: string;
  profiles?: { full_name: string };
}

export interface Notification {
  id: string;
  organization_id: string;
  user_id: string;
  title: string;
  message: string;
  type: string;
  is_read: boolean;
  link: string | null;
  created_at: string;
}

export interface BoardMarking {
  id: string;
  organization_id: string;
  survey_photo_id: string;
  work_item_id: string | null;
  points: { x: number; y: number }[];
  image_width: number | null;
  image_height: number | null;
  version: number;
  created_at: string;
}

export const SHOP_STATUSES = [
  'pending', 'assigned', 'survey_started', 'surveyed', 'approval_pending',
  'approved', 'design_pending', 'designing', 'design_ready', 'in_review',
  'design_approved', 'production_pending', 'in_production', 'production_ready',
  'production_hold', 'production_done', 'dispatched', 'installation_pending',
  'installing', 'installation_review', 'installed', 'billed', 'cancelled'
] as const;

export const STATUS_LABELS: Record<string, string> = {
  pending: 'Pending',
  assigned: 'Assigned',
  survey_started: 'Survey Started',
  surveyed: 'Surveyed',
  approval_pending: 'Approval Pending',
  approved: 'Approved',
  design_pending: 'Design Pending',
  designing: 'Designing',
  design_ready: 'Design Ready',
  in_review: 'In Review',
  design_approved: 'Design Approved',
  production_pending: 'Production Pending',
  in_production: 'In Production',
  production_ready: 'Production Ready',
  production_hold: 'On Hold',
  production_done: 'Production Done',
  dispatched: 'Dispatched',
  installation_pending: 'Installation Pending',
  installing: 'Installing',
  installation_review: 'Awaiting Approval',
  installed: 'Installed',
  billed: 'Billed',
  cancelled: 'Cancelled',
};

export const STATUS_COLORS: Record<string, string> = {
  pending: 'bg-slate-100 text-slate-700',
  assigned: 'bg-blue-100 text-blue-700',
  survey_started: 'bg-blue-100 text-blue-700',
  surveyed: 'bg-cyan-100 text-cyan-700',
  approval_pending: 'bg-amber-100 text-amber-700',
  approved: 'bg-green-100 text-green-700',
  design_pending: 'bg-purple-100 text-purple-700',
  designing: 'bg-purple-100 text-purple-700',
  design_ready: 'bg-purple-100 text-purple-700',
  in_review: 'bg-amber-100 text-amber-700',
  design_approved: 'bg-green-100 text-green-700',
  production_pending: 'bg-orange-100 text-orange-700',
  in_production: 'bg-orange-100 text-orange-700',
  production_ready: 'bg-orange-100 text-orange-700',
  production_hold: 'bg-red-100 text-red-700',
  production_done: 'bg-teal-100 text-teal-700',
  dispatched: 'bg-teal-100 text-teal-700',
  installation_pending: 'bg-indigo-100 text-indigo-700',
  installing: 'bg-indigo-100 text-indigo-700',
  installation_review: 'bg-amber-100 text-amber-700',
  installed: 'bg-emerald-100 text-emerald-700',
  billed: 'bg-green-100 text-green-700',
  cancelled: 'bg-red-100 text-red-700',
};

export const ROLE_LABELS: Record<string, string> = {
  agency_owner: 'Agency Owner',
  admin: 'Admin / Ops Manager',
  client_manager: 'Client Manager',
  surveyor: 'Surveyor',
  designer: 'Designer',
  printing: 'Printing / Production',
  installer: 'Installation',
  accounts: 'Accounts / Billing',
  demo: 'Demo',
  client_admin: 'Client Admin',
  client_viewer: 'Client Viewer',
  super_admin: 'Platform Super Admin',
};

export const OFFICE_ROLES: Role[] = ['agency_owner', 'admin', 'client_manager', 'designer', 'printing', 'accounts', 'demo'];
export const FIELD_ROLES: Role[] = ['surveyor', 'installer'];
