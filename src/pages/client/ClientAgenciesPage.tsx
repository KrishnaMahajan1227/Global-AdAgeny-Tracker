import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { Card, EmptyState, PageHeader, StatusBadge, Modal, Input, ConfirmDialog, Combobox } from '@/components/ui';
import { logAudit } from '@/lib/helpers';
import type { ClientAgencyLink, PurchaseOrder } from '@/lib/types';
import { siteBucket } from '@/lib/clientPortal';
import { INDIA_STATES, INDIA_CITIES_BY_STATE, ALL_INDIA_CITIES } from '@/lib/indiaLocations';
import { Building2, ShoppingCart, Store, Plus, Loader2, Pencil, Ban, Link2, AlertCircle, Star, TrendingUp, TrendingDown, Shield } from 'lucide-react';

type LinkRow = ClientAgencyLink & { agency_org: { name: string; phone: string | null; email: string | null; address: string | null; gst_number: string | null } | null };
type ShopRow = { id: string; status: string; purchase_order_id: string | null };

const emptyAddForm = {
  agency_org_name: '', admin_full_name: '', admin_email: '', admin_phone: '', admin_password: '',
  contact_person: '', contact_phone: '', contact_email: '', city: '', state: '', gst_number: '',
};
const emptyEditForm = { name: '', phone: '', email: '', address: '', gst_number: '' };
const emptyLinkForm = { invite_code: '', contact_person: '', contact_phone: '', contact_email: '' };

// Agencies — the client's own list of who they work with, and it's the
// client who drives this: "Add Agency" creates a brand-new Agency
// Organization on the platform AND its first dashboard login in one step
// (client_invite_agency_org, migration 0050) — the client decides which
// company gets added, not the other way around. An agency that instead
// invited THIS client (the older, still-supported direction) shows up
// here too, just without Edit (a client can only edit the profile of an
// agency it added itself — enforced by RLS, and mirrored in the UI by
// only offering Edit where the update actually succeeds).
export default function ClientAgenciesPage() {
  const { profile } = useAuth();
  const orgId = profile?.organization_id;
  const queryClient = useQueryClient();

  const [addOpen, setAddOpen] = useState(false);
  const [addForm, setAddForm] = useState(emptyAddForm);
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkForm, setLinkForm] = useState(emptyLinkForm);
  const [editTarget, setEditTarget] = useState<LinkRow | null>(null);
  const [editForm, setEditForm] = useState(emptyEditForm);
  const [editDenied, setEditDenied] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<LinkRow | null>(null);

  const { data: links, isLoading } = useQuery({
    queryKey: ['client-agencies-links', orgId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('client_agency_links')
        .select('*, agency_org:organizations!client_agency_links_agency_org_id_fkey(name, phone, email, address, gst_number)')
        .eq('client_org_id', orgId)
        .neq('status', 'revoked')
        .order('created_at', { ascending: false });
      if (error) throw error;
      return data as LinkRow[];
    },
    enabled: !!orgId,
  });

  const { data: pos } = useQuery({
    queryKey: ['client-agencies-pos', orgId],
    queryFn: async () => {
      const { data, error } = await supabase.from('purchase_orders').select('id, assigned_agency_id, status').eq('client_org_id', orgId);
      if (error) throw error;
      return data as Pick<PurchaseOrder, 'id' | 'assigned_agency_id' | 'status'>[];
    },
    enabled: !!orgId,
  });

  const { data: shops } = useQuery({
    queryKey: ['client-agencies-shops', orgId],
    queryFn: async () => {
      const { data, error } = await supabase.from('shops').select('id, status, purchase_order_id');
      if (error) throw error;
      return data as ShopRow[];
    },
    enabled: !!orgId,
  });

  // Powers the monthly performance numbers below (migration 0073 grants
  // this read) — completed_at is the one piece of real timing data this
  // portal can see, with zero money attached to it.
  const { data: installJobs } = useQuery({
    queryKey: ['client-agencies-install-jobs', orgId],
    queryFn: async () => {
      const { data, error } = await supabase.from('installation_jobs').select('shop_id, status, completed_at');
      if (error) throw error;
      return data as { shop_id: string; status: string; completed_at: string | null }[];
    },
    enabled: !!orgId,
  });

  // ---- CREATE — add a brand-new agency + its first login ----
  const addMutation = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.rpc('client_invite_agency_org', {
        p_agency_org_name: addForm.agency_org_name,
        p_admin_full_name: addForm.admin_full_name,
        p_admin_email: addForm.admin_email,
        p_admin_phone: addForm.admin_phone,
        p_admin_password: addForm.admin_password,
        p_contact_person: addForm.contact_person || null,
        p_contact_phone: addForm.contact_phone || null,
        p_contact_email: addForm.contact_email || null,
        p_city: addForm.city || null,
        p_state: addForm.state || null,
        p_gst_number: addForm.gst_number || null,
      });
      if (error) throw new Error(error.message.replace(/^.*?:\s*/, ''));
      await logAudit('organizations', data as string, 'insert', null, null, null, `Added agency ${addForm.agency_org_name}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['client-agencies-links', orgId] });
      setAddOpen(false);
      setAddForm(emptyAddForm);
    },
  });

  // ---- CREATE (self-serve link) — request to link an EXISTING agency by
  // their invite code. Goes to status='invited' until that agency accepts
  // (agency_accept_client_link) — that's the step which creates a
  // matching `clients` row on THEIR side, same reasoning as addMutation
  // above but the other org is the one running the RPC. ----
  const linkMutation = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.rpc('client_request_agency_link', {
        p_invite_code: linkForm.invite_code,
        p_contact_person: linkForm.contact_person || null,
        p_contact_phone: linkForm.contact_phone || null,
        p_contact_email: linkForm.contact_email || null,
      });
      if (error) throw new Error(error.message.replace(/^.*?:\s*/, ''));
      await logAudit('client_agency_links', null, 'insert', null, null, null, `Requested to link agency with invite code ${linkForm.invite_code.toUpperCase()}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['client-agencies-links', orgId] });
      setLinkOpen(false);
      setLinkForm(emptyLinkForm);
    },
  });

  // ---- UPDATE — edit an agency's basic profile (own-added agencies only, RLS-enforced) ----
  const editMutation = useMutation({
    mutationFn: async () => {
      if (!editTarget) return;
      const { data, error } = await supabase
        .from('organizations')
        .update({
          name: editForm.name,
          phone: editForm.phone || null,
          email: editForm.email || null,
          address: editForm.address || null,
          gst_number: editForm.gst_number || null,
        })
        .eq('id', editTarget.agency_org_id)
        .select('id');
      if (error) throw error;
      // RLS silently filters rows it won't let through rather than
      // erroring — zero rows back means "not yours to edit", not success.
      if (!data || data.length === 0) throw new Error('__RLS_DENIED__');
      await logAudit('organizations', editTarget.agency_org_id, 'update', null, null, null, `Edited agency ${editForm.name}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['client-agencies-links', orgId] });
      setEditTarget(null);
    },
    onError: (err: Error) => {
      if (err.message === '__RLS_DENIED__') setEditDenied(true);
    },
  });

  // ---- DELETE (soft) — remove the link, never the agency's own tenant/login ----
  const removeMutation = useMutation({
    mutationFn: async (link: LinkRow) => {
      const { error } = await supabase.from('client_agency_links').update({ status: 'revoked' }).eq('id', link.id);
      if (error) throw error;
      await logAudit('client_agency_links', link.id, 'update', 'status', link.status, 'revoked', `Removed ${link.agency_org?.name || 'agency'} from client agency list`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['client-agencies-links', orgId] });
      setRemoveTarget(null);
    },
  });

  function openEdit(link: LinkRow) {
    setEditForm({
      name: link.agency_org?.name || '',
      phone: link.agency_org?.phone || '',
      email: link.agency_org?.email || '',
      address: link.agency_org?.address || '',
      gst_number: link.agency_org?.gst_number || '',
    });
    setEditDenied(false);
    setEditTarget(link);
  }

  const poById = new Map((pos || []).map((p) => [p.id, p]));

  // Automated rating — purely a function of real completion data, no
  // manual/subjective input. Bands are deliberately coarse (half-star
  // steps) so a single shop's status flip doesn't visibly swing an
  // agency's rating day to day.
  function ratingForPct(pct: number | null): { stars: number; label: string } {
    if (pct == null) return { stars: 0, label: 'Not enough data yet' };
    if (pct >= 90) return { stars: 5, label: 'Excellent' };
    if (pct >= 75) return { stars: 4.5, label: 'Very Good' };
    if (pct >= 60) return { stars: 4, label: 'Good' };
    if (pct >= 40) return { stars: 3, label: 'Average' };
    if (pct >= 20) return { stars: 2, label: 'Needs Improvement' };
    return { stars: 1, label: 'Just Getting Started' };
  }

  const now = new Date();
  const thisMonthKey = `${now.getFullYear()}-${now.getMonth()}`;
  const lastMonthDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const lastMonthKey = `${lastMonthDate.getFullYear()}-${lastMonthDate.getMonth()}`;

  function monthlyPerformance(agencyOrgId: string) {
    let thisMonth = 0, lastMonth = 0;
    for (const job of installJobs || []) {
      if (job.status !== 'completed') continue;
      if (!job.completed_at) continue;
      const shop = (shops || []).find((s) => s.id === job.shop_id);
      const po = shop?.purchase_order_id ? poById.get(shop.purchase_order_id) : null;
      if (!po || po.assigned_agency_id !== agencyOrgId) continue;
      const d = new Date(job.completed_at);
      const key = `${d.getFullYear()}-${d.getMonth()}`;
      if (key === thisMonthKey) thisMonth++;
      else if (key === lastMonthKey) lastMonth++;
    }
    return { thisMonth, lastMonth };
  }

  return (
    <div>
      <PageHeader
        title="Agencies"
        subtitle="The companies you work with — add a new one, or manage agencies already linked to you"
        action={
          <div className="flex items-center gap-2">
            <button onClick={() => setLinkOpen(true)} className="flex items-center gap-2 bg-white border border-slate-300 hover:bg-slate-50 text-slate-700 px-4 py-2 rounded-lg font-medium text-sm transition">
              <Link2 className="w-4 h-4" /> Link Existing Agency
            </button>
            <button onClick={() => setAddOpen(true)} className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg font-medium text-sm transition">
              <Plus className="w-4 h-4" /> Add Agency
            </button>
          </div>
        }
      />

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {(links || []).map((link) => {
          const poCount = (pos || []).filter((p) => p.assigned_agency_id === link.agency_org_id && p.status !== 'cancelled').length;
          let total = 0, completed = 0;
          for (const s of shops || []) {
            const po = s.purchase_order_id ? poById.get(s.purchase_order_id) : null;
            if (!po || po.assigned_agency_id !== link.agency_org_id) continue;
            const bucket = siteBucket(s.status);
            if (bucket === 'cancelled') continue;
            total += 1;
            if (bucket === 'completed') completed += 1;
          }
          const pct = total > 0 ? Math.round((completed / total) * 100) : null;
          const rating = ratingForPct(pct);
          const monthly = monthlyPerformance(link.agency_org_id);
          const trend = monthly.thisMonth - monthly.lastMonth;

          return (
            <Card key={link.id} className="p-5">
              <div className="flex items-start justify-between mb-3">
                <div className="flex items-center gap-2.5">
                  <div className="w-9 h-9 rounded-lg bg-blue-50 flex items-center justify-center shrink-0">
                    <Building2 className="w-4.5 h-4.5 text-blue-600" />
                  </div>
                  <div>
                    <p className="font-semibold text-slate-900">{link.agency_org?.name || 'Agency'}</p>
                    <StatusBadge status={link.status} />
                  </div>
                </div>
              </div>
              {link.status === 'invited' ? (
                <>
                  <p className="text-xs text-amber-600 mb-3">Waiting for them to accept your link request.</p>
                  <div className="flex items-center gap-2 pt-2 border-t border-slate-100">
                    <button onClick={() => setRemoveTarget(link)} className="flex items-center gap-1 text-xs text-slate-500 hover:text-red-600 px-2 py-1 border border-slate-200 rounded">
                      <Ban className="w-3 h-3" /> Cancel Request
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <div className="grid grid-cols-2 gap-3 text-sm mb-3">
                    <div className="flex items-center gap-1.5 text-slate-600"><ShoppingCart className="w-3.5 h-3.5 text-slate-400" /> {poCount} Work Order{poCount === 1 ? '' : 's'}</div>
                    <div className="flex items-center gap-1.5 text-slate-600"><Store className="w-3.5 h-3.5 text-slate-400" /> {total} site{total === 1 ? '' : 's'}</div>
                  </div>

                  {/* Performance — automated, purely from completion data.
                      Star rating is a deterministic band off overall %
                      complete; the monthly figures come from real
                      installation completion dates (migration 0073). */}
                  <div className="bg-slate-50 border border-slate-100 rounded-lg p-3 mb-3">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-xs font-medium text-slate-500">Performance</span>
                      <StarRating stars={rating.stars} label={rating.label} />
                    </div>
                    <div className="mb-2">
                      <div className="flex items-center justify-between text-xs mb-1">
                        <span className="text-slate-500">Overall completion</span>
                        <span className="font-semibold text-slate-800">{pct != null ? `${pct}%` : '—'}</span>
                      </div>
                      <div className="h-1.5 bg-slate-200 rounded-full overflow-hidden">
                        <div className="h-full bg-blue-500 rounded-full" style={{ width: `${pct ?? 0}%` }} />
                      </div>
                    </div>
                    <div className="flex items-center justify-between text-xs pt-2 border-t border-slate-200">
                      <span className="text-slate-500">This month</span>
                      <span className="font-semibold text-slate-800 flex items-center gap-1">
                        {monthly.thisMonth} site{monthly.thisMonth === 1 ? '' : 's'} installed
                        {trend !== 0 && (
                          <span className={`inline-flex items-center gap-0.5 font-medium ${trend > 0 ? 'text-emerald-600' : 'text-red-500'}`}>
                            {trend > 0 ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
                            {Math.abs(trend)} vs last month
                          </span>
                        )}
                      </span>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 pt-2 border-t border-slate-100">
                    <button onClick={() => openEdit(link)} className="flex items-center gap-1 text-xs text-slate-500 hover:text-blue-600 px-2 py-1 border border-slate-200 rounded">
                      <Pencil className="w-3 h-3" /> Edit
                    </button>
                    <button onClick={() => setRemoveTarget(link)} className="flex items-center gap-1 text-xs text-slate-500 hover:text-red-600 px-2 py-1 border border-slate-200 rounded">
                      <Ban className="w-3 h-3" /> Remove
                    </button>
                  </div>
                </>
              )}
            </Card>
          );
        })}
        {!isLoading && (links || []).length === 0 && (
          <Card className="col-span-full">
            <EmptyState
              icon={<Building2 className="w-12 h-12" />}
              title="No agencies yet"
              subtitle='Click "Add Agency" to add the first company you work with and create their dashboard login'
            />
          </Card>
        )}
      </div>

      {/* CREATE */}
      <Modal open={addOpen} onClose={() => setAddOpen(false)} title="Add Agency" size="lg">
        <div className="space-y-4">
          <Input label="Agency Name" value={addForm.agency_org_name} onChange={(v) => setAddForm({ ...addForm, agency_org_name: v })} placeholder="e.g. Darshan Ad Agency" required />

          <div className="border-t border-slate-100 pt-4">
            <p className="text-sm font-medium text-slate-700 mb-3">Their first login (Agency Owner)</p>
            <div className="space-y-4">
              <Input label="Full Name" value={addForm.admin_full_name} onChange={(v) => setAddForm({ ...addForm, admin_full_name: v })} required />
              <div className="grid grid-cols-2 gap-4">
                <Input label="Email" type="email" value={addForm.admin_email} onChange={(v) => setAddForm({ ...addForm, admin_email: v })} required />
                <Input label="Phone" value={addForm.admin_phone} onChange={(v) => setAddForm({ ...addForm, admin_phone: v })} placeholder="+91 90000 00000" />
              </div>
              <Input label="Initial Password" type="password" value={addForm.admin_password} onChange={(v) => setAddForm({ ...addForm, admin_password: v })} required />
            </div>
          </div>

          <div className="border-t border-slate-100 pt-4">
            <p className="text-sm font-medium text-slate-700 mb-3">Business details (optional — for your own records)</p>
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <Input label="Contact Person" value={addForm.contact_person} onChange={(v) => setAddForm({ ...addForm, contact_person: v })} />
                <Input label="Contact Phone" value={addForm.contact_phone} onChange={(v) => setAddForm({ ...addForm, contact_phone: v })} />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <Input label="Contact Email" type="email" value={addForm.contact_email} onChange={(v) => setAddForm({ ...addForm, contact_email: v })} />
                <Input label="GST Number" value={addForm.gst_number} onChange={(v) => setAddForm({ ...addForm, gst_number: v })} />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <Combobox label="City" value={addForm.city} onChange={(v) => setAddForm({ ...addForm, city: v })} options={addForm.state && INDIA_CITIES_BY_STATE[addForm.state] ? INDIA_CITIES_BY_STATE[addForm.state] : ALL_INDIA_CITIES} />
                <Combobox label="State" value={addForm.state} onChange={(v) => setAddForm({ ...addForm, state: v })} options={INDIA_STATES} />
              </div>
            </div>
          </div>

          {addMutation.isError && <p className="text-sm text-red-600">{(addMutation.error as Error).message}</p>}

          <button
            onClick={() => addMutation.mutate()}
            disabled={addMutation.isPending || !addForm.agency_org_name || !addForm.admin_full_name || !addForm.admin_email || !addForm.admin_password}
            className="w-full flex items-center justify-center gap-2 bg-blue-600 hover:bg-blue-700 text-white font-medium py-2.5 rounded-lg transition disabled:opacity-50"
          >
            {addMutation.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
            {addMutation.isPending ? 'Creating...' : 'Add Agency & Create Login'}
          </button>
        </div>
      </Modal>

      {/* CREATE (self-serve link) — link an agency that already exists on the platform */}
      <Modal open={linkOpen} onClose={() => setLinkOpen(false)} title="Link Existing Agency" size="md">
        <div className="space-y-4">
          <div className="flex items-start gap-2.5 bg-blue-50 border border-blue-100 rounded-lg px-3 py-2.5 text-sm text-blue-800">
            <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
            <p>Ask the agency for their invite code (they can find it on their own Platform Clients screen). They'll need to accept your request before you can create campaigns/POs with them.</p>
          </div>
          <div className="flex items-start gap-2.5 bg-emerald-50 border border-emerald-100 rounded-lg px-3 py-2.5 text-xs text-emerald-800">
            <Shield className="w-4 h-4 mt-0.5 shrink-0" />
            <p>Private by design: this only tells the agency that someone with this code wants to link. No pricing, other clients, or your other agency relationships are visible to them — or to you about them — until you both confirm, and even then only what your own campaigns actually need to share.</p>
          </div>
          <Input
            label="Agency Invite Code"
            value={linkForm.invite_code}
            onChange={(v) => setLinkForm({ ...linkForm, invite_code: v.toUpperCase() })}
            placeholder="e.g. AB12CD34"
            required
          />
          <div className="border-t border-slate-100 pt-4">
            <p className="text-sm font-medium text-slate-700 mb-3">Your contact details for them (optional)</p>
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <Input label="Contact Person" value={linkForm.contact_person} onChange={(v) => setLinkForm({ ...linkForm, contact_person: v })} />
                <Input label="Contact Phone" value={linkForm.contact_phone} onChange={(v) => setLinkForm({ ...linkForm, contact_phone: v })} />
              </div>
              <Input label="Contact Email" type="email" value={linkForm.contact_email} onChange={(v) => setLinkForm({ ...linkForm, contact_email: v })} />
            </div>
          </div>

          {linkMutation.isError && <p className="text-sm text-red-600">{(linkMutation.error as Error).message}</p>}

          <button
            onClick={() => linkMutation.mutate()}
            disabled={linkMutation.isPending || !linkForm.invite_code}
            className="w-full flex items-center justify-center gap-2 bg-blue-600 hover:bg-blue-700 text-white font-medium py-2.5 rounded-lg transition disabled:opacity-50"
          >
            {linkMutation.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
            {linkMutation.isPending ? 'Sending Request...' : 'Send Link Request'}
          </button>
        </div>
      </Modal>

      {/* UPDATE */}
      <Modal open={!!editTarget} onClose={() => setEditTarget(null)} title={`Edit ${editTarget?.agency_org?.name || 'Agency'}`} size="md">
        <div className="space-y-4">
          {editDenied ? (
            <p className="text-sm text-red-600">You can only edit an agency you added yourself — this one isn't editable from here.</p>
          ) : (
            <>
              <Input label="Agency Name" value={editForm.name} onChange={(v) => setEditForm({ ...editForm, name: v })} required />
              <div className="grid grid-cols-2 gap-4">
                <Input label="Phone" value={editForm.phone} onChange={(v) => setEditForm({ ...editForm, phone: v })} />
                <Input label="Email" type="email" value={editForm.email} onChange={(v) => setEditForm({ ...editForm, email: v })} />
              </div>
              <Input label="Address" value={editForm.address} onChange={(v) => setEditForm({ ...editForm, address: v })} />
              <Input label="GST Number" value={editForm.gst_number} onChange={(v) => setEditForm({ ...editForm, gst_number: v })} />

              {editMutation.isError && !editDenied && <p className="text-sm text-red-600">{(editMutation.error as Error).message}</p>}

              <button
                onClick={() => editMutation.mutate()}
                disabled={editMutation.isPending || !editForm.name}
                className="w-full flex items-center justify-center gap-2 bg-blue-600 hover:bg-blue-700 text-white font-medium py-2.5 rounded-lg transition disabled:opacity-50"
              >
                {editMutation.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
                {editMutation.isPending ? 'Saving...' : 'Save Changes'}
              </button>
            </>
          )}
        </div>
      </Modal>

      {/* DELETE (soft — removes the link only) */}
      <ConfirmDialog
        open={!!removeTarget}
        onClose={() => setRemoveTarget(null)}
        onConfirm={() => removeTarget && removeMutation.mutate(removeTarget)}
        title="Remove this agency?"
        message={`This removes ${removeTarget?.agency_org?.name || 'this agency'} from your list — you won't be able to create new campaigns with them until you add/link them again. Their own account and any work already done stays exactly as it is.`}
        confirmLabel={removeMutation.isPending ? 'Removing...' : 'Remove'}
        danger
      />
    </div>
  );
}

// Half-star-aware rating display — filled/half/empty per star, plus the
// text label the star count was derived from, since "4 stars" alone
// doesn't say what that means without the words next to it.
function StarRating({ stars, label }: { stars: number; label: string }) {
  return (
    <div className="flex items-center gap-1.5">
      <div className="flex items-center gap-0.5">
        {[1, 2, 3, 4, 5].map((i) => {
          const fill = Math.max(0, Math.min(1, stars - (i - 1)));
          return (
            <span key={i} className="relative w-3.5 h-3.5 inline-block">
              <Star className="w-3.5 h-3.5 text-slate-200 absolute inset-0" fill="currentColor" />
              <span className="absolute inset-0 overflow-hidden" style={{ width: `${fill * 100}%` }}>
                <Star className="w-3.5 h-3.5 text-amber-400" fill="currentColor" />
              </span>
            </span>
          );
        })}
      </div>
      <span className="text-[11px] font-medium text-slate-500">{label}</span>
    </div>
  );
}
