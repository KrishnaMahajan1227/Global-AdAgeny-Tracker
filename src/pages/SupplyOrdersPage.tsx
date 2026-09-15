import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { Card, StatusBadge, EmptyState, PageHeader, Modal, Input, Select, Textarea } from '@/components/ui';
import { logAudit, createNotification } from '@/lib/helpers';
import { useRealtimeInvalidate } from '@/lib/useRealtimeInvalidate';
import { PurchaseOrder, POLineItem, Shop, Route } from '@/lib/types';
import {
  Package, Plus, Truck, MapPin, CheckSquare, Square, Boxes, Loader2,
} from 'lucide-react';

type Tab = 'entries' | 'dispatch';

export default function SupplyOrdersPage() {
  const [tab, setTab] = useState<Tab>('entries');

  return (
    <div>
      <PageHeader
        title="Supply Orders"
        subtitle="Supply Only POs (tape, nails, flex printing...) — Design → BOM → Production → Packing → zone-wise dispatch. No field survey or on-site install job."
      />

      <div className="flex gap-2 mb-6 border-b border-slate-200">
        <button
          onClick={() => setTab('entries')}
          className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition ${tab === 'entries' ? 'border-blue-600 text-blue-600' : 'border-transparent text-slate-500 hover:text-slate-700'}`}
        >
          <Boxes className="w-4 h-4" /> PO Entries &amp; Design
        </button>
        <button
          onClick={() => setTab('dispatch')}
          className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition ${tab === 'dispatch' ? 'border-blue-600 text-blue-600' : 'border-transparent text-slate-500 hover:text-slate-700'}`}
        >
          <Truck className="w-4 h-4" /> Zone-wise Dispatch
        </button>
      </div>

      {tab === 'entries' ? <ProductionEntriesTab /> : <DispatchTab />}
    </div>
  );
}

function ProductionEntriesTab() {
  const { profile } = useAuth();
  const orgId = profile?.organization_id;
  const queryClient = useQueryClient();
  const [modalOpen, setModalOpen] = useState(false);
  const [form, setForm] = useState({
    purchase_order_id: '', po_line_item_id: '', shop_mode: 'existing', shop_id: '', new_shop_name: '',
    new_shop_contact_person: '', new_shop_contact_phone: '', new_shop_address: '',
    quantity: '', designer_id: '', notes: '',
  });

  useRealtimeInvalidate(['purchase_orders', 'shops', 'work_items', 'design_tasks', 'work_item_components'], orgId, [
    ['supply-only-pos', orgId],
  ]);

  // Same designer pool the survey_install flow assigns from (SurveyReviewPage) —
  // reusing it here is what puts a supply_only design task into the exact
  // same Designer dashboard queue as everything else, with no separate screen.
  const { data: designers } = useQuery({
    queryKey: ['org-designers', orgId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('profiles')
        .select('id, full_name')
        .eq('organization_id', orgId)
        .eq('role', 'designer')
        .eq('is_active', true)
        .order('full_name');
      if (error) throw new Error(`Could not load designers: ${error.message}`);
      return data as { id: string; full_name: string }[];
    },
    enabled: !!orgId,
  });

  const { data: supplyPOs } = useQuery({
    queryKey: ['supply-only-pos', orgId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('purchase_orders')
        .select('*, clients(name), po_line_items(*, work_types(name))')
        .eq('organization_id', orgId)
        .eq('fulfillment_type', 'supply_only')
        .eq('status', 'active')
        .order('created_at', { ascending: false });
      if (error) throw error;
      return data as (PurchaseOrder & { clients: { name: string } | null; po_line_items: (POLineItem & { work_types: { name: string } | null })[] })[];
    },
    enabled: !!orgId,
  });

  const { data: shopsForPO } = useQuery({
    queryKey: ['shops-for-po', form.purchase_order_id],
    queryFn: async () => {
      const { data, error } = await supabase.from('shops').select('id, name, status').eq('purchase_order_id', form.purchase_order_id).order('name');
      if (error) throw error;
      return data as Pick<Shop, 'id' | 'name' | 'status'>[];
    },
    enabled: !!form.purchase_order_id,
  });

  // Produced-so-far per line item, for a lightweight utilization readout
  // right in the entry list — reuses work_items.produced_quantity, which
  // Production Studio already keeps in sync when qty is logged there.
  const { data: producedByLineItem } = useQuery({
    queryKey: ['supply-produced-by-line-item', orgId],
    queryFn: async () => {
      const { data, error } = await supabase.from('work_items').select('po_line_item_id, produced_quantity, approved_quantity').eq('organization_id', orgId).not('po_line_item_id', 'is', null);
      if (error) throw error;
      const map = new Map<string, { produced: number; ordered: number }>();
      for (const row of data || []) {
        if (!row.po_line_item_id) continue;
        const cur = map.get(row.po_line_item_id) || { produced: 0, ordered: 0 };
        cur.produced += row.produced_quantity || 0;
        cur.ordered += row.approved_quantity || 0;
        map.set(row.po_line_item_id, cur);
      }
      return map;
    },
    enabled: !!orgId,
  });

  const selectedPO = (supplyPOs || []).find((po) => po.id === form.purchase_order_id) || null;
  const selectedLineItem = selectedPO?.po_line_items.find((li) => li.id === form.po_line_item_id) || null;

  // Default BOM template for this work type (double-sided tape, nails,
  // holders, packing material...) — Owner Console: Work Type Consumables.
  // Seeded onto the work item automatically at creation, scaled by qty, so
  // Production doesn't start from a blank BOM checklist every time.
  const { data: consumables } = useQuery({
    queryKey: ['consumables-for-work-type', selectedLineItem?.work_type_id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('work_type_consumables')
        .select('*')
        .eq('work_type_id', selectedLineItem!.work_type_id!);
      if (error) throw new Error(`Could not load default components: ${error.message}`);
      return data as { consumable_name: string; qty_per_unit: number | null }[];
    },
    enabled: !!selectedLineItem?.work_type_id,
  });

  const createMutation = useMutation({
    mutationFn: async () => {
      if (!selectedPO || !selectedLineItem) throw new Error('Pick a Purchase Order and a line item.');
      if (!selectedLineItem.work_type_id) {
        throw new Error('This line item has no Work Type set — add one from the Purchase Orders page first.');
      }
      if (!form.designer_id) throw new Error('Pick a designer to assign this job to before saving.');
      const qty = Number(form.quantity);
      if (!form.quantity || isNaN(qty) || qty <= 0) throw new Error('Enter a valid quantity.');

      let shopId = form.shop_id;
      if (form.shop_mode === 'new') {
        if (!form.new_shop_name.trim()) throw new Error('Enter a name for the new shop / delivery point.');
        const { data: newShop, error: shopError } = await supabase.from('shops').insert({
          organization_id: orgId,
          client_id: selectedPO.client_id,
          project_id: selectedPO.project_id,
          name: form.new_shop_name.trim(),
          // Per ARCHITECTURE doc Section 4.2 — Supply Only delivery points
          // need a contact person + phone + full address just like a
          // courier needs to know where and who to hand the box to, even
          // though there's no GPS survey / board-marking / installer job.
          // owner_name doubles as "delivery contact person" here (the
          // shops table has no separate contact_person column and this
          // path deliberately reuses shops rather than forking into a new
          // supply_destinations table — see CHANGES.md).
          owner_name: form.new_shop_contact_person.trim() || null,
          contact_phone: form.new_shop_contact_phone.trim() || null,
          address: form.new_shop_address.trim() || null,
          purchase_order_id: selectedPO.id,
          // Supply-only now enters through Design first, same as
          // survey_install does after survey approval — not straight to
          // production — so the shop lands in the Designer's queue.
          status: 'design_pending',
        }).select().single();
        if (shopError) throw new Error(`Could not create shop: ${shopError.message}`);
        shopId = newShop.id;
      } else {
        if (!shopId) throw new Error('Pick a shop / delivery point.');
        await supabase.from('shops').update({ status: 'design_pending' }).eq('id', shopId).eq('status', 'pending');
      }

      const { data: workItem, error: itemError } = await supabase.from('work_items').insert({
        organization_id: orgId,
        shop_id: shopId,
        work_type_id: selectedLineItem.work_type_id,
        work_type_name: selectedLineItem.work_types?.name || selectedLineItem.description,
        po_line_item_id: selectedLineItem.id,
        approved_quantity: qty,
        approved_unit: selectedLineItem.uom,
        approved_area: selectedLineItem.uom === 'sqft' ? qty : null,
        approved_notes: form.notes || null,
        status: 'approved',
      }).select().single();
      if (itemError) throw new Error(`Could not create work item: ${itemError.message}`);

      // Section 4.2 — mirror this entry into the standalone
      // supply_destinations table (doc-literal shape: destination name,
      // contact, address, qty, PO/line-item/zone, status) alongside the
      // shop-based record above, rather than replacing it — see migration
      // 0034 for why. Canonical contact/address/zone always comes from the
      // shop row itself (covers both the "new shop" and "existing shop"
      // branches the same way, since an existing shop's contact details
      // aren't in `form` at all).
      const { data: shopForDestination } = await supabase
        .from('shops')
        .select('name, owner_name, contact_phone, address, zone_id')
        .eq('id', shopId)
        .maybeSingle();
      const { error: destError } = await supabase.from('supply_destinations').insert({
        organization_id: orgId,
        purchase_order_id: selectedPO.id,
        po_line_item_id: selectedLineItem.id,
        zone_id: shopForDestination?.zone_id || null,
        shop_id: shopId,
        destination_name: shopForDestination?.name || form.new_shop_name.trim() || 'Delivery point',
        contact_person: shopForDestination?.owner_name || null,
        contact_phone: shopForDestination?.contact_phone || null,
        address: shopForDestination?.address || null,
        quantity: qty,
        uom: selectedLineItem.uom,
        status: 'pending',
      });
      if (destError) console.error('[SupplyOrders] could not create supply_destinations record (non-fatal, shop-based record already saved):', destError.message);

      // Seed the BOM from the work type's default consumables (Owner
      // Console template), scaled to this job's quantity. Production's
      // readiness gate (Phase 4) already blocks "produced" until every
      // row here is marked ready — this just stops it starting empty.
      if (consumables && consumables.length > 0) {
        const componentRows = consumables.map((c) => ({
          organization_id: orgId,
          work_item_id: workItem.id,
          component_name: c.consumable_name,
          required_qty: c.qty_per_unit != null ? c.qty_per_unit * qty : null,
          status: 'pending' as const,
          source: 'consumable' as const,
        }));
        const { error: componentsError } = await supabase.from('work_item_components').insert(componentRows);
        if (componentsError) throw new Error(`Could not seed BOM components: ${componentsError.message}`);
      }

      // Design task — same shop-scoped table and same Designer dashboard
      // queue survey_install already uses (DesignerPage.tsx). Once the
      // designer takes it through to "Ready for Production", that step
      // already creates the production_orders row and flips the shop to
      // production_pending — nothing more to wire up here.
      const { data: existingTask, error: existingTaskError } = await supabase
        .from('design_tasks')
        .select('id')
        .eq('shop_id', shopId)
        .maybeSingle();
      if (existingTaskError) throw new Error(`Could not check for existing design task: ${existingTaskError.message}`);
      if (!existingTask) {
        const { error: taskInsertError } = await supabase.from('design_tasks').insert({
          organization_id: orgId,
          shop_id: shopId,
          status: 'assigned',
          designer_id: form.designer_id,
        });
        if (taskInsertError) throw new Error(`Could not create design task: ${taskInsertError.message}`);
      } else {
        const { error: taskUpdateError } = await supabase.from('design_tasks').update({ designer_id: form.designer_id }).eq('id', existingTask.id).select('id');
        if (taskUpdateError) throw new Error(`Could not assign designer: ${taskUpdateError.message}`);
      }
      // The designer needs to know they've got a new board to design — not
      // which PO or budget line it's billed against. PO context is an
      // owner/admin-only concern everywhere else on the Design Studio
      // screen too (see DesignerPage.tsx), so this notification text stays
      // scoped to just the work itself.
      await createNotification(form.designer_id, 'New Design Task', `You've been assigned to design "${selectedLineItem.description}"`, 'info', '/design');

      await logAudit('work_items', workItem.id, 'insert', null, null, null, `Supply Only entry: ${qty} ${selectedLineItem.uom} of ${selectedLineItem.description} for PO ${selectedPO.name || selectedPO.po_number} — sent to Design`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['supply-only-pos', orgId] });
      queryClient.invalidateQueries({ queryKey: ['design-task-list', orgId] });
      queryClient.invalidateQueries({ queryKey: ['design-task-stats', orgId] });
      queryClient.invalidateQueries({ queryKey: ['shops', orgId] });
      queryClient.invalidateQueries({ queryKey: ['supply-produced-by-line-item', orgId] });
      queryClient.invalidateQueries({ queryKey: ['nav-pending-counts', orgId] });
      setModalOpen(false);
      setForm({ purchase_order_id: '', po_line_item_id: '', shop_mode: 'existing', shop_id: '', new_shop_name: '', new_shop_contact_person: '', new_shop_contact_phone: '', new_shop_address: '', quantity: '', designer_id: '', notes: '' });
    },
  });

  return (
    <div>
      <div className="flex justify-between items-center mb-4">
        <p className="text-sm text-slate-500 max-w-xl">
          Pick a Supply Only PO's line item, set a quantity, and assign a designer — it goes to the Designer's queue first (artwork/layout for foam sheet, vinyl, logo, desk mat...),
          then BOM + Production, then packing &amp; dispatch. No survey, no install job.
        </p>
        <button onClick={() => setModalOpen(true)} className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg font-medium text-sm transition shrink-0">
          <Plus className="w-4 h-4" /> New PO Entry
        </button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {supplyPOs?.map((po) => (
          <Card key={po.id} className="p-5">
            <div className="flex items-start justify-between mb-3">
              <div>
                <h3 className="font-semibold text-slate-900">{po.name || po.po_number}</h3>
                {po.name && <p className="text-xs text-slate-400">{po.po_number}</p>}
                <p className="text-sm text-slate-500">{po.clients?.name}</p>
              </div>
              <span className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-teal-100 text-teal-700">Supply Only</span>
            </div>
            <div className="space-y-2">
              {po.po_line_items.length === 0 && <p className="text-xs text-slate-400 italic">No line items yet — add them from Purchase Orders.</p>}
              {po.po_line_items.map((li) => {
                const stats = producedByLineItem?.get(li.id);
                const budget = li.budgeted_qty ?? li.budgeted_area ?? null;
                return (
                  <div key={li.id} className="text-xs bg-slate-50 rounded-lg px-3 py-2">
                    <div className="flex items-center justify-between">
                      <span className="font-medium text-slate-700">{li.description}</span>
                      <span className="text-slate-400">{li.uom}</span>
                    </div>
                    <div className="flex items-center justify-between mt-0.5 text-slate-500">
                      <span>{li.work_types?.name || 'No work type set'}</span>
                      <span>
                        {stats ? `${stats.produced}/${stats.ordered}` : '0/0'} produced
                        {budget != null ? ` · ${budget} budgeted` : ''}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          </Card>
        ))}
        {supplyPOs?.length === 0 && (
          <Card className="col-span-full">
            <EmptyState icon={<Package className="w-12 h-12" />} title="No Supply Only POs yet" subtitle="Create one from the Purchase Orders page with fulfillment type 'Supply Only'" />
          </Card>
        )}
      </div>

      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title="New Supply Order Entry" size="lg">
        <div className="space-y-4">
          <Select
            label="Purchase Order"
            value={form.purchase_order_id}
            onChange={(v) => setForm({ ...form, purchase_order_id: v, po_line_item_id: '', shop_id: '' })}
            options={(supplyPOs || []).map((po) => ({ value: po.id, label: `${po.name ? `${po.name} (${po.po_number})` : po.po_number} · ${po.clients?.name || ''}` }))}
            required
          />
          {selectedPO && (
            <Select
              label="Line Item"
              value={form.po_line_item_id}
              onChange={(v) => setForm({ ...form, po_line_item_id: v })}
              options={selectedPO.po_line_items.map((li) => ({ value: li.id, label: `${li.description} (${li.uom})${li.work_types?.name ? ` — ${li.work_types.name}` : ' — no work type!'}` }))}
              required
            />
          )}

          {selectedPO && (
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Shop / Delivery Point</label>
              <div className="flex gap-2 mb-2">
                <button
                  type="button"
                  onClick={() => setForm({ ...form, shop_mode: 'existing' })}
                  className={`flex-1 px-3 py-1.5 rounded-lg text-xs font-medium border ${form.shop_mode === 'existing' ? 'border-blue-600 bg-blue-50 text-blue-700' : 'border-slate-200 text-slate-500'}`}
                >
                  Existing shop
                </button>
                <button
                  type="button"
                  onClick={() => setForm({ ...form, shop_mode: 'new' })}
                  className={`flex-1 px-3 py-1.5 rounded-lg text-xs font-medium border ${form.shop_mode === 'new' ? 'border-blue-600 bg-blue-50 text-blue-700' : 'border-slate-200 text-slate-500'}`}
                >
                  New shop
                </button>
              </div>
              {form.shop_mode === 'existing' ? (
                <select
                  value={form.shop_id}
                  onChange={(e) => setForm({ ...form, shop_id: e.target.value })}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg outline-none focus:ring-2 focus:ring-blue-500 bg-white text-slate-900"
                >
                  <option value="">Select...</option>
                  {(shopsForPO || []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              ) : (
                <input
                  type="text"
                  value={form.new_shop_name}
                  onChange={(e) => setForm({ ...form, new_shop_name: e.target.value })}
                  placeholder="e.g. Rajkot Dealer Network"
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg outline-none focus:ring-2 focus:ring-blue-500"
                />
              )}
            </div>
          )}

          {selectedPO && form.shop_mode === 'new' && (
            <div className="grid grid-cols-2 gap-4">
              <Input
                label="Contact Person"
                value={form.new_shop_contact_person}
                onChange={(v) => setForm({ ...form, new_shop_contact_person: v })}
                placeholder="Who receives this at the destination"
              />
              <Input
                label="Contact Phone"
                value={form.new_shop_contact_phone}
                onChange={(v) => setForm({ ...form, new_shop_contact_phone: v })}
                placeholder="10-digit mobile"
              />
              <div className="col-span-2">
                <Textarea
                  label="Delivery Address"
                  value={form.new_shop_address}
                  onChange={(v) => setForm({ ...form, new_shop_address: v })}
                  placeholder="Full address the courier/transport needs — HQ, branch, dealer, or outlet"
                />
              </div>
            </div>
          )}

          <div className="grid grid-cols-2 gap-4">
            <Input label={`Quantity${selectedLineItem ? ` (${selectedLineItem.uom})` : ''}`} type="number" value={form.quantity} onChange={(v) => setForm({ ...form, quantity: v })} required />
            <Select
              label="Assign Designer"
              value={form.designer_id}
              onChange={(v) => setForm({ ...form, designer_id: v })}
              options={(designers || []).map((d) => ({ value: d.id, label: d.full_name }))}
              required
            />
          </div>
          {selectedLineItem?.work_type_id && (
            <p className="text-xs text-slate-400">
              {consumables && consumables.length > 0
                ? `BOM will auto-fill with this work type's default components: ${consumables.map((c) => c.consumable_name).join(', ')}.`
                : 'No default components set for this work type yet — add some from Owner Console → Work Type Consumables, or add them manually later in Production.'}
            </p>
          )}
          <Textarea label="Design Brief / Notes" value={form.notes} onChange={(v) => setForm({ ...form, notes: v })} placeholder="What to design — e.g. logo artwork per brand guidelines, layout reference, etc." />

          {createMutation.isError && <p className="text-sm text-red-600">{(createMutation.error as Error).message}</p>}

          <button
            onClick={() => createMutation.mutate()}
            disabled={createMutation.isPending || !form.purchase_order_id || !form.po_line_item_id || !form.quantity || !form.designer_id}
            className="w-full flex items-center justify-center gap-2 bg-blue-600 hover:bg-blue-700 text-white font-medium py-2.5 rounded-lg transition disabled:opacity-50"
          >
            {createMutation.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
            {createMutation.isPending ? 'Creating...' : 'Create Entry & Send to Design'}
          </button>
          <p className="text-xs text-slate-400">This creates a design task in the Designer's queue. Once the design is approved and released, it moves automatically to Production Studio.</p>
        </div>
      </Modal>
    </div>
  );
}

function DispatchTab() {
  const { profile } = useAuth();
  const orgId = profile?.organization_id;
  const queryClient = useQueryClient();

  const [selectedShopIds, setSelectedShopIds] = useState<Set<string>>(new Set());
  const [routeForm, setRouteForm] = useState({
    name: '', route_date: new Date().toISOString().split('T')[0], user_id: '',
    dispatch_mode: 'staff', transport_mode: '', tracking_reference: '',
  });
  const [createOpen, setCreateOpen] = useState(false);

  useRealtimeInvalidate(['shops', 'routes', 'route_stops'], orgId, [
    ['dispatch-ready-shops', orgId],
    ['dispatch-routes', orgId],
  ]);

  const { data: readyShops } = useQuery({
    queryKey: ['dispatch-ready-shops', orgId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('shops')
        .select('*, clients(name), zones(name), purchase_orders(fulfillment_type)')
        .eq('organization_id', orgId)
        .eq('status', 'production_done')
        .order('name');
      if (error) throw error;
      return (data as (Shop & { clients: { name: string } | null; zones: { name: string } | null; purchase_orders: { fulfillment_type: string } | null })[])
        .filter((s) => s.purchase_orders?.fulfillment_type === 'supply_only');
    },
    enabled: !!orgId,
  });

  const { data: staff } = useQuery({
    queryKey: ['org-staff', orgId],
    queryFn: async () => {
      const { data, error } = await supabase.from('profiles').select('id, full_name, role').eq('organization_id', orgId).eq('is_active', true).order('full_name');
      if (error) throw error;
      return data as { id: string; full_name: string; role: string }[];
    },
    enabled: !!orgId,
  });

  const { data: routes } = useQuery({
    queryKey: ['dispatch-routes', orgId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('routes')
        .select('*, profiles:user_id(full_name), confirmed_by_profile:owner_confirmed_by(full_name), route_stops(id, shop_id, status, shops(name))')
        .eq('organization_id', orgId)
        .order('created_at', { ascending: false })
        .limit(20);
      if (error) throw error;
      return data as (Route & {
        profiles: { full_name: string } | null;
        confirmed_by_profile: { full_name: string } | null;
        route_stops: { id: string; shop_id: string; status: string; shops: { name: string } | null }[];
      })[];
    },
    enabled: !!orgId,
  });

  // §3.3's "Confirm to Owner" checkpoint (migration 0045) — an
  // Owner/Admin explicitly acknowledging a dispatch happened, between
  // Dispatch and Billing. Flag only, never blocks billing.
  const canConfirmDispatch = profile?.role === 'agency_owner' || profile?.role === 'admin';
  const confirmDispatchMutation = useMutation({
    mutationFn: async (route: { id: string; name: string | null }) => {
      if (!profile) throw new Error('Not signed in.');
      const { error } = await supabase.from('routes').update({
        owner_confirmed_at: new Date().toISOString(),
        owner_confirmed_by: profile.id,
      }).eq('id', route.id).select('id');
      if (error) throw new Error(error.message);
      await logAudit('routes', route.id, 'update', 'owner_confirmed_at', null, 'confirmed', 'Dispatch confirmed by Owner/Admin');

      // Billing isn't gated on this, but Accounts should still know a
      // dispatch has been looked at and is clear to invoice against.
      const { data: accountsUsers } = await supabase.from('profiles').select('id').eq('organization_id', profile.organization_id).eq('role', 'accounts').eq('is_active', true);
      for (const u of accountsUsers || []) {
        await createNotification(u.id, 'Dispatch Confirmed', `${route.name || 'A dispatch route'} has been confirmed by ${profile.full_name} — clear to bill.`, 'info', '/billing');
      }
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['dispatch-routes', orgId] }),
  });

  const zoneGroups = useMemo(() => {
    const groups = new Map<string, (Shop & { clients: { name: string } | null; zones: { name: string } | null })[]>();
    for (const shop of readyShops || []) {
      const key = shop.zones?.name || 'No Zone';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(shop);
    }
    return Array.from(groups.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [readyShops]);

  function toggleShop(id: string) {
    setSelectedShopIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  const createRouteMutation = useMutation({
    mutationFn: async () => {
      if (selectedShopIds.size === 0) throw new Error('Select at least one shop to dispatch.');
      if (routeForm.dispatch_mode === 'staff' && !routeForm.user_id) throw new Error('Pick who is doing this delivery run.');
      if (routeForm.dispatch_mode === 'courier' && !routeForm.transport_mode.trim()) throw new Error('Enter the courier / transport company name.');

      const shopIds = Array.from(selectedShopIds);
      // If every selected shop shares one zone, tag the route with it —
      // per doc Section 6.4 ("zone-wise dispatch"). Left null when the
      // selection spans multiple zones rather than guessing.
      const selectedShops = (readyShops || []).filter((s) => selectedShopIds.has(s.id));
      const zoneIds = new Set(selectedShops.map((s) => s.zone_id).filter(Boolean));
      const zoneId = zoneIds.size === 1 ? Array.from(zoneIds)[0] : null;

      const { data: route, error: routeError } = await supabase.from('routes').insert({
        organization_id: orgId,
        // Courier/transport-company dispatch has no internal staff to
        // assign — user_id is nullable for exactly this case (migration
        // 0027), so only send it when a staff member was actually picked.
        user_id: routeForm.dispatch_mode === 'staff' ? routeForm.user_id : null,
        name: routeForm.name || `Dispatch ${new Date(routeForm.route_date).toLocaleDateString('en-IN')}`,
        route_date: routeForm.route_date,
        status: 'planned',
        transport_mode: routeForm.dispatch_mode === 'courier' ? routeForm.transport_mode.trim() : null,
        tracking_reference: routeForm.tracking_reference.trim() || null,
        zone_id: zoneId,
      }).select().single();
      if (routeError) throw new Error(`Could not create route: ${routeError.message}`);

      const stopsPayload = shopIds.map((shopId, i) => ({
        organization_id: orgId,
        route_id: route.id,
        shop_id: shopId,
        stop_order: i + 1,
        status: 'pending',
      }));
      const { error: stopsError } = await supabase.from('route_stops').insert(stopsPayload);
      if (stopsError) throw new Error(`Could not add stops: ${stopsError.message}`);

      const { error: shopsError } = await supabase.from('shops').update({ status: 'dispatched' }).in('id', shopIds);
      if (shopsError) throw new Error(`Could not update shop status: ${shopsError.message}`);

      // Section 4.2 — keep the standalone supply_destinations record (if
      // one exists for these shops) in sync with the dispatch: status
      // moves to 'dispatched' and route_id points at the route just
      // created, so a report/export reading supply_destinations directly
      // sees the same picture as the shop-based pipeline. Non-fatal if it
      // fails — the actual dispatch (routes/route_stops/shops above) has
      // already succeeded by this point.
      const { error: destSyncError } = await supabase
        .from('supply_destinations')
        .update({ status: 'dispatched', route_id: route.id })
        .in('shop_id', shopIds);
      if (destSyncError) console.error('[SupplyOrders] could not sync supply_destinations on dispatch (non-fatal):', destSyncError.message);

      await logAudit('routes', route.id, 'insert', null, null, null, `Dispatch route created for ${shopIds.length} shop(s)`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['dispatch-ready-shops', orgId] });
      queryClient.invalidateQueries({ queryKey: ['dispatch-routes', orgId] });
      queryClient.invalidateQueries({ queryKey: ['shops', orgId] });
      setSelectedShopIds(new Set());
      setCreateOpen(false);
      setRouteForm({ name: '', route_date: new Date().toISOString().split('T')[0], user_id: '', dispatch_mode: 'staff', transport_mode: '', tracking_reference: '' });
    },
  });

  return (
    <div>
      {/* §3.3 — the "Distribution hand-off" checkpoint between Production
          and Dispatch. Technically still one continuous screen/action (per
          Assumption A3 — no new role/table), but explicitly labeled here
          as its own step so it reads as the checkpoint it's meant to be,
          not a silent status flip. Purely a label/heading change — the
          selection, mutation, and dispatch logic below is untouched. */}
      <div className="flex items-center gap-2 mb-1.5">
        <span className="flex items-center justify-center w-5 h-5 rounded-full bg-indigo-100 text-indigo-700 text-[11px] font-semibold shrink-0">1</span>
        <h3 className="text-sm font-semibold text-slate-800 flex items-center gap-1.5">
          <Boxes className="w-4 h-4 text-indigo-500" /> Distribution Hand-off — pack &amp; batch by zone
        </h3>
      </div>
      <div className="flex justify-between items-center mb-4 gap-3 flex-wrap">
        <p className="text-sm text-slate-500 max-w-xl">
          Shops with a Supply Only production order marked completed, ready to be grouped into a zone-wise dispatch batch. Select shops below and hand them off to Dispatch — this also marks them as billing-eligible.
        </p>
        <button
          onClick={() => setCreateOpen(true)}
          disabled={selectedShopIds.size === 0}
          className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg font-medium text-sm transition shrink-0 disabled:opacity-40"
        >
          <Truck className="w-4 h-4" /> Create Dispatch ({selectedShopIds.size})
        </button>
      </div>

      {zoneGroups.length === 0 ? (
        <Card><EmptyState icon={<Boxes className="w-12 h-12" />} title="Nothing ready for hand-off" subtitle="Complete a Supply Only production order in Production Studio first — it will appear here, grouped by zone, ready to distribute." /></Card>
      ) : (
        <div className="space-y-4 mb-8">
          {zoneGroups.map(([zoneName, shops]) => (
            <Card key={zoneName} className="p-4">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-semibold text-slate-700 flex items-center gap-1.5"><MapPin className="w-4 h-4 text-slate-400" /> {zoneName}</h3>
                <span className="text-xs font-medium text-indigo-600 bg-indigo-50 border border-indigo-100 rounded-full px-2 py-0.5">{shops.length} ready</span>
              </div>
              <div className="space-y-1.5">
                {shops.map((shop) => (
                  <button
                    key={shop.id}
                    onClick={() => toggleShop(shop.id)}
                    className="w-full flex items-center gap-2 text-left px-2 py-1.5 rounded-lg hover:bg-slate-50 text-sm"
                  >
                    {selectedShopIds.has(shop.id) ? (
                      <CheckSquare className="w-4 h-4 text-blue-600 shrink-0" />
                    ) : (
                      <Square className="w-4 h-4 text-slate-300 shrink-0" />
                    )}
                    <span className="text-slate-800">{shop.name}</span>
                    <span className="text-slate-400 text-xs">{shop.clients?.name}</span>
                  </button>
                ))}
              </div>
            </Card>
          ))}
        </div>
      )}

      <div className="flex items-center gap-2 mb-3">
        <span className="flex items-center justify-center w-5 h-5 rounded-full bg-blue-100 text-blue-700 text-[11px] font-semibold shrink-0">2</span>
        <h3 className="text-sm font-semibold text-slate-800 flex items-center gap-1.5"><Truck className="w-4 h-4 text-blue-500" /> Dispatch — routes created from the hand-off above</h3>
      </div>
      <div className="space-y-2">
        {routes?.map((route) => (
          <Card key={route.id} className="p-4">
            <div className="flex items-center justify-between mb-2">
              <div>
                <p className="font-medium text-slate-900 text-sm">{route.name}</p>
                <p className="text-xs text-slate-500">
                  {new Date(route.route_date).toLocaleDateString('en-IN')} ·{' '}
                  {route.profiles?.full_name ? `Driver: ${route.profiles.full_name}` : route.transport_mode ? `Via: ${route.transport_mode}` : 'Unassigned'}
                </p>
                {route.tracking_reference && <p className="text-xs text-slate-400">Tracking: {route.tracking_reference}</p>}
              </div>
              <StatusBadge status={route.status} />
            </div>
            <div className="flex flex-wrap gap-1.5 mb-3">
              {route.route_stops.map((stop) => (
                <span key={stop.id} className="text-xs bg-slate-100 text-slate-600 rounded-full px-2 py-0.5">{stop.shops?.name || 'Shop'}</span>
              ))}
            </div>
            <div className="flex items-center justify-between pt-3 border-t border-slate-100">
              {route.owner_confirmed_at ? (
                <p className="text-xs text-green-700 flex items-center gap-1.5">
                  <CheckSquare className="w-3.5 h-3.5" />
                  Confirmed by {route.confirmed_by_profile?.full_name || 'Owner/Admin'} on {new Date(route.owner_confirmed_at).toLocaleDateString('en-IN')}
                </p>
              ) : canConfirmDispatch ? (
                <button
                  onClick={() => confirmDispatchMutation.mutate({ id: route.id, name: route.name })}
                  disabled={confirmDispatchMutation.isPending}
                  className="text-xs font-medium text-blue-600 hover:text-blue-700 flex items-center gap-1.5 disabled:opacity-50"
                >
                  <Square className="w-3.5 h-3.5" />
                  {confirmDispatchMutation.isPending ? 'Confirming...' : 'Confirm Dispatch to Owner'}
                </button>
              ) : (
                <p className="text-xs text-amber-600">Awaiting Owner/Admin confirmation</p>
              )}
            </div>
          </Card>
        ))}
        {routes?.length === 0 && <p className="text-sm text-slate-400">No dispatch routes yet.</p>}
      </div>

      <Modal open={createOpen} onClose={() => setCreateOpen(false)} title="Create Dispatch Route">
        <div className="space-y-4">
          <p className="text-xs text-slate-500">{selectedShopIds.size} shop(s) selected.</p>
          <Input label="Route Name (optional)" value={routeForm.name} onChange={(v) => setRouteForm({ ...routeForm, name: v })} placeholder="e.g. Jalgaon Zone Delivery" />
          <Input label="Delivery Date" type="date" value={routeForm.route_date} onChange={(v) => setRouteForm({ ...routeForm, route_date: v })} required />

          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Dispatch By</label>
            <div className="flex gap-2 mb-2">
              <button
                type="button"
                onClick={() => setRouteForm({ ...routeForm, dispatch_mode: 'staff' })}
                className={`flex-1 px-3 py-1.5 rounded-lg text-xs font-medium border ${routeForm.dispatch_mode === 'staff' ? 'border-blue-600 bg-blue-50 text-blue-700' : 'border-slate-200 text-slate-500'}`}
              >
                Own staff / vehicle
              </button>
              <button
                type="button"
                onClick={() => setRouteForm({ ...routeForm, dispatch_mode: 'courier' })}
                className={`flex-1 px-3 py-1.5 rounded-lg text-xs font-medium border ${routeForm.dispatch_mode === 'courier' ? 'border-blue-600 bg-blue-50 text-blue-700' : 'border-slate-200 text-slate-500'}`}
              >
                Courier / transport company
              </button>
            </div>
          </div>

          {routeForm.dispatch_mode === 'staff' ? (
            <Select
              label="Assigned To"
              value={routeForm.user_id}
              onChange={(v) => setRouteForm({ ...routeForm, user_id: v })}
              options={(staff || []).map((s) => ({ value: s.id, label: `${s.full_name} (${s.role})` }))}
              required
            />
          ) : (
            <Input
              label="Transport Mode / Courier Name"
              value={routeForm.transport_mode}
              onChange={(v) => setRouteForm({ ...routeForm, transport_mode: v })}
              placeholder="e.g. Blue Dart, Local Transport Co."
              required
            />
          )}
          <Input
            label="Tracking Reference (optional)"
            value={routeForm.tracking_reference}
            onChange={(v) => setRouteForm({ ...routeForm, tracking_reference: v })}
            placeholder="AWB / consignment / LR number"
          />

          {createRouteMutation.isError && <p className="text-sm text-red-600">{(createRouteMutation.error as Error).message}</p>}
          <button
            onClick={() => createRouteMutation.mutate()}
            disabled={createRouteMutation.isPending || (routeForm.dispatch_mode === 'staff' ? !routeForm.user_id : !routeForm.transport_mode.trim())}
            className="w-full flex items-center justify-center gap-2 bg-blue-600 hover:bg-blue-700 text-white font-medium py-2.5 rounded-lg transition disabled:opacity-50"
          >
            {createRouteMutation.isPending ? 'Creating...' : 'Create & Mark Dispatched'}
          </button>
        </div>
      </Modal>
    </div>
  );
}
