import { useEffect, useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { Card, Drawer, Select, Textarea, EmptyState, Modal, Input } from '@/components/ui';
import { ROLE_LABELS } from '@/lib/types';
import {
  Building2, Users, Store, CheckCircle2, ShoppingCart, LogOut, Search,
  Link2, Shield, Loader2, Plus, KeyRound, Mail,
} from 'lucide-react';

// A subscription-status pill, deliberately separate from the app-wide
// StatusBadge (which is tuned for shop/PO/invoice statuses) — trial /
// active / inactive / suspended needed their own color logic.
const SUB_STATUS_STYLES: Record<string, string> = {
  trial: 'bg-blue-50 text-blue-700 border-blue-200',
  active: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  inactive: 'bg-slate-100 text-slate-500 border-slate-200',
  suspended: 'bg-red-50 text-red-700 border-red-200',
};

interface OrgRow {
  id: string;
  name: string;
  org_type: 'agency' | 'client';
  subscription_status: 'trial' | 'active' | 'inactive' | 'suspended';
  subscription_plan: string | null;
  subscription_notes: string | null;
  created_at: string;
}

export default function SuperAdminPage() {
  const { profile, signOut } = useAuth();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState<'' | 'agency' | 'client'>('');
  const [statusFilter, setStatusFilter] = useState('');
  const [selectedOrgId, setSelectedOrgId] = useState<string | null>(null);
  const [addOrgOpen, setAddOrgOpen] = useState(false);
  const [addOrgForm, setAddOrgForm] = useState({ org_name: '', org_type: 'agency' as 'agency' | 'client', admin_full_name: '', admin_email: '', admin_phone: '', admin_password: '' });

  // Every query below is scoped only by the super-admin-only RLS policies
  // added in migration 0072 — none of this touches rate_cards, invoices,
  // or invoice_items, by design. This is "how many / who's linked to
  // whom", never money.
  const { data: orgs, isLoading: orgsLoading } = useQuery({
    queryKey: ['superadmin-orgs'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('organizations')
        .select('id, name, org_type, subscription_status, subscription_plan, subscription_notes, created_at')
        .order('created_at', { ascending: false });
      if (error) throw error;
      return data as OrgRow[];
    },
  });

  const { data: allUsers } = useQuery({
    queryKey: ['superadmin-users'],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('super_admin_list_users');
      if (error) throw error;
      return data as { id: string; organization_id: string | null; full_name: string; role: string; is_active: boolean; email: string }[];
    },
  });

  const { data: allShops } = useQuery({
    queryKey: ['superadmin-shops'],
    queryFn: async () => {
      const { data, error } = await supabase.from('shops').select('id, organization_id, status');
      if (error) throw error;
      return data as { id: string; organization_id: string; status: string }[];
    },
  });

  const { data: allClients } = useQuery({
    queryKey: ['superadmin-clients'],
    queryFn: async () => {
      const { data, error } = await supabase.from('clients').select('id, organization_id');
      if (error) throw error;
      return data as { id: string; organization_id: string }[];
    },
  });

  const { data: allLinks } = useQuery({
    queryKey: ['superadmin-links'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('client_agency_links')
        .select('id, client_org_id, agency_org_id, status');
      if (error) throw error;
      return data as { id: string; client_org_id: string; agency_org_id: string; status: string }[];
    },
  });

  // ---- Platform-wide numbers, the headline of this whole screen ----
  const platformStats = useMemo(() => {
    const agencies = (orgs || []).filter((o) => o.org_type === 'agency');
    const clients = (orgs || []).filter((o) => o.org_type === 'client');
    const completedShops = (allShops || []).filter((s) => s.status === 'installed' || s.status === 'billed').length;
    return {
      agencyCount: agencies.length,
      clientCount: clients.length,
      userCount: (allUsers || []).filter((u) => u.role !== 'super_admin').length,
      shopCount: (allShops || []).length,
      completedShops,
      activeSubs: (orgs || []).filter((o) => o.subscription_status === 'active').length,
    };
  }, [orgs, allUsers, allShops]);

  const usersByOrg = useMemo(() => {
    const map = new Map<string, typeof allUsers>();
    for (const u of allUsers || []) {
      if (!u.organization_id) continue;
      const list = map.get(u.organization_id) || [];
      list.push(u);
      map.set(u.organization_id, list as any);
    }
    return map;
  }, [allUsers]);

  const shopsByOrg = useMemo(() => {
    const map = new Map<string, { total: number; completed: number }>();
    for (const s of allShops || []) {
      const entry = map.get(s.organization_id) || { total: 0, completed: 0 };
      entry.total += 1;
      if (s.status === 'installed' || s.status === 'billed') entry.completed += 1;
      map.set(s.organization_id, entry);
    }
    return map;
  }, [allShops]);

  const clientsByOrg = useMemo(() => {
    const map = new Map<string, number>();
    for (const c of allClients || []) map.set(c.organization_id, (map.get(c.organization_id) || 0) + 1);
    return map;
  }, [allClients]);

  // Active-link counts, per org, in whichever direction that org sits —
  // this is what answers "is this client using more than one agency" /
  // "how many clients does this agency actually work with".
  const activeLinkCountByOrg = useMemo(() => {
    const map = new Map<string, number>();
    for (const l of allLinks || []) {
      if (l.status !== 'active') continue;
      map.set(l.client_org_id, (map.get(l.client_org_id) || 0) + 1);
      map.set(l.agency_org_id, (map.get(l.agency_org_id) || 0) + 1);
    }
    return map;
  }, [allLinks]);

  const filteredOrgs = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (orgs || []).filter((o) => {
      if (q && !o.name.toLowerCase().includes(q)) return false;
      if (typeFilter && o.org_type !== typeFilter) return false;
      if (statusFilter && o.subscription_status !== statusFilter) return false;
      return true;
    });
  }, [orgs, search, typeFilter, statusFilter]);

  const createOrgMutation = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.rpc('super_admin_create_organization', {
        p_org_name: addOrgForm.org_name,
        p_org_type: addOrgForm.org_type,
        p_admin_full_name: addOrgForm.admin_full_name,
        p_admin_email: addOrgForm.admin_email,
        p_admin_phone: addOrgForm.admin_phone,
        p_admin_password: addOrgForm.admin_password,
      });
      if (error) throw new Error(error.message.replace(/^.*?:\s*/, ''));
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['superadmin-orgs'] });
      queryClient.invalidateQueries({ queryKey: ['superadmin-users'] });
      setAddOrgOpen(false);
      setAddOrgForm({ org_name: '', org_type: 'agency', admin_full_name: '', admin_email: '', admin_phone: '', admin_password: '' });
    },
  });

  const selectedOrg = (orgs || []).find((o) => o.id === selectedOrgId) || null;

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="bg-slate-900 text-white sticky top-0 z-30">
        <div className="max-w-[1400px] mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-blue-600 flex items-center justify-center shrink-0">
              <Shield className="w-4.5 h-4.5" />
            </div>
            <div>
              <p className="font-semibold leading-tight">Platform Super Admin</p>
              <p className="text-xs text-slate-400 leading-tight">{profile?.full_name}</p>
            </div>
          </div>
          <button onClick={() => signOut()} className="flex items-center gap-1.5 text-sm text-slate-300 hover:text-white transition">
            <LogOut className="w-4 h-4" /> Sign Out
          </button>
        </div>
      </header>

      <main className="max-w-[1400px] mx-auto px-6 py-6">
        {/* Platform-wide headline numbers */}
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4 mb-6">
          <StatCard icon={Building2} label="Agencies" value={platformStats.agencyCount} color="blue" />
          <StatCard icon={Users} label="Clients" value={platformStats.clientCount} color="violet" />
          <StatCard icon={CheckCircle2} label="Active Subscriptions" value={platformStats.activeSubs} color="emerald" />
          <StatCard icon={Users} label="Platform Users" value={platformStats.userCount} color="slate" />
          <StatCard icon={Store} label="Total Shops" value={platformStats.shopCount} color="amber" />
          <StatCard icon={CheckCircle2} label="Completed Shops" value={platformStats.completedShops} color="teal" />
        </div>

        {/* Filters */}
        <Card className="p-4 mb-4">
          <div className="flex flex-wrap items-center gap-3">
            <div className="relative flex-1 min-w-[200px]">
              <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search organizations..."
                className="w-full pl-9 pr-3 py-2 border border-slate-200 rounded-lg text-sm outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value as any)} className="px-3 py-2 border border-slate-200 rounded-lg text-sm bg-white outline-none">
              <option value="">All Types</option>
              <option value="agency">Agencies</option>
              <option value="client">Clients</option>
            </select>
            <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="px-3 py-2 border border-slate-200 rounded-lg text-sm bg-white outline-none">
              <option value="">All Subscription Statuses</option>
              <option value="trial">Trial</option>
              <option value="active">Active</option>
              <option value="inactive">Inactive</option>
              <option value="suspended">Suspended</option>
            </select>
          </div>
        </Card>

        {/* Organizations table */}
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-slate-700">All Organizations</h2>
          <button
            onClick={() => setAddOrgOpen(true)}
            className="flex items-center gap-1.5 bg-blue-600 hover:bg-blue-700 text-white px-3.5 py-2 rounded-lg text-sm font-medium transition"
          >
            <Plus className="w-4 h-4" /> Add Organization
          </button>
        </div>
        <Card className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-slate-500 text-xs uppercase">
                <tr>
                  <th className="text-left px-4 py-3">Organization</th>
                  <th className="text-left px-4 py-3">Type</th>
                  <th className="text-left px-4 py-3">Linked Orgs</th>
                  <th className="text-left px-4 py-3">Users</th>
                  <th className="text-left px-4 py-3">Shops (done)</th>
                  <th className="text-left px-4 py-3">Subscription</th>
                  <th className="px-4 py-3"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filteredOrgs.map((org) => {
                  const users = usersByOrg.get(org.id) || [];
                  const shopStats = shopsByOrg.get(org.id);
                  const linkCount = activeLinkCountByOrg.get(org.id) || 0;
                  const clientCount = clientsByOrg.get(org.id) || 0;
                  return (
                    <tr key={org.id} className="hover:bg-slate-50 cursor-pointer" onClick={() => setSelectedOrgId(org.id)}>
                      <td className="px-4 py-3 font-medium text-slate-900">{org.name}</td>
                      <td className="px-4 py-3">
                        <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${org.org_type === 'agency' ? 'bg-blue-50 text-blue-700' : 'bg-violet-50 text-violet-700'}`}>
                          {org.org_type === 'agency' ? 'Agency' : 'Client'}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-slate-600">
                        {linkCount > 0 ? (
                          <span className="flex items-center gap-1"><Link2 className="w-3.5 h-3.5 text-slate-400" /> {linkCount} linked</span>
                        ) : (
                          <span className="text-slate-400">
                            {org.org_type === 'agency' && clientCount > 0 ? `${clientCount} internal client${clientCount === 1 ? '' : 's'} only` : 'Not linked'}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-slate-600">{users.length}</td>
                      <td className="px-4 py-3 text-slate-600">
                        {org.org_type === 'agency' ? (shopStats ? `${shopStats.total} (${shopStats.completed})` : '0') : '—'}
                      </td>
                      <td className="px-4 py-3">
                        <span className={`text-xs font-medium px-2 py-0.5 rounded-full border capitalize ${SUB_STATUS_STYLES[org.subscription_status]}`}>
                          {org.subscription_status}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right">
                        <button className="text-xs font-medium text-blue-600 hover:underline">Manage →</button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {orgsLoading && <div className="p-8 text-center text-sm text-slate-400 flex items-center justify-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Loading...</div>}
          {!orgsLoading && filteredOrgs.length === 0 && (
            <EmptyState icon={<Building2 className="w-10 h-10" />} title="No organizations match" subtitle="Try a different search or filter." />
          )}
        </Card>
      </main>

      <OrgDetailDrawer
        org={selectedOrg}
        onClose={() => setSelectedOrgId(null)}
        users={selectedOrg ? (usersByOrg.get(selectedOrg.id) || []) : []}
        shopStats={selectedOrg ? shopsByOrg.get(selectedOrg.id) : undefined}
        clientCount={selectedOrg ? (clientsByOrg.get(selectedOrg.id) || 0) : 0}
        links={(allLinks || []).filter((l) => selectedOrg && (l.client_org_id === selectedOrg.id || l.agency_org_id === selectedOrg.id))}
        allOrgs={orgs || []}
        onSaved={() => queryClient.invalidateQueries({ queryKey: ['superadmin-orgs'] })}
      />

      <Modal open={addOrgOpen} onClose={() => setAddOrgOpen(false)} title="Add Organization" size="md">
        <div className="space-y-4">
          <div className="flex items-center gap-1 bg-slate-100 rounded-lg p-1 w-fit">
            <button
              type="button"
              onClick={() => setAddOrgForm({ ...addOrgForm, org_type: 'agency' })}
              className={`px-3 py-1.5 rounded-md text-xs font-medium transition ${addOrgForm.org_type === 'agency' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500'}`}
            >
              Agency
            </button>
            <button
              type="button"
              onClick={() => setAddOrgForm({ ...addOrgForm, org_type: 'client' })}
              className={`px-3 py-1.5 rounded-md text-xs font-medium transition ${addOrgForm.org_type === 'client' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500'}`}
            >
              Client
            </button>
          </div>

          <Input label="Organization Name" value={addOrgForm.org_name} onChange={(v) => setAddOrgForm({ ...addOrgForm, org_name: v })} placeholder="e.g. Darshan Ad Agency" required />

          <div className="border-t border-slate-100 pt-4">
            <p className="text-sm font-medium text-slate-700 mb-3">First login ({addOrgForm.org_type === 'agency' ? 'Agency Owner' : 'Client Admin'})</p>
            <div className="space-y-3">
              <Input label="Full Name" value={addOrgForm.admin_full_name} onChange={(v) => setAddOrgForm({ ...addOrgForm, admin_full_name: v })} required />
              <div className="grid grid-cols-2 gap-3">
                <Input label="Email" type="email" value={addOrgForm.admin_email} onChange={(v) => setAddOrgForm({ ...addOrgForm, admin_email: v })} required />
                <Input label="Phone" value={addOrgForm.admin_phone} onChange={(v) => setAddOrgForm({ ...addOrgForm, admin_phone: v })} placeholder="+91 90000 00000" />
              </div>
              <Input label="Initial Password" type="password" value={addOrgForm.admin_password} onChange={(v) => setAddOrgForm({ ...addOrgForm, admin_password: v })} required />
            </div>
          </div>

          {createOrgMutation.isError && <p className="text-sm text-red-600">{(createOrgMutation.error as Error).message}</p>}

          <button
            onClick={() => createOrgMutation.mutate()}
            disabled={createOrgMutation.isPending || !addOrgForm.org_name || !addOrgForm.admin_full_name || !addOrgForm.admin_email || !addOrgForm.admin_password}
            className="w-full flex items-center justify-center gap-2 bg-blue-600 hover:bg-blue-700 text-white font-medium py-2.5 rounded-lg transition disabled:opacity-50"
          >
            {createOrgMutation.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
            {createOrgMutation.isPending ? 'Creating...' : 'Create Organization'}
          </button>
        </div>
      </Modal>
    </div>
  );
}

function StatCard({ icon: Icon, label, value, color }: { icon: any; label: string; value: number; color: string }) {
  const colorMap: Record<string, string> = {
    blue: 'bg-blue-50 text-blue-600', violet: 'bg-violet-50 text-violet-600', emerald: 'bg-emerald-50 text-emerald-600',
    slate: 'bg-slate-100 text-slate-600', amber: 'bg-amber-50 text-amber-600', teal: 'bg-teal-50 text-teal-600',
  };
  return (
    <Card className="p-4">
      <div className={`w-9 h-9 rounded-lg flex items-center justify-center mb-2.5 ${colorMap[color]}`}>
        <Icon className="w-4.5 h-4.5" />
      </div>
      <p className="text-2xl font-bold text-slate-900">{value.toLocaleString('en-IN')}</p>
      <p className="text-xs text-slate-500 mt-0.5">{label}</p>
    </Card>
  );
}

function OrgDetailDrawer({
  org, onClose, users, shopStats, clientCount, links, allOrgs, onSaved,
}: {
  org: OrgRow | null;
  onClose: () => void;
  users: { id: string; full_name: string; role: string; is_active: boolean; email: string }[];
  shopStats?: { total: number; completed: number };
  clientCount: number;
  links: { id: string; client_org_id: string; agency_org_id: string; status: string }[];
  allOrgs: OrgRow[];
  onSaved: () => void;
}) {
  const [status, setStatus] = useState('');
  const [plan, setPlan] = useState('');
  const [notes, setNotes] = useState('');
  const [credentialsTarget, setCredentialsTarget] = useState<{ id: string; full_name: string; email: string } | null>(null);

  // Re-seed the local edit form whenever a different org is opened.
  useEffect(() => {
    if (org) { setStatus(org.subscription_status); setPlan(org.subscription_plan || ''); setNotes(org.subscription_notes || ''); }
  }, [org]);

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!org) return;
      const { error } = await supabase.from('organizations').update({
        subscription_status: status,
        subscription_plan: plan || null,
        subscription_notes: notes || null,
        subscription_updated_at: new Date().toISOString(),
      }).eq('id', org.id);
      if (error) throw error;
    },
    onSuccess: () => onSaved(),
  });

  const orgById = new Map(allOrgs.map((o) => [o.id, o]));

  return (
    <Drawer open={!!org} onClose={onClose} title={org?.name || ''} subtitle={org ? (org.org_type === 'agency' ? 'Agency' : 'Client Organization') : undefined} width="lg">
      {org && (
        <div className="p-5 space-y-6">
          {/* Subscription control — the actual on/off switch */}
          <div className="border border-slate-200 rounded-lg p-4">
            <p className="text-sm font-semibold text-slate-900 mb-3">Subscription</p>
            <div className="space-y-3">
              <Select
                label="Status"
                value={status}
                onChange={setStatus}
                options={[
                  { value: 'trial', label: 'Trial' },
                  { value: 'active', label: 'Active' },
                  { value: 'inactive', label: 'Inactive (paused by org)' },
                  { value: 'suspended', label: 'Suspended (platform shutoff)' },
                ]}
              />
              <input
                value={plan}
                onChange={(e) => setPlan(e.target.value)}
                placeholder="Plan name (e.g. Growth, Enterprise) — optional"
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm outline-none focus:ring-2 focus:ring-blue-500"
              />
              <Textarea label="Internal Notes" value={notes} onChange={setNotes} rows={2} />
              <button
                onClick={() => saveMutation.mutate()}
                disabled={saveMutation.isPending}
                className="w-full bg-blue-600 hover:bg-blue-700 text-white font-medium py-2 rounded-lg text-sm transition disabled:opacity-50"
              >
                {saveMutation.isPending ? 'Saving...' : 'Save Subscription'}
              </button>
              {saveMutation.isError && <p className="text-xs text-red-600">{(saveMutation.error as Error).message}</p>}
            </div>
          </div>

          {/* Relationship — who this org actually works with */}
          <div>
            <p className="text-sm font-semibold text-slate-900 mb-2 flex items-center gap-1.5"><Link2 className="w-4 h-4 text-slate-400" /> Relationships</p>
            {links.length === 0 ? (
              <p className="text-xs text-slate-400">
                {org.org_type === 'agency' && clientCount > 0
                  ? `Not linked to any platform client login — manages ${clientCount} client${clientCount === 1 ? '' : 's'} internally only.`
                  : 'Not linked to any other organization on the platform yet.'}
              </p>
            ) : (
              <div className="space-y-1.5">
                {links.map((l) => {
                  const otherId = l.client_org_id === org.id ? l.agency_org_id : l.client_org_id;
                  const other = orgById.get(otherId);
                  return (
                    <div key={l.id} className="flex items-center justify-between text-xs bg-slate-50 rounded-lg px-3 py-2">
                      <span className="text-slate-700">{other?.name || 'Unknown org'}</span>
                      <span className={`px-1.5 py-0.5 rounded-full font-medium capitalize ${l.status === 'active' ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-200 text-slate-500'}`}>{l.status}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Work done — counts only */}
          {org.org_type === 'agency' && (
            <div>
              <p className="text-sm font-semibold text-slate-900 mb-2 flex items-center gap-1.5"><ShoppingCart className="w-4 h-4 text-slate-400" /> Work Done</p>
              <div className="grid grid-cols-2 gap-3">
                <div className="border border-slate-200 rounded-lg p-3">
                  <p className="text-xs text-slate-400">Total Shops</p>
                  <p className="text-xl font-bold text-slate-900">{shopStats?.total ?? 0}</p>
                </div>
                <div className="border border-slate-200 rounded-lg p-3">
                  <p className="text-xs text-slate-400">Completed</p>
                  <p className="text-xl font-bold text-emerald-600">{shopStats?.completed ?? 0}</p>
                </div>
              </div>
            </div>
          )}

          {/* Users */}
          <div>
            <p className="text-sm font-semibold text-slate-900 mb-2 flex items-center gap-1.5"><Users className="w-4 h-4 text-slate-400" /> Users ({users.length})</p>
            <div className="space-y-1.5 max-h-72 overflow-y-auto">
              {users.map((u) => (
                <div key={u.id} className="flex items-center justify-between text-xs bg-slate-50 rounded-lg px-3 py-2 gap-2">
                  <div className="min-w-0">
                    <p className="text-slate-700 font-medium truncate">{u.full_name}</p>
                    <p className="text-slate-400 truncate flex items-center gap-1"><Mail className="w-3 h-3 shrink-0" /> {u.email}</p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <span className="text-slate-500">{ROLE_LABELS[u.role] || u.role}</span>
                    {!u.is_active && <span className="text-red-500 font-medium">Inactive</span>}
                    <button
                      onClick={() => setCredentialsTarget({ id: u.id, full_name: u.full_name, email: u.email })}
                      title="Reset this user's email/password"
                      className="text-blue-600 hover:text-blue-700 shrink-0"
                    >
                      <KeyRound className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              ))}
              {users.length === 0 && <p className="text-xs text-slate-400">No users yet.</p>}
            </div>
          </div>
        </div>
      )}

      <ResetCredentialsModal target={credentialsTarget} onClose={() => setCredentialsTarget(null)} />
    </Drawer>
  );
}

// Change any user's login email and/or password — the "for now" override
// the Super Admin needs for support cases (a client locked out, an
// agency owner's email changed, etc.). Either field can be left blank to
// leave that credential untouched; the RPC itself enforces the same
// (only-a-super-admin, 8-char-minimum-password) rules server-side, this
// is just the form around it.
function ResetCredentialsModal({ target, onClose }: { target: { id: string; full_name: string; email: string } | null; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  useEffect(() => {
    if (target) { setEmail(target.email); setPassword(''); }
  }, [target]);

  const mutation = useMutation({
    mutationFn: async () => {
      if (!target) return;
      const { error } = await supabase.rpc('super_admin_update_user_credentials', {
        p_user_id: target.id,
        p_new_email: email !== target.email ? email : null,
        p_new_password: password || null,
      });
      if (error) throw new Error(error.message.replace(/^.*?:\s*/, ''));
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['superadmin-users'] });
      onClose();
    },
  });

  return (
    <Modal open={!!target} onClose={onClose} title={`Reset Login — ${target?.full_name || ''}`} size="sm">
      {target && (
        <div className="space-y-4">
          <Input label="Email" type="email" value={email} onChange={setEmail} required />
          <Input label="New Password (leave blank to keep current)" type="password" value={password} onChange={setPassword} placeholder="At least 8 characters" />
          {mutation.isError && <p className="text-sm text-red-600">{(mutation.error as Error).message}</p>}
          <button
            onClick={() => mutation.mutate()}
            disabled={mutation.isPending || !email}
            className="w-full flex items-center justify-center gap-2 bg-blue-600 hover:bg-blue-700 text-white font-medium py-2.5 rounded-lg transition disabled:opacity-50"
          >
            {mutation.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
            {mutation.isPending ? 'Saving...' : 'Save Login Changes'}
          </button>
        </div>
      )}
    </Modal>
  );
}
