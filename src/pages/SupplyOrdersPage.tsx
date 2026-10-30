import { fetchWorkflowFolderPages } from '@/lib/workflowFolderPages';
import { runBoundedWorkflowBatch, summarizeWorkflowBatch } from '@/lib/workflowBatch';
import { useMemo, useState, useEffect, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { supabase } from '@/lib/supabase';
import { fetchAllPages } from '@/lib/paginatedQuery';
import { useAuth } from '@/lib/auth';
import { Card, StatusBadge, EmptyState, PageHeader, Modal, Input, Select, Textarea } from '@/components/ui';
import { logAudit, createNotification } from '@/lib/helpers';
import { useRealtimeInvalidate } from '@/lib/useRealtimeInvalidate';
import { PurchaseOrder, POLineItem, Shop, Route } from '@/lib/types';
import {
  Package, Plus, Truck, MapPin, CheckSquare, Square, Boxes, Loader2,
} from 'lucide-react';

type Tab = 'entries' | 'dispatch';
type ReadySupplyShop = Pick<Shop, 'id' | 'name' | 'city' | 'status' | 'purchase_order_id'> & {
  clients: { name: string } | null;
  zones: { name: string } | null;
  purchase_orders: { fulfillment_type: string } | null;
};
// Must stay aligned with phase4_create_supply_dispatch RPC's maximum UUID array length.
const MAX_DISPATCH_DESTINATIONS = 200;

type Props = { embedded?: boolean; workOrderId?: string; initialTab?: Tab };

/** Reuses the existing supply-only entry and dispatch flows inside Work Orders.
 *  No duplicate route or second supply-specific Work Order list is created. */
export default function SupplyOrdersPage({ embedded = false, workOrderId = '', initialTab = 'entries' }: Props) {
  const [routeParams, setRouteParams] = useSearchParams();
  const [tab, setTab] = useState<Tab>(initialTab);
  useEffect(() => { setTab(initialTab); }, [initialTab]);
  const openTab = (nextTab: Tab) => {
    setTab(nextTab);
    if (embedded) {
      const next = new URLSearchParams(routeParams);
      if (nextTab === 'dispatch') next.set('step', 'dispatch');
      else next.delete('step');
      setRouteParams(next, { replace: true });
    }
  };

  return (
    <div>
      {embedded ? (
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-200 bg-white px-3 py-2.5">
          <div>
            <Link className="text-xs font-medium text-blue-700 hover:underline" to={workOrderId ? `/purchase-orders?type=supply_only&order=${encodeURIComponent(workOrderId)}` : '/purchase-orders?type=supply_only'}>← Work Orders</Link>
            <p className="mt-1 text-sm font-semibold text-slate-900">Production & Delivery · Execution</p>
            <p className="text-xs text-slate-500">Design → Production → Dispatch. Work Order selection is maintained across steps.</p>
          </div>
          <span className="rounded-full bg-blue-50 px-2.5 py-1 text-xs font-medium text-blue-700">Production & Delivery</span>
        </div>
      ) : (
        <PageHeader title="Production & Delivery · Execution" subtitle="Design → Production → Dispatch for your existing Production & Delivery Work Orders." />
      )}

      <div className="flex gap-2 mb-6 border-b border-slate-200">
        <button
          onClick={() => openTab('entries')}
          className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition ${tab === 'entries' ? 'border-blue-600 text-blue-600' : 'border-transparent text-slate-500 hover:text-slate-700'}`}
        >
          <Boxes className="w-4 h-4" /> PO Entries &amp; Design
        </button>
        <button
          onClick={() => openTab('dispatch')}
          className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition ${tab === 'dispatch' ? 'border-blue-600 text-blue-600' : 'border-transparent text-slate-500 hover:text-slate-700'}`}
        >
          <Truck className="w-4 h-4" /> Zone-wise Dispatch
        </button>
      </div>

      {tab === 'entries' ? <ProductionEntriesTab workOrderId={workOrderId} /> : <DispatchTab workOrderId={workOrderId} />}
    </div>
  );
}

function ProductionEntriesTab({ workOrderId }: { workOrderId: string }) {
  const { profile } = useAuth();
  const orgId = profile?.organization_id;
  const queryClient = useQueryClient();
  const [modalOpen, setModalOpen] = useState(false);
  const [form, setForm] = useState({
    purchase_order_id: workOrderId, po_line_item_id: '', shop_mode: 'existing', shop_id: '', new_shop_name: '',
    new_shop_contact_person: '', new_shop_contact_phone: '', new_shop_address: '',
    quantity: '', designer_id: '', artwork_source: 'agency', notes: '',
  });

  useEffect(() => {
    setForm(previous => ({ ...previous, purchase_order_id: workOrderId, po_line_item_id: '', shop_id: '' }));
  }, [workOrderId]);

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

  const { data: supplyPOs, isLoading: poLoading, error: poError } = useQuery({
    queryKey: ['supply-only-pos', orgId],
    queryFn: async () => {
      return fetchAllPages<PurchaseOrder & { clients: { name: string } | null; po_line_items: (POLineItem & { work_types: { name: string } | null })[] }>(
        (from, to) => supabase.from('purchase_orders')
          .select('*, clients(name), po_line_items(*, work_types(name))')
          .eq('organization_id', orgId).eq('fulfillment_type', 'supply_only').eq('status', 'active')
          .order('created_at', { ascending: false }).range(from, to),
      );
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
      const data = await fetchAllPages<{ po_line_item_id: string | null; produced_quantity: number | null; approved_quantity: number | null }>(
        (from, to) => supabase.from('work_items').select('po_line_item_id, produced_quantity, approved_quantity')
          .eq('organization_id', orgId).not('po_line_item_id', 'is', null).order('id').range(from, to),
      );
      const map = new Map<string, { produced: number; ordered: number }>();
      for (const row of data) {
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

  const visibleSupplyPOs = workOrderId ? (supplyPOs || []).filter(po => po.id === workOrderId) : (supplyPOs || []);
  const selectedPO = (supplyPOs || []).find((po) => po.id === form.purchase_order_id) || null;
  const selectedLineItem = selectedPO?.po_line_items.find((li) => li.id === form.po_line_item_id) || null;
  // One eligible designer needs no manual selection. Multiple designers still require a deliberate assignment.
  const effectiveDesignerId = form.designer_id || (designers?.length === 1 ? designers[0].id : '');

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
      if (form.artwork_source === 'agency' && !effectiveDesignerId) throw new Error('Choose the assigned designer, or select company-provided artwork.');
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
          designer_id: form.artwork_source === 'agency' ? effectiveDesignerId : null,
        });
        if (taskInsertError) throw new Error(`Could not create design task: ${taskInsertError.message}`);
      } else {
        const { error: taskUpdateError } = await supabase.from('design_tasks').update({ designer_id: form.artwork_source === 'agency' ? effectiveDesignerId : null }).eq('id', existingTask.id).select('id');
        if (taskUpdateError) throw new Error(`Could not assign designer: ${taskUpdateError.message}`);
      }
      // The designer needs to know they've got a new board to design — not
      // which PO or budget line it's billed against. PO context is an
      // owner/admin-only concern everywhere else on the Design Studio
      // screen too (see DesignerPage.tsx), so this notification text stays
      // scoped to just the work itself.
      if (form.artwork_source === 'agency' && effectiveDesignerId) await createNotification(effectiveDesignerId, 'New Design Task', `You've been assigned to design "${selectedLineItem.description}"`, 'info', '/design');

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
      setForm({ purchase_order_id: workOrderId, po_line_item_id: '', shop_mode: 'existing', shop_id: '', new_shop_name: '', new_shop_contact_person: '', new_shop_contact_phone: '', new_shop_address: '', quantity: '', designer_id: '', artwork_source: 'agency', notes: '' });
    },
  });

  return (
    <div>
      {poLoading && <p role="status" className="mb-3 text-sm text-slate-500">Loading Production & Delivery Work Orders…</p>}
      {poError && <p role="alert" className="mb-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">Could not load Production & Delivery Work Orders. Refresh to retry.</p>}
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
        {visibleSupplyPOs.map((po) => (
          <Card key={po.id} className="p-5">
            <div className="flex items-start justify-between mb-3">
              <div>
                <h3 className="font-semibold text-slate-900">{po.name || po.po_number}</h3>
                {po.name && <p className="text-xs text-slate-400">{po.po_number}</p>}
                <p className="text-sm text-slate-500">{po.clients?.name}</p>
              </div>
              <span className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-teal-100 text-teal-700">Production & Delivery</span>
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
        {!poLoading && !poError && visibleSupplyPOs.length === 0 && (
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

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Input label={`Quantity${selectedLineItem ? ` (${selectedLineItem.uom})` : ''}`} type="number" value={form.quantity} onChange={(v) => setForm({ ...form, quantity: v })} required />
            <Select label="Artwork source" value={form.artwork_source}
              onChange={(v) => setForm({ ...form, artwork_source: v })}
              options={[{value:'agency',label:'Agency will create artwork'},{value:'client',label:'Company artwork received'}]} />
            {form.artwork_source === 'agency' && <Select
              label="Assign Designer" value={effectiveDesignerId}
              onChange={(v) => setForm({ ...form, designer_id: v })}
              options={(designers || []).map((d) => ({ value: d.id, label: d.full_name }))} required />}
          </div>
          {form.artwork_source === 'client' && <p className="rounded-lg bg-blue-50 px-3 py-2 text-xs text-blue-800">No designer assignment. Upload the company artwork in Design Review, approve it internally, then release to Production. Approval is not skipped.</p>}
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
            disabled={createMutation.isPending || !form.purchase_order_id || !form.po_line_item_id || !form.quantity || (form.artwork_source === 'agency' && !effectiveDesignerId)}
            className="w-full flex items-center justify-center gap-2 bg-blue-600 hover:bg-blue-700 text-white font-medium py-2.5 rounded-lg transition disabled:opacity-50"
          >
            {createMutation.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
            {createMutation.isPending ? 'Creating...' : 'Create Entry & Continue'}
          </button>
          <p className="text-xs text-slate-400">Creates the correct Design Review task. Company artwork needs no assigned designer; owner/admin can upload and approve the supplied file before Production.</p>
        </div>
      </Modal>
    </div>
  );
}

function DispatchTab({ workOrderId }: { workOrderId: string }) {
  const { profile } = useAuth();
  const orgId = profile?.organization_id;
  const queryClient = useQueryClient();

  const [selectedShopIds, setSelectedShopIds] = useState<Set<string>>(new Set());
  const [destinationSearch, setDestinationSearch] = useState('');
  const [dispatchSelectionNotice, setDispatchSelectionNotice] = useState('');
  const [routeLimit, setRouteLimit] = useState(20);
  const [expandedRouteIds, setExpandedRouteIds] = useState<Set<string>>(new Set());
  const [visibleZoneCounts, setVisibleZoneCounts] = useState<Record<string, number>>({});
  const [selectedReceiptStopIds, setSelectedReceiptStopIds] = useState<Set<string>>(new Set());
  const [batchReceiptOpen, setBatchReceiptOpen] = useState(false);
  const [batchReceiptForm, setBatchReceiptForm] = useState({ received_by: '', proof_reference: '' });
  const [batchReceiptProgress, setBatchReceiptProgress] = useState<{done:number;total:number}|null>(null);
  const [batchReceiptFeedback, setBatchReceiptFeedback] = useState('');
  const [routeForm, setRouteForm] = useState({
    name: '', route_date: new Date().toISOString().split('T')[0], user_id: '',
    dispatch_mode: 'staff', transport_mode: '', tracking_reference: '',
  });
  const [createOpen, setCreateOpen] = useState(false);
  const dispatchRequestId = useRef<string | null>(null);
  const [receiptTarget, setReceiptTarget] = useState<{ id: string; name: string } | null>(null);
  const [receiptForm, setReceiptForm] = useState({ received_by: '', proof_reference: '', notes: '' });
  useEffect(() => { setSelectedShopIds(new Set()); setSelectedReceiptStopIds(new Set()); setDestinationSearch(''); setRouteLimit(20); setExpandedRouteIds(new Set()); setVisibleZoneCounts({}); setDispatchSelectionNotice(''); dispatchRequestId.current = null; }, [workOrderId]);

  useRealtimeInvalidate(['shops', 'routes', 'route_stops', 'supply_delivery_receipts'], orgId, [
    ['dispatch-ready-shops', orgId],
    ['dispatch-routes', orgId],
    ['po-billing-readiness', orgId],
  ]);

  const { data: readyShops } = useQuery({
    queryKey: ['dispatch-ready-shops', orgId, workOrderId],
    queryFn: async () => {
      let q = supabase.from('shops')
        .select('id, name, city, status, purchase_order_id, clients(name), zones(name), purchase_orders(fulfillment_type)')
        .eq('organization_id', orgId).eq('status', 'production_done')
        .order('id', { ascending: true });
      if (workOrderId) q = q.eq('purchase_order_id', workOrderId);
      const data = await fetchWorkflowFolderPages(async (from, to) => {
        const { data: pageRows, error } = await q.range(from, to);
        if (error) throw new Error(`Could not load dispatch destinations: ${error.message}`);
        return pageRows || [];
      });
      return (data as ReadySupplyShop[])
        .filter((shop) => shop.purchase_orders?.fulfillment_type === 'supply_only');
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
    queryKey: ['dispatch-routes', orgId, routeLimit],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('routes')
        .select('*, profiles:user_id(full_name), confirmed_by_profile:owner_confirmed_by(full_name), route_stops(id, shop_id, status, shops(name,purchase_order_id,purchase_orders(fulfillment_type)), supply_delivery_receipts(received_by,confirmed_at,proof_reference))')
        .eq('organization_id', orgId)
        .order('created_at', { ascending: false })
        .limit(routeLimit);
      if (error) throw error;
      return data as (Route & {
        profiles: { full_name: string } | null;
        confirmed_by_profile: { full_name: string } | null;
        route_stops: { id: string; shop_id: string; status: string; shops: { name: string; purchase_order_id: string | null; purchase_orders: { fulfillment_type: string } | null } | null; supply_delivery_receipts: { received_by: string; confirmed_at: string; proof_reference: string | null }[] | { received_by: string; confirmed_at: string; proof_reference: string | null } | null }[];
      })[];
    },
    enabled: !!orgId,
  });

  // §3.3's "Confirm to Owner" checkpoint (migration 0045) — an
  // Owner/Admin acknowledging that dispatch was arranged, between
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
      // dispatch was reviewed. Delivery receipt remains a separate checkpoint.
      const { data: accountsUsers } = await supabase.from('profiles').select('id').eq('organization_id', profile.organization_id).eq('role', 'accounts').eq('is_active', true);
      for (const u of accountsUsers || []) {
        await createNotification(u.id, 'Dispatch Confirmed', `${route.name || 'A dispatch route'} has been confirmed by ${profile.full_name} — receipt confirmation is required for new Production & Delivery Work Orders before billing.`, 'info', '/billing');
      }
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['dispatch-routes', orgId] }),
  });

  // Do not offer roles that the dispatch RPC will reject. One eligible staff
  // member can be preselected, avoiding an unnecessary dropdown selection.
  const deliveryStaff = useMemo(() => (staff || []).filter(person =>
    ['installer','admin','agency_owner','client_manager','printing'].includes(person.role)), [staff]);
  useEffect(() => {
    if (deliveryStaff.length === 1) {
      setRouteForm(previous => previous.user_id ? previous : ({...previous,user_id:deliveryStaff[0].id}));
    }
  }, [deliveryStaff]);

  const zoneGroups = useMemo(() => {
    const groups = new Map<string, ReadySupplyShop[]>();
    const term = destinationSearch.trim().toLowerCase();
    for (const shop of readyShops || []) {
      if (term && ![shop.name, shop.clients?.name, shop.zones?.name, shop.city].some(value => (value || '').toLowerCase().includes(term))) continue;
      const key = shop.zones?.name || 'No Zone';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(shop);
    }
    return Array.from(groups.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [readyShops, destinationSearch]);

  function toggleShop(id: string) {
    if (createRouteMutation.isPending) return;
    dispatchRequestId.current = null;
    setSelectedShopIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else if (next.size < MAX_DISPATCH_DESTINATIONS) next.add(id);
      else setDispatchSelectionNotice('One dispatch supports up to 200 destinations. Create this dispatch, then select the remaining sites.');
      return next;
    });
  }

  function changeRouteForm(next: typeof routeForm) {
    if (createRouteMutation.isPending) return;
    dispatchRequestId.current = null;
    setRouteForm(next);
  }

  const createRouteMutation = useMutation({
    mutationFn: async () => {
      if (selectedShopIds.size === 0 || selectedShopIds.size > MAX_DISPATCH_DESTINATIONS) throw new Error('Select 1–200 destinations per dispatch.');
      if (routeForm.dispatch_mode === 'staff' && !routeForm.user_id) throw new Error('Choose delivery staff.');
      if (routeForm.dispatch_mode === 'courier' && !routeForm.transport_mode.trim()) throw new Error('Enter the transport company.');
      // Reuse the same request ID after network failure/timeouts. The server
      // serializes retries and returns the original route without duplicating stops.
      if (!dispatchRequestId.current) dispatchRequestId.current = crypto.randomUUID();
      const { error } = await supabase.rpc('phase4_create_supply_dispatch', {
        p_request_id: dispatchRequestId.current,
        p_shop_ids: Array.from(selectedShopIds),
        p_name: routeForm.name.trim() || 'Supply dispatch',
        p_route_date: routeForm.route_date,
        p_driver_id: routeForm.dispatch_mode === 'staff' ? routeForm.user_id : null,
        p_transport_mode: routeForm.dispatch_mode === 'courier' ? routeForm.transport_mode.trim() : null,
        p_tracking_reference: routeForm.tracking_reference.trim() || null,
      });
      if (error) throw new Error(`Dispatch not saved: ${error.message}`);
    },
    onSuccess: () => {
      dispatchRequestId.current = null;
      queryClient.invalidateQueries({ queryKey: ['dispatch-ready-shops', orgId] });
      queryClient.invalidateQueries({ queryKey: ['dispatch-routes', orgId] });
      queryClient.invalidateQueries({ queryKey: ['shops', orgId] });
      queryClient.invalidateQueries({ queryKey: ['po-billing-readiness', orgId] });
      setSelectedShopIds(new Set());
      setCreateOpen(false);
      setRouteForm({ name: '', route_date: new Date().toISOString().split('T')[0], user_id: '', dispatch_mode: 'staff', transport_mode: '', tracking_reference: '' });
    },
  });

  const receiptMutation = useMutation({
    mutationFn: async () => {
      if (!receiptTarget) throw new Error('Select a destination.');
      if (receiptForm.received_by.trim().length < 2) throw new Error('Enter the recipient name.');
      const { error } = await supabase.rpc('phase4_confirm_supply_receipt', {
        p_route_stop_id: receiptTarget.id,
        p_received_by: receiptForm.received_by.trim(),
        p_proof_reference: receiptForm.proof_reference.trim() || null,
        p_notes: receiptForm.notes.trim() || null,
      });
      if (error) throw new Error(`Delivery receipt not recorded: ${error.message}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['dispatch-routes', orgId] });
      queryClient.invalidateQueries({ queryKey: ['shops', orgId] });
      queryClient.invalidateQueries({ queryKey: ['po-billing-readiness', orgId] });
      queryClient.invalidateQueries({ queryKey: ['billing-completed-shops', orgId] });
      queryClient.invalidateQueries({ queryKey: ['agency-operations-dashboard', orgId] });
      setReceiptTarget(null);
      setReceiptForm({ received_by: '', proof_reference: '', notes: '' });
    },
  });

  const canRecordReceipt = profile?.role === 'agency_owner' || profile?.role === 'admin';
  const supplyRoutes = (routes || []).filter(route => route.route_stops.some(stop =>
    stop.shops?.purchase_orders?.fulfillment_type === 'supply_only' &&
    (!workOrderId || stop.shops.purchase_order_id === workOrderId)))
    .sort((a, b) => {
      const pendingCount = (route: typeof a) => route.route_stops.filter(stop =>
        stop.status === 'pending' &&
        stop.shops?.purchase_orders?.fulfillment_type === 'supply_only' &&
        (!workOrderId || stop.shops.purchase_order_id === workOrderId) &&
        !(Array.isArray(stop.supply_delivery_receipts) ? stop.supply_delivery_receipts.length : stop.supply_delivery_receipts)
      ).length;
      return Number(pendingCount(b) > 0) - Number(pendingCount(a) > 0);
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
          Completed production destinations, grouped by zone. Dispatch creates a transport record; new orders become invoice-ready only after delivery receipt is confirmed.
        </p>
        <button
          onClick={() => setCreateOpen(true)}
          disabled={selectedShopIds.size === 0}
          className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg font-medium text-sm transition shrink-0 disabled:opacity-40"
        >
          <Truck className="w-4 h-4" /> Create Dispatch ({selectedShopIds.size})
        </button>
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2 rounded-xl border border-slate-200 bg-white p-3">
        <label className="flex min-w-[190px] flex-1 flex-col gap-1 text-xs font-medium text-slate-600">
          Find destination / client / zone
          <input type="search" value={destinationSearch} onChange={e => setDestinationSearch(e.target.value)}
            placeholder="Search ready destinations…" className="rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none" />
        </label>
        <div className="flex items-center gap-2 self-end flex-wrap">
          <span className="text-xs font-semibold text-slate-600">{selectedShopIds.size} selected · {readyShops?.length || 0} ready</span>
          <button type="button" disabled={createRouteMutation.isPending || zoneGroups.length === 0} onClick={() => {
            dispatchRequestId.current = null;
            setSelectedShopIds(previous => {
              const requested = [...previous, ...zoneGroups.flatMap(([,shops]) => shops.map(shop => shop.id))];
              const distinct = [...new Set(requested)];
              if (distinct.length > MAX_DISPATCH_DESTINATIONS)
                setDispatchSelectionNotice('Showing the first 200 selected destinations. Dispatch these first; remaining destinations stay ready.');
              return new Set(distinct.slice(0, MAX_DISPATCH_DESTINATIONS));
            });
          }} className="rounded-md border border-blue-200 bg-blue-50 px-2.5 py-2 text-xs font-semibold text-blue-700 disabled:opacity-50">
            Select visible ({zoneGroups.reduce((sum,[,shops]) => sum + shops.length, 0)})
          </button>
          <button type="button" disabled={createRouteMutation.isPending || selectedShopIds.size === 0} onClick={() => { dispatchRequestId.current = null; setSelectedShopIds(new Set()); }}
            className="rounded-md border border-slate-200 px-2.5 py-2 text-xs font-medium text-slate-600 disabled:opacity-50">Clear</button>
        </div>
      </div>
      {dispatchSelectionNotice && <p role="status" className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">{dispatchSelectionNotice}</p>}
      {zoneGroups.length === 0 ? (
        <Card><EmptyState icon={<Boxes className="w-12 h-12" />} title="Nothing ready for hand-off" subtitle="Complete a Supply Only production order in Production Studio first — it will appear here, grouped by zone, ready to distribute." /></Card>
      ) : (
        <div className="space-y-4 mb-8">
          {zoneGroups.map(([zoneName, shops]) => (
            <Card key={zoneName} className="p-4">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-semibold text-slate-700 flex items-center gap-1.5"><MapPin className="w-4 h-4 text-slate-400" /> {zoneName}</h3>
                <div className="flex flex-wrap items-center gap-1.5">
                  <button type="button" disabled={createRouteMutation.isPending || shops.length === 0}
                    onClick={() => {
                      dispatchRequestId.current = null;
                      setSelectedShopIds(new Set(shops.slice(0, MAX_DISPATCH_DESTINATIONS).map(shop => shop.id)));
                      if (shops.length > MAX_DISPATCH_DESTINATIONS) setDispatchSelectionNotice(`First ${MAX_DISPATCH_DESTINATIONS} ${zoneName} destinations selected. Dispatch the rest in the next batch.`);
                      else setDispatchSelectionNotice('');
                      setCreateOpen(true);
                    }}
                    className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-700 disabled:opacity-50">
                    Prepare dispatch ({Math.min(shops.length, MAX_DISPATCH_DESTINATIONS)})
                  </button>
                <button type="button" disabled={createRouteMutation.isPending} onClick={() => { dispatchRequestId.current = null; setSelectedShopIds(previous => {
                    const next = new Set(previous);
                    const allSelected = shops.every(shop => next.has(shop.id));
                    let added = 0;
                    for (const shop of shops) {
                      if (allSelected) next.delete(shop.id);
                      else if (next.has(shop.id)) continue;
                      else if (next.size < MAX_DISPATCH_DESTINATIONS) { next.add(shop.id); added++; }
                    }
                    if (!allSelected && added < shops.filter(shop => !previous.has(shop.id)).length)
                      setDispatchSelectionNotice('200 destinations selected (server limit). Dispatch these first, then continue with the remaining shops.');
                    return next;
                  }); }} className="rounded-lg border border-blue-200 bg-blue-50 px-2.5 py-1.5 text-xs font-semibold text-blue-700 hover:bg-blue-100 disabled:opacity-50">
                  {shops.every(shop => selectedShopIds.has(shop.id)) ? 'Clear zone' : `Select all ${shops.length}`}
                </button>
                </div>
              </div>
              <div className="space-y-1.5">
                {shops.slice(0, visibleZoneCounts[zoneName] ?? 12).map((shop) => (
                  <button
                    key={shop.id}
                    disabled={createRouteMutation.isPending}
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
                {shops.length > (visibleZoneCounts[zoneName] ?? 12) && (
                  <button type="button" onClick={() => setVisibleZoneCounts(prev => ({ ...prev, [zoneName]: (prev[zoneName] ?? 12) + 50 }))}
                    className="mt-2 w-full rounded-lg border border-slate-200 py-2 text-xs font-semibold text-blue-700 hover:bg-blue-50">
                    Show 50 more destinations · {shops.length - (visibleZoneCounts[zoneName] ?? 12)} remaining
                  </button>
                )}
              </div>
            </Card>
          ))}
        </div>
      )}

      <div className="flex items-center gap-2 mb-3">
        <span className="flex items-center justify-center w-5 h-5 rounded-full bg-blue-100 text-blue-700 text-[11px] font-semibold shrink-0">2</span>
        <h3 className="text-sm font-semibold text-slate-800 flex items-center gap-1.5"><Truck className="w-4 h-4 text-blue-500" /> Dispatch tracking &amp; delivery receipts</h3>
      </div>
      {canRecordReceipt && selectedReceiptStopIds.size > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-3 rounded-lg border border-teal-200 bg-teal-50 px-3 py-2">
          <span className="text-xs font-semibold text-teal-800">{selectedReceiptStopIds.size} pending delivery receipts selected</span>
          <button type="button" onClick={() => setBatchReceiptOpen(true)} className="ml-auto rounded-md bg-teal-700 px-3 py-2 text-xs font-semibold text-white hover:bg-teal-800">Confirm selected receipts</button>
          <button type="button" onClick={() => setSelectedReceiptStopIds(new Set())} className="text-xs font-semibold text-teal-700">Clear</button>
        </div>
      )}
      <div className="space-y-2">
        {supplyRoutes.map((route) => (
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
              <div className="flex items-center gap-2 flex-wrap">
                {canRecordReceipt && route.route_stops.some(stop => stop.status === 'pending' && !(Array.isArray(stop.supply_delivery_receipts) ? stop.supply_delivery_receipts.length : stop.supply_delivery_receipts) && stop.shops?.purchase_orders?.fulfillment_type === 'supply_only' && (!workOrderId || stop.shops.purchase_order_id === workOrderId)) && (
                  <button type="button" disabled={!!batchReceiptProgress} onClick={() => {
                    const stops = route.route_stops.filter(stop => stop.status === 'pending' && !(Array.isArray(stop.supply_delivery_receipts) ? stop.supply_delivery_receipts.length : stop.supply_delivery_receipts) && stop.shops?.purchase_orders?.fulfillment_type === 'supply_only' && (!workOrderId || stop.shops.purchase_order_id === workOrderId));
                    setSelectedReceiptStopIds(previous => new Set([...previous,...stops.map(stop=>stop.id)]));
                  }} className="rounded-md border border-teal-200 bg-teal-50 px-2 py-1.5 text-xs font-semibold text-teal-700 disabled:opacity-50">
                    Select route receipts
                  </button>
                )}
                <span className="rounded-md bg-amber-50 px-2 py-1 text-xs font-semibold text-amber-800" aria-label="Outstanding delivery receipts">
                  {route.route_stops.filter(stop => stop.status === 'pending' && stop.shops?.purchase_orders?.fulfillment_type === 'supply_only' && (!workOrderId || stop.shops.purchase_order_id === workOrderId) && !(Array.isArray(stop.supply_delivery_receipts) ? stop.supply_delivery_receipts.length : stop.supply_delivery_receipts)).length} awaiting receipt
                </span>
                <button type="button" aria-expanded={expandedRouteIds.has(route.id)} aria-controls={`dispatch-route-${route.id}`}
                  onClick={() => setExpandedRouteIds(prev => { const next = new Set(prev); if (next.has(route.id)) next.delete(route.id); else next.add(route.id); return next; })}
                  className="rounded-md border border-slate-200 px-2.5 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50">
                  {expandedRouteIds.has(route.id) ? 'Hide destinations' : `View destinations (${route.route_stops.filter(stop => stop.shops?.purchase_orders?.fulfillment_type === 'supply_only' && (!workOrderId || stop.shops.purchase_order_id === workOrderId)).length})`}
                </button>
                <StatusBadge status={route.status} />
              </div>
            </div>
            {expandedRouteIds.has(route.id) && <div id={`dispatch-route-${route.id}`} className="flex flex-wrap gap-1.5 mb-3">
              {route.route_stops.filter(stop => stop.shops?.purchase_orders?.fulfillment_type === 'supply_only' && (!workOrderId || stop.shops.purchase_order_id === workOrderId)).map(stop => {
                const receipt = Array.isArray(stop.supply_delivery_receipts) ? stop.supply_delivery_receipts[0] : stop.supply_delivery_receipts;
                return <div key={stop.id} className="inline-flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-2 text-xs">
                  {canRecordReceipt && !receipt && stop.status === 'pending' && (
                    <label className="inline-flex items-center gap-1.5" title="Include in shared-recipient receipt confirmation">
                      <input type="checkbox" checked={selectedReceiptStopIds.has(stop.id)} disabled={!!batchReceiptProgress}
                        onChange={event => setSelectedReceiptStopIds(prev => {
                          const next = new Set(prev);
                          if (event.target.checked) next.add(stop.id); else next.delete(stop.id);
                          return next;
                        })} className="h-4 w-4 rounded border-slate-300" />
                      <span className="sr-only">Select receipt for {stop.shops?.name || 'destination'}</span>
                    </label>
                  )}
                  <span className="font-medium text-slate-700">{stop.shops?.name || 'Destination'}</span>
                  {receipt ? <span className="font-semibold text-emerald-700" title={`Received by ${receipt.received_by}`}>Received · {receipt.received_by}</span>
                    : canRecordReceipt && stop.status === 'pending' ? <button type="button" onClick={() => {
                        setReceiptTarget({ id:stop.id, name:stop.shops?.name || 'Destination' });
                        setReceiptForm({ received_by:'',proof_reference:'',notes:'' });
                      }} className="rounded-md bg-blue-600 px-2.5 py-1.5 font-semibold text-white hover:bg-blue-700">Mark received</button>
                    : <span className="text-amber-800">Awaiting receipt</span>}
                </div>;
              })}
            </div>}
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
                  {confirmDispatchMutation.isPending ? 'Confirming...' : 'Acknowledge Dispatch'}
                </button>
              ) : (
                <p className="text-xs text-amber-600">Awaiting Owner/Admin confirmation</p>
              )}
            </div>
          </Card>
        ))}
        {supplyRoutes.length === 0 && <p className="text-sm text-slate-400">No supply dispatch routes for this Work Order yet.</p>}
        {(routes?.length || 0) >= routeLimit && (
          <button type="button" onClick={() => setRouteLimit(value => value + 20)}
            className="w-full rounded-lg border border-slate-200 bg-white py-2 text-xs font-semibold text-blue-700 hover:bg-slate-50">
            Load 20 earlier dispatch records
          </button>
        )}
        {batchReceiptFeedback && <div role="status" className="rounded-lg border border-blue-200 bg-blue-50 p-3 text-xs text-blue-800">{batchReceiptFeedback}</div>}
      </div>

      <Modal open={batchReceiptOpen} onClose={() => { if (!batchReceiptProgress) setBatchReceiptOpen(false); }} title="Confirm selected delivery receipts">
        <div className="space-y-3">
          <p className="text-sm text-slate-600">Confirm only destinations actually received by <strong>the same named recipient</strong>. Different recipients should be confirmed separately. Every destination is independently validated by the server.</p>
          <p className="text-xs font-semibold text-teal-800">{selectedReceiptStopIds.size} destinations</p>
          <Input label="Received by (same person for all) *" value={batchReceiptForm.received_by} onChange={v => setBatchReceiptForm(prev => ({...prev,received_by:v}))} placeholder="Recipient's name" />
          <Input label="Shared delivery reference (optional)" value={batchReceiptForm.proof_reference} onChange={v => setBatchReceiptForm(prev => ({...prev,proof_reference:v}))} placeholder="LR / acknowledgment number" />
          {batchReceiptProgress && <p role="status" aria-live="polite" className="text-xs font-semibold text-blue-700">Recording {batchReceiptProgress.done}/{batchReceiptProgress.total} receipts…</p>}
          <button type="button" onClick={async () => {
            if (batchReceiptProgress || batchReceiptForm.received_by.trim().length < 2) return;
            const ids = [...selectedReceiptStopIds];
            setBatchReceiptProgress({done:0,total:ids.length}); setBatchReceiptFeedback('');
            try {
              const result = await runBoundedWorkflowBatch(ids, async id => {
                const { error } = await supabase.rpc('phase4_confirm_supply_receipt', {
                  p_route_stop_id: id,
                  p_received_by: batchReceiptForm.received_by.trim(),
                  p_proof_reference: batchReceiptForm.proof_reference.trim() || null,
                  p_notes: null,
                });
                if (error) throw new Error(error.message);
              },(done,total) => setBatchReceiptProgress({done,total}),3);
              setBatchReceiptFeedback(summarizeWorkflowBatch(result, 'receipts confirmed', id => `Stop ${id.slice(0,8)}`));
              const successful = new Set(result.completed);
              setSelectedReceiptStopIds(prev => new Set([...prev].filter(id => !successful.has(id))));
              queryClient.invalidateQueries({ queryKey: ['dispatch-routes', orgId] });
              queryClient.invalidateQueries({ queryKey: ['shops', orgId] });
              queryClient.invalidateQueries({ queryKey: ['po-billing-readiness', orgId] });
              queryClient.invalidateQueries({ queryKey: ['billing-completed-shops', orgId] });
              queryClient.invalidateQueries({ queryKey: ['agency-operations-dashboard', orgId] });
              if (!result.failed.length) { setBatchReceiptOpen(false); setBatchReceiptForm({received_by:'',proof_reference:''}); }
            } catch (cause) { setBatchReceiptFeedback(cause instanceof Error ? cause.message : String(cause)); }
            finally { setBatchReceiptProgress(null); }
          }} disabled={!!batchReceiptProgress || selectedReceiptStopIds.size === 0 || batchReceiptForm.received_by.trim().length < 2}
            className="w-full rounded-lg bg-teal-700 px-4 py-2.5 text-sm font-semibold text-white hover:bg-teal-800 disabled:opacity-50">
            {batchReceiptProgress ? 'Recording…' : `Confirm ${selectedReceiptStopIds.size} delivered destinations`}
          </button>
        </div>
      </Modal>

      <Modal open={!!receiptTarget} onClose={() => { if (!receiptMutation.isPending) setReceiptTarget(null); }} title="Confirm delivery received">
        <div className="space-y-3">
          <p className="text-sm text-slate-600">{receiptTarget?.name} · record the recipient, not only that material was dispatched.</p>
          <Input label="Received by *" value={receiptForm.received_by} onChange={value => setReceiptForm(v => ({...v,received_by:value}))} placeholder="Recipient / store representative" />
          <Input label="Proof / LR / acknowledgment reference" value={receiptForm.proof_reference} onChange={value => setReceiptForm(v => ({...v,proof_reference:value}))} placeholder="Optional reference" />
          <Textarea label="Notes (optional)" value={receiptForm.notes} onChange={value => setReceiptForm(v => ({...v,notes:value}))} rows={2} />
          {receiptMutation.isError && <p role="alert" className="text-xs text-red-700">{(receiptMutation.error as Error).message}</p>}
          <button type="button" onClick={() => receiptMutation.mutate()} disabled={receiptMutation.isPending || receiptForm.received_by.trim().length < 2}
            className="w-full rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50">
            {receiptMutation.isPending ? 'Recording…' : 'Confirm received & update progress'}
          </button>
        </div>
      </Modal>

      <Modal open={createOpen} onClose={() => { if (!createRouteMutation.isPending) setCreateOpen(false); }} title="Create Dispatch Route">
        <div className="space-y-4">
          <p className="text-xs text-slate-500">{selectedShopIds.size} shop(s) selected.</p>
          <Input label="Route Name (optional)" value={routeForm.name} onChange={(v) => changeRouteForm({ ...routeForm, name: v })} placeholder="e.g. Jalgaon Zone Delivery" />
          <Input label="Delivery Date" type="date" value={routeForm.route_date} onChange={(v) => changeRouteForm({ ...routeForm, route_date: v })} required />

          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Dispatch By</label>
            <div className="flex gap-2 mb-2">
              <button
                type="button"
                onClick={() => changeRouteForm({ ...routeForm, dispatch_mode: 'staff' })}
                className={`flex-1 px-3 py-1.5 rounded-lg text-xs font-medium border ${routeForm.dispatch_mode === 'staff' ? 'border-blue-600 bg-blue-50 text-blue-700' : 'border-slate-200 text-slate-500'}`}
              >
                Own staff / vehicle
              </button>
              <button
                type="button"
                onClick={() => changeRouteForm({ ...routeForm, dispatch_mode: 'courier' })}
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
              onChange={(v) => changeRouteForm({ ...routeForm, user_id: v })}
              options={deliveryStaff.map((s) => ({ value: s.id, label: `${s.full_name} (${s.role})` }))}
              required
            />
          ) : (
            <Input
              label="Transport Mode / Courier Name"
              value={routeForm.transport_mode}
              onChange={(v) => changeRouteForm({ ...routeForm, transport_mode: v })}
              placeholder="e.g. Blue Dart, Local Transport Co."
              required
            />
          )}
          <Input
            label="Tracking Reference (optional)"
            value={routeForm.tracking_reference}
            onChange={(v) => changeRouteForm({ ...routeForm, tracking_reference: v })}
            placeholder="AWB / consignment / LR number"
          />

          {createRouteMutation.isError && <p className="text-sm text-red-600">{(createRouteMutation.error as Error).message}</p>}
          <button
            onClick={() => createRouteMutation.mutate()}
            disabled={createRouteMutation.isPending || (routeForm.dispatch_mode === 'staff' ? !routeForm.user_id : !routeForm.transport_mode.trim())}
            className="w-full flex items-center justify-center gap-2 bg-blue-600 hover:bg-blue-700 text-white font-medium py-2.5 rounded-lg transition disabled:opacity-50"
          >
            {createRouteMutation.isPending ? 'Creating...' : 'Create Dispatch'}
          </button>
        </div>
      </Modal>
    </div>
  );
}
