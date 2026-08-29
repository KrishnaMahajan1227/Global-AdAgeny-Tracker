import { useState, Fragment } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import {
  Modal, ConfirmDialog, Card, Input, Select, Textarea, StatusBadge, EmptyState, PageHeader, Combobox,
} from '@/components/ui';
import { Profile, Organization, WorkType, WorkTypeConsumable, RateCard, AuditLog, ROLE_LABELS, Role, Client, ClientAgencyLink, VehicleLoadStats } from '@/lib/types';
import { logAudit, workloadLevel, initials } from '@/lib/helpers';
import { VehicleLoadLogView } from '@/components/VehicleLoadLogView';
import { INDIA_STATES, INDIA_CITIES_BY_STATE, ALL_INDIA_CITIES } from '@/lib/indiaLocations';
import { Plus, Pencil, Trash2, Users, Building2, Tag, DollarSign, FileText, Shield, Package, Link2, Ban, RotateCcw, Gauge, Search, Truck, AlertTriangle, Clock, ListChecks, TrendingUp, Copy, Check, Loader2 } from 'lucide-react';

type Tab = 'users' | 'org' | 'platform-clients' | 'rate-cards' | 'work-types' | 'consumables' | 'audit' | 'export' | 'workload' | 'vehicle-loads';

export default function OwnerConsolePage() {
  const [tab, setTab] = useState<Tab>('users');

  const tabs: { id: Tab; label: string; icon: any }[] = [
    { id: 'users', label: 'User Management', icon: Users },
    { id: 'workload', label: 'Team Workload', icon: Gauge },
    { id: 'org', label: 'Organization Settings', icon: Building2 },
    { id: 'platform-clients', label: 'Platform Clients', icon: Link2 },
    { id: 'rate-cards', label: 'Rate Cards', icon: DollarSign },
    { id: 'work-types', label: 'Work Types', icon: Tag },
    { id: 'consumables', label: 'Consumables', icon: Package },
    { id: 'vehicle-loads', label: 'Vehicle Loads', icon: Truck },
    { id: 'audit', label: 'Audit Logs', icon: FileText },
    { id: 'export', label: 'Data Export', icon: Shield },
  ];

  return (
    <div>
      <PageHeader title="Owner Console" subtitle="Full administrative control over your agency" />

      <div className="flex flex-wrap gap-2 mb-6 border-b border-slate-200">
        {tabs.map((t) => {
          const Icon = t.icon;
          return (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition ${
                tab === t.id ? 'border-blue-600 text-blue-600' : 'border-transparent text-slate-500 hover:text-slate-700'
              }`}
            >
              <Icon className="w-4 h-4" />
              {t.label}
            </button>
          );
        })}
      </div>

      {tab === 'users' && <UsersTab />}
      {tab === 'workload' && <TeamWorkloadTab />}
      {tab === 'org' && <OrgSettingsTab />}
      {tab === 'platform-clients' && <PlatformClientsTab />}
      {tab === 'rate-cards' && <RateCardsTab />}
      {tab === 'work-types' && <WorkTypesTab />}
      {tab === 'consumables' && <ConsumablesTab />}
      {tab === 'vehicle-loads' && <VehicleLoadsTab />}
      {tab === 'audit' && <AuditLogTab />}
      {tab === 'export' && <ExportTab />}
    </div>
  );
}

function UsersTab() {
  const { profile } = useAuth();
  const orgId = profile?.organization_id;
  const queryClient = useQueryClient();
  const [modalOpen, setModalOpen] = useState(false);
  const [editUser, setEditUser] = useState<Profile | null>(null);
  const [deleteUser, setDeleteUser] = useState<Profile | null>(null);
  const [form, setForm] = useState({ full_name: '', email: '', phone: '', role: 'surveyor' as Role, password: '', client_id: '' });

  const { data: clients } = useQuery({
    queryKey: ['org-clients-for-user-form', orgId],
    queryFn: async () => {
      const { data, error } = await supabase.from('clients').select('id, name').eq('organization_id', orgId).eq('is_active', true).order('name');
      if (error) throw new Error(`Could not load clients: ${error.message}`);
      return data as Pick<Client, 'id' | 'name'>[];
    },
    enabled: !!orgId,
  });

  const { data: users } = useQuery({
    queryKey: ['profiles', orgId],
    queryFn: async () => {
      const { data } = await supabase
        .from('profiles')
        .select('*')
        .eq('organization_id', orgId)
        .order('created_at', { ascending: false });
      return data as Profile[];
    },
    enabled: !!orgId,
  });

  const createUserMutation = useMutation({
    mutationFn: async () => {
      const email = form.email || `${form.phone.replace(/\D/g, '')}@darshanadagency.com`;
      // Calls a SECURITY DEFINER Postgres function instead of supabase.auth.admin.createUser,
      // which requires the service_role key and must never run from the browser.
      // The function itself re-checks server-side that the caller is an agency_owner.
      const { data: newUserId, error: rpcError } = await supabase.rpc('admin_create_user', {
        p_full_name: form.full_name,
        p_email: email,
        p_phone: form.phone,
        p_role: form.role,
        p_password: form.password,
        p_client_id: form.role === 'client_manager' && form.client_id ? form.client_id : null,
      });
      if (rpcError) throw rpcError;
      await logAudit('profiles', newUserId as string, 'insert', 'role', null, form.role, `Created user: ${form.full_name} (${form.role})`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['profiles', orgId] });
      setModalOpen(false);
    },
  });

  const updateUserMutation = useMutation({
    mutationFn: async (user: Profile) => {
      const nextClientId = form.role === 'client_manager' && form.client_id ? form.client_id : null;
      const { error } = await supabase.from('profiles').update({
        full_name: form.full_name,
        phone: form.phone || null,
        role: form.role,
        client_id: nextClientId,
      }).eq('id', user.id);
      if (error) throw error;

      // Keep the audit trail specific about what actually changed, not
      // just a blanket "updated" — cheap to compute here since we still
      // have the pre-edit `user` row to diff against.
      const changes: string[] = [];
      if (user.full_name !== form.full_name) changes.push(`name "${user.full_name}" → "${form.full_name}"`);
      if ((user.phone || '') !== form.phone) changes.push(`phone`);
      if (user.role !== form.role) changes.push(`role ${ROLE_LABELS[user.role] || user.role} → ${ROLE_LABELS[form.role] || form.role}`);
      if ((user.client_id || null) !== nextClientId) changes.push(`client scope`);
      const description = changes.length > 0
        ? `Updated ${form.full_name}: ${changes.join(', ')}`
        : `Updated ${form.full_name} (no field changes)`;

      await logAudit('profiles', user.id, 'update', 'role', user.role, form.role, description);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['profiles', orgId] });
      setModalOpen(false);
    },
  });

  const toggleActiveMutation = useMutation({
    mutationFn: async (user: Profile) => {
      const { error } = await supabase.from('profiles').update({ is_active: !user.is_active }).eq('id', user.id);
      if (error) throw error;
      await logAudit('profiles', user.id, 'update', 'is_active', String(user.is_active), String(!user.is_active), `${user.is_active ? 'Deactivated' : 'Activated'} ${user.full_name}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['profiles', orgId] });
    },
  });

  const deleteUserMutation = useMutation({
    mutationFn: async (user: Profile) => {
      // Calls a SECURITY DEFINER Postgres function instead of
      // supabase.auth.admin.deleteUser (which needs the service_role key
      // and can't run from the browser) — same pattern as admin_create_user.
      const { error: rpcError } = await supabase.rpc('admin_delete_user', { p_user_id: user.id });
      if (rpcError) throw rpcError;
      await logAudit('profiles', user.id, 'delete', null, null, null, `Deleted user: ${user.full_name} (${user.role})`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['profiles', orgId] });
      setDeleteUser(null);
    },
  });

  function openAdd() {
    setEditUser(null);
    setForm({ full_name: '', email: '', phone: '', role: 'surveyor', password: '', client_id: '' });
    setModalOpen(true);
  }

  function openEdit(user: Profile) {
    setEditUser(user);
    setForm({ full_name: user.full_name, email: '', phone: user.phone || '', role: user.role, password: '', client_id: user.client_id || '' });
    setModalOpen(true);
  }

  return (
    <div>
      <div className="flex justify-between items-center mb-4">
        <h2 className="text-lg font-semibold text-slate-900">Team Members ({users?.length || 0})</h2>
        <button onClick={openAdd} className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg font-medium text-sm transition">
          <Plus className="w-4 h-4" /> Add User
        </button>
      </div>

      <div className="space-y-3">
        {users?.map((user) => (
          <Card key={user.id} className="p-4 flex items-center justify-between">
            <div className="flex items-center gap-4">
              <div className="w-10 h-10 rounded-full bg-slate-200 flex items-center justify-center text-slate-600 font-semibold">
                {user.full_name.charAt(0).toUpperCase()}
              </div>
              <div>
                <p className="font-medium text-slate-900">{user.full_name} {user.is_demo && <span className="text-xs text-emerald-600 ml-1">(Demo)</span>}</p>
                <p className="text-sm text-slate-500">{ROLE_LABELS[user.role] || user.role} {user.phone && `- ${user.phone}`}</p>
                {user.role === 'client_manager' && (
                  <p className="text-xs text-slate-400">
                    {user.client_id ? `Scoped to: ${clients?.find((c) => c.id === user.client_id)?.name || 'Unknown client'}` : 'Unscoped — sees all clients'}
                  </p>
                )}
              </div>
            </div>
            <div className="flex items-center gap-3">
              {user.is_active ? (
                <span className="text-xs text-green-600 font-medium">Active</span>
              ) : (
                <span className="text-xs text-red-600 font-medium">Inactive</span>
              )}
              {user.role !== 'agency_owner' && (
                <>
                  <button onClick={() => openEdit(user)} className="p-1.5 text-slate-400 hover:text-blue-600">
                    <Pencil className="w-4 h-4" />
                  </button>
                  <button onClick={() => toggleActiveMutation.mutate(user)} className="text-xs text-slate-500 hover:text-slate-700 px-2 py-1 border border-slate-200 rounded">
                    {user.is_active ? 'Deactivate' : 'Activate'}
                  </button>
                  <button onClick={() => setDeleteUser(user)} className="p-1.5 text-slate-400 hover:text-red-600">
                    <Trash2 className="w-4 h-4" />
                  </button>
                </>
              )}
            </div>
          </Card>
        ))}
      </div>

      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title={editUser ? `Edit ${editUser.full_name}` : 'Add New User'}>
        <div className="space-y-4">
          <Input label="Full Name" value={form.full_name} onChange={(v) => setForm({ ...form, full_name: v })} required />
          {!editUser ? (
            <>
              <div className="grid grid-cols-2 gap-4">
                <Input label="Email (office roles)" type="email" value={form.email} onChange={(v) => setForm({ ...form, email: v })} placeholder="user@darshanadagency.com" />
                <Input label="Phone (field roles)" value={form.phone} onChange={(v) => setForm({ ...form, phone: v })} placeholder="+91 90000 00000" />
              </div>
              <Input label="Initial Password" type="password" value={form.password} onChange={(v) => setForm({ ...form, password: v })} required />
            </>
          ) : (
            <>
              <Input label="Phone" value={form.phone} onChange={(v) => setForm({ ...form, phone: v })} placeholder="+91 90000 00000" />
              <p className="text-xs text-slate-400 -mt-2">Login email and password aren't changed here — use "Reset Password" flows from the login screen if needed.</p>
            </>
          )}
          <Select
            label="Role"
            value={form.role}
            onChange={(v) => setForm({ ...form, role: v as Role })}
            options={Object.entries(ROLE_LABELS).map(([v, l]) => ({ value: v, label: l }))}
            required
          />
          {form.role === 'client_manager' && (
            <Select
              label="Client (leave unset to see every client — not recommended)"
              value={form.client_id}
              onChange={(v) => setForm({ ...form, client_id: v })}
              options={[{ value: '', label: 'All clients (unscoped)' }, ...(clients || []).map((c) => ({ value: c.id, label: c.name }))]}
            />
          )}
          <button
            onClick={() => (editUser ? updateUserMutation.mutate(editUser) : createUserMutation.mutate())}
            disabled={createUserMutation.isPending || updateUserMutation.isPending || !form.full_name}
            className="w-full bg-blue-600 hover:bg-blue-700 text-white font-medium py-2.5 rounded-lg transition disabled:opacity-50"
          >
            {(createUserMutation.isPending || updateUserMutation.isPending) ? 'Saving...' : editUser ? 'Save Changes' : 'Create User'}
          </button>
          {(createUserMutation.isError || updateUserMutation.isError) && (
            <p className="text-sm text-red-600">{((createUserMutation.error || updateUserMutation.error) as Error).message}</p>
          )}
        </div>
      </Modal>

      <ConfirmDialog
        open={!!deleteUser}
        onClose={() => setDeleteUser(null)}
        onConfirm={() => deleteUser && deleteUserMutation.mutate(deleteUser)}
        title="Delete User"
        message={`Remove ${deleteUser?.full_name} permanently? This deletes their login and cannot be undone.`}
        confirmLabel={deleteUserMutation.isPending ? 'Deleting...' : 'Delete'}
        danger
      />
      {deleteUserMutation.isError && (
        <p className="text-sm text-red-600 mt-2">{(deleteUserMutation.error as Error).message}</p>
      )}
    </div>
  );
}

// "Who was given how much work, how much is done" — Architecture v2.0
// §9.2. Reads `v_team_workload` (migration 0047), which already
// aggregates shop_assignments (surveyor/installer) + design_tasks
// (designer) into one row per person/role. This tab was the missing
// piece — the view existed but nothing ever rendered it.
export type TeamWorkloadRow = {
  user_id: string;
  organization_id: string;
  full_name: string;
  role: string;
  assigned_open: number;
  in_progress: number;
  completed_this_month: number;
  overdue: number;
  avg_turnaround_days: number | null;
};

type WorkloadSortKey = 'full_name' | 'assigned_open' | 'in_progress' | 'completed_this_month' | 'overdue' | 'avg_turnaround_days';
type WorkloadRoleFilter = 'all' | 'surveyor' | 'designer' | 'installer';

const WORKLOAD_ROLE_TABS: { id: WorkloadRoleFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'surveyor', label: 'Surveyors' },
  { id: 'designer', label: 'Designers' },
  { id: 'installer', label: 'Installers' },
];

function TeamWorkloadTab() {
  const { profile } = useAuth();
  const orgId = profile?.organization_id;
  const [search, setSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState<WorkloadRoleFilter>('all');
  const [sortKey, setSortKey] = useState<WorkloadSortKey>('assigned_open');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [expandedKey, setExpandedKey] = useState<string | null>(null);

  const { data: rows, isLoading } = useQuery({
    queryKey: ['team-workload', orgId],
    queryFn: async () => {
      const { data, error } = await supabase.from('v_team_workload').select('*');
      if (error) throw new Error(`Could not load team workload: ${error.message}`);
      return data as TeamWorkloadRow[];
    },
    enabled: !!orgId,
    refetchInterval: 60000,
  });

  function toggleSort(key: WorkloadSortKey) {
    if (sortKey === key) { setSortDir(sortDir === 'asc' ? 'desc' : 'asc'); return; }
    setSortKey(key);
    setSortDir('desc');
  }

  // Org-wide summary — the "at a glance" numbers an Owner actually opens
  // this tab for, computed once from the same rows the table already has
  // (no extra query). Avg turnaround is a simple mean across people who
  // have at least one data point this month, not weighted by volume —
  // good enough for "roughly how fast is the team turning work around".
  const summary = (() => {
    const all = rows || [];
    const turnaroundVals = all.map((r) => r.avg_turnaround_days).filter((v): v is number => v != null);
    return {
      people: all.length,
      openAssignments: all.reduce((sum, r) => sum + (r.assigned_open || 0), 0),
      overdue: all.reduce((sum, r) => sum + (r.overdue || 0), 0),
      completedThisMonth: all.reduce((sum, r) => sum + (r.completed_this_month || 0), 0),
      avgTurnaround: turnaroundVals.length ? (turnaroundVals.reduce((a, b) => a + b, 0) / turnaroundVals.length) : null,
    };
  })();

  const filteredRows = (rows || [])
    .filter((r) => roleFilter === 'all' || r.role === roleFilter)
    .filter((r) => !search || r.full_name?.toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => {
      const av = a[sortKey] ?? -1;
      const bv = b[sortKey] ?? -1;
      const cmp = typeof av === 'string' ? av.localeCompare(bv as string) : (av as number) - (bv as number);
      return sortDir === 'asc' ? cmp : -cmp;
    });

  const columns: { key: WorkloadSortKey; label: string }[] = [
    { key: 'full_name', label: 'Person' },
    { key: 'assigned_open', label: 'Assigned (open)' },
    { key: 'in_progress', label: 'In Progress' },
    { key: 'completed_this_month', label: 'Completed (this month)' },
    { key: 'overdue', label: 'Overdue' },
    { key: 'avg_turnaround_days', label: 'Avg. turnaround' },
  ];

  return (
    <div>
      <p className="text-sm text-slate-500 mb-4">Who has how much work, and how much is done — pulled live from Survey/Design/Installation assignments. Refreshes automatically every minute.</p>

      {/* Org-wide summary strip — the numbers this tab exists to answer. */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 mb-5">
        <Card className="p-3.5">
          <div className="flex items-center gap-2 text-slate-400 mb-1"><Users className="w-3.5 h-3.5" /><span className="text-xs font-medium">Team on the ground</span></div>
          <p className="text-2xl font-semibold text-slate-900">{summary.people}</p>
        </Card>
        <Card className="p-3.5">
          <div className="flex items-center gap-2 text-slate-400 mb-1"><ListChecks className="w-3.5 h-3.5" /><span className="text-xs font-medium">Open assignments</span></div>
          <p className="text-2xl font-semibold text-slate-900">{summary.openAssignments}</p>
        </Card>
        <Card className="p-3.5">
          <div className="flex items-center gap-2 text-slate-400 mb-1"><TrendingUp className="w-3.5 h-3.5" /><span className="text-xs font-medium">Completed this month</span></div>
          <p className="text-2xl font-semibold text-slate-900">{summary.completedThisMonth}</p>
        </Card>
        <Card className="p-3.5">
          <div className="flex items-center gap-2 text-slate-400 mb-1"><AlertTriangle className="w-3.5 h-3.5" /><span className="text-xs font-medium">Overdue</span></div>
          <p className={`text-2xl font-semibold ${summary.overdue > 0 ? 'text-red-600' : 'text-slate-900'}`}>{summary.overdue}</p>
        </Card>
        <Card className="p-3.5 col-span-2 sm:col-span-1">
          <div className="flex items-center gap-2 text-slate-400 mb-1"><Clock className="w-3.5 h-3.5" /><span className="text-xs font-medium">Avg. turnaround</span></div>
          <p className="text-2xl font-semibold text-slate-900">{summary.avgTurnaround != null ? `${summary.avgTurnaround.toFixed(1)}d` : '—'}</p>
        </Card>
      </div>

      <div className="flex items-center justify-between mb-4 gap-3 flex-wrap">
        <div className="flex gap-1.5 flex-wrap">
          {WORKLOAD_ROLE_TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setRoleFilter(t.id)}
              className={`px-3 py-1.5 rounded-full text-xs font-medium border transition ${
                roleFilter === t.id ? 'bg-blue-600 border-blue-600 text-white' : 'bg-white border-slate-200 text-slate-600 hover:border-slate-300'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div className="relative w-full sm:w-64">
          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by name..."
            className="w-full pl-9 pr-3 py-2 border border-slate-300 rounded-lg text-sm outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
      </div>

      {isLoading && <p className="text-sm text-slate-400">Loading...</p>}

      {!isLoading && filteredRows.length === 0 && (
        <EmptyState icon={<Gauge className="w-10 h-10" />} title="No active assignments" subtitle="Once shops or boards are assigned to surveyors, designers, or installers, their workload shows up here." />
      )}

      {!isLoading && filteredRows.length > 0 && (
        <Card className="overflow-x-auto p-0">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50">
                <th className="text-left px-4 py-3 font-medium text-slate-600 whitespace-nowrap">Load</th>
                {columns.map((c) => (
                  <th
                    key={c.key}
                    onClick={() => toggleSort(c.key)}
                    className="text-left px-4 py-3 font-medium text-slate-600 cursor-pointer select-none hover:text-slate-900 whitespace-nowrap"
                  >
                    {c.label}
                    {sortKey === c.key && <span className="ml-1 text-slate-400">{sortDir === 'asc' ? '↑' : '↓'}</span>}
                  </th>
                ))}
                <th className="text-left px-4 py-3 font-medium text-slate-600">Role</th>
              </tr>
            </thead>
            <tbody>
              {filteredRows.map((r) => {
                const rowKey = `${r.user_id}-${r.role}`;
                const isExpanded = expandedKey === rowKey;
                const level = workloadLevel(r.assigned_open || 0);
                return (
                  <Fragment key={rowKey}>
                    <tr
                      onClick={() => setExpandedKey(isExpanded ? null : rowKey)}
                      className="border-b border-slate-100 hover:bg-slate-50 cursor-pointer"
                    >
                      <td className="px-4 py-3">
                        <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${level.text}`}>
                          <span className={`w-2 h-2 rounded-full ${level.dot}`} /> {level.label}
                        </span>
                      </td>
                      <td className="px-4 py-3 font-medium text-slate-900">
                        <span className="flex items-center gap-2.5">
                          <span className="w-7 h-7 rounded-full bg-indigo-100 text-indigo-700 text-[11px] font-semibold flex items-center justify-center shrink-0">
                            {initials(r.full_name)}
                          </span>
                          {r.full_name}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-slate-700">{r.assigned_open}</td>
                      <td className="px-4 py-3 text-slate-700">{r.in_progress}</td>
                      <td className="px-4 py-3 text-slate-700">{r.completed_this_month}</td>
                      <td className={`px-4 py-3 font-medium ${r.overdue > 0 ? 'text-amber-600' : 'text-slate-400'}`}>{r.overdue}</td>
                      <td className="px-4 py-3 text-slate-700">{r.avg_turnaround_days != null ? `${r.avg_turnaround_days}d` : '—'}</td>
                      <td className="px-4 py-3">
                        <StatusBadge status={ROLE_LABELS[r.role] || r.role} />
                      </td>
                    </tr>
                    {isExpanded && (
                      <tr className="bg-slate-50/70">
                        <td colSpan={columns.length + 2} className="px-4 py-3">
                          <WorkloadDrilldown userId={r.user_id} role={r.role} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}

// Lightweight drill-down when a Team Workload row is clicked — the open
// items behind the numbers, not just the totals. Surveyor/Installer come
// from shop_assignments, Designer from design_tasks; both joined to shops
// for a readable name/city, nothing else fetched.
function WorkloadDrilldown({ userId, role }: { userId: string; role: string }) {
  const { data: items, isLoading } = useQuery({
    queryKey: ['team-workload-drilldown', userId, role],
    queryFn: async () => {
      type DrilldownRow = { id: string; status: string; assigned_at: string; shops: { name: string | null; city: string | null } | null };
      if (role === 'designer') {
        const { data, error } = await supabase
          .from('design_tasks')
          .select('id, status, assigned_at, shops(name, city)')
          .eq('designer_id', userId)
          .not('status', 'in', '(approved,rejected)')
          .order('assigned_at', { ascending: true })
          .limit(20);
        if (error) throw new Error(error.message);
        return ((data || []) as unknown as DrilldownRow[]).map((d) => ({ id: d.id, status: d.status, assigned_at: d.assigned_at, shop_name: d.shops?.name, shop_city: d.shops?.city }));
      }
      const { data, error } = await supabase
        .from('shop_assignments')
        .select('id, status, assigned_at, shops(name, city)')
        .eq('user_id', userId)
        .eq('role', role)
        .neq('status', 'completed')
        .neq('status', 'declined')
        .order('assigned_at', { ascending: true })
        .limit(20);
      if (error) throw new Error(error.message);
      return ((data || []) as unknown as DrilldownRow[]).map((d) => ({ id: d.id, status: d.status, assigned_at: d.assigned_at, shop_name: d.shops?.name, shop_city: d.shops?.city }));
    },
  });

  if (isLoading) return <p className="text-xs text-slate-400">Loading open items...</p>;
  if (!items || items.length === 0) return <p className="text-xs text-slate-400">Nothing currently open for this person.</p>;

  return (
    <div className="space-y-1.5">
      <p className="text-xs font-medium text-slate-500 mb-1">Open items ({items.length}{items.length === 20 ? '+' : ''})</p>
      {items.map((it) => (
        <div key={it.id} className="flex items-center justify-between text-xs bg-white border border-slate-200 rounded-lg px-3 py-1.5">
          <span className="text-slate-700">{it.shop_name || 'Unnamed shop'}{it.shop_city ? ` · ${it.shop_city}` : ''}</span>
          <span className="flex items-center gap-2 text-slate-400">
            <StatusBadge status={it.status} />
            {it.assigned_at && <span>{new Date(it.assigned_at).toLocaleDateString('en-IN')}</span>}
          </span>
        </div>
      ))}
    </div>
  );
}

function OrgSettingsTab() {
  const { profile } = useAuth();
  const orgId = profile?.organization_id;
  const queryClient = useQueryClient();
  const [form, setForm] = useState({
    name: '', address: '', gst_number: '', default_currency: 'INR', default_unit: 'ft', phone: '', email: '',
    bank_account_name: '', bank_name: '', bank_account_number: '', bank_ifsc: '', bank_branch: '', upi_id: '',
  });
  const [saved, setSaved] = useState(false);

  const { data: org } = useQuery({
    queryKey: ['organization', orgId],
    queryFn: async () => {
      const { data } = await supabase.from('organizations').select('*').eq('id', orgId).maybeSingle();
      return data as Organization | null;
    },
    enabled: !!orgId,
  });

  useState(() => {
    if (org) {
      setForm({
        name: org.name, address: org.address || '', gst_number: org.gst_number || '',
        default_currency: org.default_currency, default_unit: org.default_unit,
        phone: org.phone || '', email: org.email || '',
        bank_account_name: org.bank_account_name || '', bank_name: org.bank_name || '',
        bank_account_number: org.bank_account_number || '', bank_ifsc: org.bank_ifsc || '',
        bank_branch: org.bank_branch || '', upi_id: org.upi_id || '',
      });
    }
  });

  const updateMutation = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.from('organizations').update({
        name: form.name, address: form.address, gst_number: form.gst_number,
        default_currency: form.default_currency, default_unit: form.default_unit,
        phone: form.phone, email: form.email,
        bank_account_name: form.bank_account_name || null, bank_name: form.bank_name || null,
        bank_account_number: form.bank_account_number || null, bank_ifsc: form.bank_ifsc || null,
        bank_branch: form.bank_branch || null, upi_id: form.upi_id || null,
      }).eq('id', orgId);
      if (error) throw error;
      await logAudit('organizations', orgId!, 'update', null, null, null, `Updated organization settings`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['organization', orgId] });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    },
  });

  return (
    <Card className="p-6 max-w-2xl">
      <h2 className="text-lg font-semibold text-slate-900 mb-4">Organization Settings</h2>
      {org && (
        <div className="space-y-4">
          <Input label="Agency Name" value={form.name || org.name} onChange={(v) => setForm({ ...form, name: v })} required />
          <Textarea label="Address" value={form.address || org.address || ''} onChange={(v) => setForm({ ...form, address: v })} rows={2} />
          <div className="grid grid-cols-2 gap-4">
            <Input label="GST Number" value={form.gst_number || org.gst_number || ''} onChange={(v) => setForm({ ...form, gst_number: v })} />
            <Input label="Phone" value={form.phone || org.phone || ''} onChange={(v) => setForm({ ...form, phone: v })} />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <Input label="Email" value={form.email || org.email || ''} onChange={(v) => setForm({ ...form, email: v })} />
            <Select label="Default Currency" value={form.default_currency || org.default_currency} onChange={(v) => setForm({ ...form, default_currency: v })} options={[{ value: 'INR', label: 'INR (Rs)' }, { value: 'USD', label: 'USD ($)' }]} />
          </div>
          <Select label="Default Measurement Unit" value={form.default_unit || org.default_unit} onChange={(v) => setForm({ ...form, default_unit: v })} options={[{ value: 'ft', label: 'Feet (ft)' }, { value: 'm', label: 'Meter (m)' }, { value: 'in', label: 'Inch (in)' }, { value: 'cm', label: 'Centimeter (cm)' }]} />

          <div className="border-t border-slate-200 pt-4 mt-2">
            <h3 className="text-sm font-semibold text-slate-900 mb-1">Payment / Bank Details</h3>
            <p className="text-xs text-slate-500 mb-3">Shown on every invoice PDF so clients know how to pay you. Leave blank to omit from the PDF.</p>
            <div className="grid grid-cols-2 gap-4 mb-4">
              <Input label="Account Holder Name" value={form.bank_account_name} onChange={(v) => setForm({ ...form, bank_account_name: v })} />
              <Input label="Bank Name" value={form.bank_name} onChange={(v) => setForm({ ...form, bank_name: v })} />
            </div>
            <div className="grid grid-cols-2 gap-4 mb-4">
              <Input label="Account Number" value={form.bank_account_number} onChange={(v) => setForm({ ...form, bank_account_number: v })} />
              <Input label="IFSC Code" value={form.bank_ifsc} onChange={(v) => setForm({ ...form, bank_ifsc: v })} />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <Input label="Branch" value={form.bank_branch} onChange={(v) => setForm({ ...form, bank_branch: v })} />
              <Input label="UPI ID" value={form.upi_id} onChange={(v) => setForm({ ...form, upi_id: v })} />
            </div>
          </div>

          <button
            onClick={() => updateMutation.mutate()}
            disabled={updateMutation.isPending}
            className="bg-blue-600 hover:bg-blue-700 text-white font-medium py-2.5 px-6 rounded-lg transition disabled:opacity-50"
          >
            {updateMutation.isPending ? 'Saving...' : saved ? 'Saved!' : 'Save Changes'}
          </button>
          {updateMutation.isError && <p className="text-sm text-red-600">{(updateMutation.error as Error).message}</p>}
        </div>
      )}
    </Card>
  );
}

// Phase 2 — "Invite this client to platform". Lets the agency onboard a
// client onto the platform in one step: creates the Client Organization +
// its first client_admin login + a matching agency-side `clients` row +
// an active client_agency_links row, via the agency_invite_client_org RPC
// (migration 0038). Existing agency-led flow (internal `clients` records
// created manually, no platform login) is completely untouched — this is
// purely an additive "upgrade to platform client" path per
// GLOBAL_ARCHITECTURE.md section 3, Flow B step 3.
const emptyInviteForm = {
  client_org_name: '', admin_full_name: '', admin_email: '', admin_phone: '', admin_password: '',
  contact_person: '', contact_phone: '', contact_email: '', city: '', state: '', gst_number: '',
};

type LinkWithOrg = ClientAgencyLink & { client_org: { name: string } | null };

function PlatformClientsTab() {
  const { profile } = useAuth();
  const orgId = profile?.organization_id;
  const queryClient = useQueryClient();
  const [modalOpen, setModalOpen] = useState(false);
  const [form, setForm] = useState(emptyInviteForm);
  const [linkToChange, setLinkToChange] = useState<LinkWithOrg | null>(null);
  const [linkToDecline, setLinkToDecline] = useState<LinkWithOrg | null>(null);
  const [codeCopied, setCodeCopied] = useState(false);

  const { data: org } = useQuery({
    queryKey: ['organization', orgId],
    queryFn: async () => {
      const { data } = await supabase.from('organizations').select('agency_invite_code').eq('id', orgId).maybeSingle();
      return data as { agency_invite_code: string | null } | null;
    },
    enabled: !!orgId,
  });

  const { data: links } = useQuery({
    queryKey: ['client-agency-links', orgId],
    queryFn: async () => {
      // organizations!client_org_id is safe to select now — the orgs_select
      // RLS branch added in migration 0038 lets an agency see the org on
      // the other side of its own links.
      const { data, error } = await supabase
        .from('client_agency_links')
        .select('*, client_org:organizations!client_agency_links_client_org_id_fkey(name)')
        .eq('agency_org_id', orgId)
        .order('created_at', { ascending: false });
      if (error) throw error;
      return data as LinkWithOrg[];
    },
    enabled: !!orgId,
  });

  const pendingCount = (links || []).filter((l) => l.status === 'invited').length;

  const inviteMutation = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.rpc('agency_invite_client_org', {
        p_client_org_name: form.client_org_name,
        p_admin_full_name: form.admin_full_name,
        p_admin_email: form.admin_email,
        p_admin_phone: form.admin_phone,
        p_admin_password: form.admin_password,
        p_contact_person: form.contact_person || null,
        p_contact_phone: form.contact_phone || null,
        p_contact_email: form.contact_email || null,
        p_city: form.city || null,
        p_state: form.state || null,
        p_gst_number: form.gst_number || null,
      });
      if (error) throw error;
      await logAudit('organizations', data as string, 'insert', null, null, null, `Invited client to platform: ${form.client_org_name}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['client-agency-links', orgId] });
      queryClient.invalidateQueries({ queryKey: ['clients', orgId] });
      queryClient.invalidateQueries({ queryKey: ['org-clients-for-user-form', orgId] });
      setModalOpen(false);
      setForm(emptyInviteForm);
    },
  });

  // Accepting a client-initiated link request (status 'invited', created
  // via the client's "Link Existing Agency" invite-code flow) — this is
  // the RPC that actually creates this agency's own internal `clients`
  // row for them and resolves `agency_client_id`, so every PO/billing
  // screen that already assumes a `clients` row exists keeps working the
  // instant the request is accepted. A plain status update here (like
  // Pause/Reactivate below use) would flip the link to 'active' without
  // ever creating that `clients` row — which is exactly the gap this
  // closes.
  const acceptMutation = useMutation({
    mutationFn: async (link: LinkWithOrg) => {
      const { error } = await supabase.rpc('agency_accept_client_link', { p_link_id: link.id });
      if (error) throw new Error(error.message.replace(/^.*?:\s*/, ''));
      await logAudit('client_agency_links', link.id, 'update', 'status', 'invited', 'active', `Accepted link request from ${link.client_org?.name || 'client'} — added them to Clients automatically`);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['client-agency-links', orgId] }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['clients', orgId] });
      queryClient.invalidateQueries({ queryKey: ['org-clients-for-user-form', orgId] });
    },
  });

  const setStatusMutation = useMutation({
    mutationFn: async ({ link, status }: { link: ClientAgencyLink; status: 'paused' | 'active' | 'revoked' }) => {
      const { error } = await supabase.from('client_agency_links').update({ status }).eq('id', link.id);
      if (error) throw error;
      await logAudit('client_agency_links', link.id, 'update', 'status', link.status, status, `${status === 'revoked' ? 'Declined/removed' : status === 'paused' ? 'Paused' : 'Reactivated'} platform link`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['client-agency-links', orgId] });
      setLinkToChange(null);
      setLinkToDecline(null);
    },
  });

  function copyInviteCode() {
    if (!org?.agency_invite_code) return;
    navigator.clipboard.writeText(org.agency_invite_code).then(() => {
      setCodeCopied(true);
      setTimeout(() => setCodeCopied(false), 1500);
    });
  }

  return (
    <div>
      <div className="flex justify-between items-start mb-4 gap-3 flex-wrap">
        <div>
          <h2 className="text-lg font-semibold text-slate-900">Platform Clients ({links?.length || 0})</h2>
          <p className="text-sm text-slate-500 mt-0.5">
            Clients linked to your agency on the platform — they can log in and see progress on POs they've been assigned, without touching your internal cost/vendor data.
          </p>
        </div>
        <button onClick={() => setModalOpen(true)} className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg font-medium text-sm transition whitespace-nowrap">
          <Plus className="w-4 h-4" /> Invite Client to Platform
        </button>
      </div>

      {org?.agency_invite_code && (
        <Card className="p-4 mb-4 bg-blue-50/50 border-blue-100">
          <div className="flex items-center justify-between flex-wrap gap-3">
            <div>
              <p className="text-sm font-medium text-slate-800">Your agency invite code</p>
              <p className="text-xs text-slate-500 mt-0.5">Share this with a client so they can link to you themselves from their "Agencies" page — accepting their request below adds them to your Clients automatically.</p>
            </div>
            <button onClick={copyInviteCode} className="flex items-center gap-2 bg-white border border-blue-200 px-3 py-2 rounded-lg font-mono text-sm font-semibold text-blue-700 hover:bg-blue-50 transition shrink-0">
              {org.agency_invite_code}
              {codeCopied ? <Check className="w-4 h-4 text-emerald-600" /> : <Copy className="w-3.5 h-3.5 text-blue-400" />}
            </button>
          </div>
          <p className="flex items-start gap-1.5 text-xs text-slate-500 mt-3 pt-3 border-t border-blue-100">
            <Shield className="w-3.5 h-3.5 mt-0.5 shrink-0 text-emerald-600" />
            The code itself reveals nothing — nobody can look up or browse your clients, rates, or work in progress from it. It only lets someone submit a link request, which you approve or decline below before anything is shared either way.
          </p>
        </Card>
      )}

      {pendingCount > 0 && (
        <div className="mb-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-amber-600 mb-2">Waiting on your response ({pendingCount})</p>
          <div className="space-y-2">
            {links?.filter((l) => l.status === 'invited').map((link) => (
              <Card key={link.id} className="p-4 flex items-center justify-between flex-wrap gap-3 bg-amber-50/50 border-amber-200">
                <div className="flex items-center gap-3">
                  <div className="w-9 h-9 rounded-full bg-amber-100 flex items-center justify-center shrink-0">
                    <Building2 className="w-4.5 h-4.5 text-amber-700" />
                  </div>
                  <div>
                    <p className="font-medium text-slate-900">{link.client_org?.name || 'Unknown client'}</p>
                    <p className="text-xs text-slate-500">wants to link with you — accepting adds them to Clients automatically</p>
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    onClick={() => setLinkToDecline(link)}
                    disabled={acceptMutation.isPending}
                    className="text-xs text-slate-500 hover:text-red-600 px-3 py-1.5 border border-slate-200 rounded-lg disabled:opacity-50"
                  >
                    Decline
                  </button>
                  <button
                    onClick={() => acceptMutation.mutate(link)}
                    disabled={acceptMutation.isPending && acceptMutation.variables?.id === link.id}
                    className="flex items-center gap-1.5 text-xs bg-emerald-600 hover:bg-emerald-700 text-white px-3 py-1.5 rounded-lg font-medium disabled:opacity-60"
                  >
                    {acceptMutation.isPending && acceptMutation.variables?.id === link.id && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                    Accept
                  </button>
                </div>
              </Card>
            ))}
          </div>
          {acceptMutation.isError && <p className="text-sm text-red-600 mt-2">{(acceptMutation.error as Error).message}</p>}
        </div>
      )}

      <div className="space-y-3">
        {links?.filter((l) => l.status !== 'invited').map((link) => (
          <Card key={link.id} className="p-4 flex items-center justify-between flex-wrap gap-3">
            <div className="flex items-center gap-4">
              <div className="w-10 h-10 rounded-full bg-blue-50 flex items-center justify-center text-blue-600">
                <Building2 className="w-5 h-5" />
              </div>
              <div>
                <p className="font-medium text-slate-900">{link.client_org?.name || 'Unknown client'}</p>
                <p className="text-xs text-slate-400">Linked {new Date(link.created_at).toLocaleDateString('en-IN')}</p>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <StatusBadge status={link.status} />
              {link.status === 'active' && (
                <button onClick={() => setLinkToChange(link)} className="text-xs text-slate-500 hover:text-red-600 px-2 py-1 border border-slate-200 rounded flex items-center gap-1">
                  <Ban className="w-3.5 h-3.5" /> Pause
                </button>
              )}
              {link.status === 'paused' && (
                <button onClick={() => setStatusMutation.mutate({ link, status: 'active' })} className="text-xs text-slate-500 hover:text-green-600 px-2 py-1 border border-slate-200 rounded flex items-center gap-1">
                  <RotateCcw className="w-3.5 h-3.5" /> Reactivate
                </button>
              )}
            </div>
          </Card>
        ))}
        {links?.length === 0 && (
          <Card>
            <EmptyState icon={<Link2 className="w-12 h-12" />} title="No platform clients yet" subtitle="Invite a client to give them their own login and dashboard for POs you do together" />
          </Card>
        )}
      </div>

      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title="Invite Client to Platform" size="lg">
        <div className="space-y-4">
          <Input label="Client Organization Name" value={form.client_org_name} onChange={(v) => setForm({ ...form, client_org_name: v })} placeholder="e.g. Acme Retail" required />

          <div className="border-t border-slate-100 pt-4">
            <p className="text-sm font-medium text-slate-700 mb-3">Their first login (Client Admin)</p>
            <div className="space-y-4">
              <Input label="Full Name" value={form.admin_full_name} onChange={(v) => setForm({ ...form, admin_full_name: v })} required />
              <div className="grid grid-cols-2 gap-4">
                <Input label="Email" type="email" value={form.admin_email} onChange={(v) => setForm({ ...form, admin_email: v })} required />
                <Input label="Phone" value={form.admin_phone} onChange={(v) => setForm({ ...form, admin_phone: v })} placeholder="+91 90000 00000" />
              </div>
              <Input label="Initial Password" type="password" value={form.admin_password} onChange={(v) => setForm({ ...form, admin_password: v })} required />
            </div>
          </div>

          <div className="border-t border-slate-100 pt-4">
            <p className="text-sm font-medium text-slate-700 mb-3">Business details (optional — for your own records)</p>
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <Input label="Contact Person" value={form.contact_person} onChange={(v) => setForm({ ...form, contact_person: v })} />
                <Input label="Contact Phone" value={form.contact_phone} onChange={(v) => setForm({ ...form, contact_phone: v })} />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <Input label="Contact Email" type="email" value={form.contact_email} onChange={(v) => setForm({ ...form, contact_email: v })} />
                <Input label="GST Number" value={form.gst_number} onChange={(v) => setForm({ ...form, gst_number: v })} />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <Combobox label="City" value={form.city} onChange={(v) => setForm({ ...form, city: v })} options={form.state && INDIA_CITIES_BY_STATE[form.state] ? INDIA_CITIES_BY_STATE[form.state] : ALL_INDIA_CITIES} />
                <Combobox label="State" value={form.state} onChange={(v) => setForm({ ...form, state: v })} options={INDIA_STATES} />
              </div>
            </div>
          </div>

          {inviteMutation.isError && <p className="text-sm text-red-600">{(inviteMutation.error as Error).message}</p>}

          <button
            onClick={() => inviteMutation.mutate()}
            disabled={inviteMutation.isPending || !form.client_org_name || !form.admin_full_name || !form.admin_email || !form.admin_password}
            className="w-full flex items-center justify-center gap-2 bg-blue-600 hover:bg-blue-700 text-white font-medium py-2.5 rounded-lg transition disabled:opacity-50"
          >
            {inviteMutation.isPending ? 'Inviting...' : 'Invite Client'}
          </button>
        </div>
      </Modal>

      <ConfirmDialog
        open={!!linkToChange}
        onClose={() => setLinkToChange(null)}
        onConfirm={() => linkToChange && setStatusMutation.mutate({ link: linkToChange, status: 'paused' })}
        title="Pause Platform Access"
        message={`Pause ${linkToChange?.client_org?.name || 'this client'}'s platform access? They'll keep their login but won't be able to see or create POs with you until reactivated.`}
        confirmLabel={setStatusMutation.isPending ? 'Pausing...' : 'Pause Access'}
        danger
      />

      <ConfirmDialog
        open={!!linkToDecline}
        onClose={() => setLinkToDecline(null)}
        onConfirm={() => linkToDecline && setStatusMutation.mutate({ link: linkToDecline, status: 'revoked' })}
        title="Decline Link Request"
        message={`Decline ${linkToDecline?.client_org?.name || 'this client'}'s request to link with you? No Clients record is created and they'll need to send a new request if they want to try again.`}
        confirmLabel={setStatusMutation.isPending ? 'Declining...' : 'Decline'}
        danger
      />
    </div>
  );
}

function WorkTypesTab() {
  const { profile } = useAuth();
  const orgId = profile?.organization_id;
  const queryClient = useQueryClient();
  const [modalOpen, setModalOpen] = useState(false);
  const [editType, setEditType] = useState<WorkType | null>(null);
  const [form, setForm] = useState({ name: '', description: '' });

  const { data: workTypes } = useQuery({
    queryKey: ['work-types', orgId],
    queryFn: async () => {
      const { data } = await supabase.from('work_types').select('*').eq('organization_id', orgId).order('name');
      return data as WorkType[];
    },
    enabled: !!orgId,
  });

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (editType) {
        await supabase.from('work_types').update({ name: form.name, description: form.description }).eq('id', editType.id);
        await logAudit('work_types', editType.id, 'update', null, null, null, `Updated work type: ${form.name}`);
      } else {
        await supabase.from('work_types').insert({ organization_id: orgId, name: form.name, description: form.description });
        await logAudit('work_types', null, 'insert', null, null, null, `Created work type: ${form.name}`);
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['work-types', orgId] });
      setModalOpen(false);
    },
  });

  const toggleMutation = useMutation({
    mutationFn: async (wt: WorkType) => {
      await supabase.from('work_types').update({ is_active: !wt.is_active }).eq('id', wt.id);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['work-types', orgId] });
    },
  });

  return (
    <div>
      <div className="flex justify-between items-center mb-4">
        <h2 className="text-lg font-semibold text-slate-900">Work Types ({workTypes?.length || 0})</h2>
        <button onClick={() => { setEditType(null); setForm({ name: '', description: '' }); setModalOpen(true); }} className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg font-medium text-sm transition">
          <Plus className="w-4 h-4" /> Add Work Type
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
        {workTypes?.map((wt) => (
          <Card key={wt.id} className="p-4">
            <div className="flex items-start justify-between">
              <div>
                <p className="font-medium text-slate-900">{wt.name}</p>
                <p className="text-xs text-slate-500">{wt.description || 'No description'}</p>
              </div>
              <div className="flex gap-1">
                <button onClick={() => { setEditType(wt); setForm({ name: wt.name, description: wt.description || '' }); setModalOpen(true); }} className="p-1 text-slate-400 hover:text-blue-600">
                  <Pencil className="w-3.5 h-3.5" />
                </button>
                <button onClick={() => toggleMutation.mutate(wt)} className="text-xs px-2 py-0.5 border border-slate-200 rounded text-slate-500 hover:text-slate-700">
                  {wt.is_active ? 'Active' : 'Inactive'}
                </button>
              </div>
            </div>
          </Card>
        ))}
      </div>

      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title={editType ? 'Edit Work Type' : 'Add Work Type'}>
        <div className="space-y-4">
          <Input label="Name" value={form.name} onChange={(v) => setForm({ ...form, name: v })} required />
          <Textarea label="Description" value={form.description} onChange={(v) => setForm({ ...form, description: v })} />
          <button onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending} className="w-full bg-blue-600 text-white font-medium py-2.5 rounded-lg disabled:opacity-50">
            {saveMutation.isPending ? 'Saving...' : 'Save'}
          </button>
        </div>
      </Modal>
    </div>
  );
}

function ConsumablesTab() {
  const { profile } = useAuth();
  const orgId = profile?.organization_id;
  const queryClient = useQueryClient();
  const [modalOpen, setModalOpen] = useState(false);
  const [editRow, setEditRow] = useState<WorkTypeConsumable | null>(null);
  const [deleteRow, setDeleteRow] = useState<(WorkTypeConsumable & { work_types?: { name: string } | null }) | null>(null);
  const [form, setForm] = useState({ work_type_id: '', consumable_name: '', qty_per_unit: '' });

  const { data: workTypes } = useQuery({
    queryKey: ['work-types', orgId],
    queryFn: async () => {
      const { data } = await supabase.from('work_types').select('id, name').eq('organization_id', orgId).eq('is_active', true).order('name');
      return data as { id: string; name: string }[];
    },
    enabled: !!orgId,
  });

  const { data: consumables } = useQuery({
    queryKey: ['work-type-consumables', orgId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('work_type_consumables')
        .select('*, work_types(name)')
        .eq('organization_id', orgId)
        .order('created_at', { ascending: false });
      if (error) throw error;
      return data as (WorkTypeConsumable & { work_types: { name: string } | null })[];
    },
    enabled: !!orgId,
  });

  const saveMutation = useMutation({
    mutationFn: async () => {
      const payload = {
        work_type_id: form.work_type_id,
        consumable_name: form.consumable_name,
        qty_per_unit: form.qty_per_unit ? Number(form.qty_per_unit) : null,
      };
      if (editRow) {
        const { error } = await supabase.from('work_type_consumables').update(payload).eq('id', editRow.id);
        if (error) throw error;
      } else {
        const { error } = await supabase.from('work_type_consumables').insert({ organization_id: orgId, ...payload });
        if (error) throw error;
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['work-type-consumables', orgId] });
      setModalOpen(false);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (row: WorkTypeConsumable) => {
      const { error } = await supabase.from('work_type_consumables').delete().eq('id', row.id);
      if (error) throw error;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['work-type-consumables', orgId] }),
  });

  return (
    <div>
      <div className="flex justify-between items-center mb-4">
        <div>
          <h2 className="text-lg font-semibold text-slate-900">Consumables ({consumables?.length || 0})</h2>
          <p className="text-xs text-slate-500 mt-0.5">Packing items (tape, nails...) that ship with a work type on Supply Only orders.</p>
        </div>
        <button
          onClick={() => { setEditRow(null); setForm({ work_type_id: '', consumable_name: '', qty_per_unit: '' }); setModalOpen(true); }}
          className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg font-medium text-sm transition"
        >
          <Plus className="w-4 h-4" /> Add Consumable
        </button>
      </div>

      <Card className="overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-slate-600">
            <tr>
              <th className="text-left px-4 py-3 font-medium">Work Type</th>
              <th className="text-left px-4 py-3 font-medium">Consumable</th>
              <th className="text-right px-4 py-3 font-medium">Qty per unit</th>
              <th className="px-4 py-3"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {consumables?.map((row) => (
              <tr key={row.id} className="hover:bg-slate-50">
                <td className="px-4 py-3 text-slate-900">{row.work_types?.name || '—'}</td>
                <td className="px-4 py-3 text-slate-600">{row.consumable_name}</td>
                <td className="px-4 py-3 text-right text-slate-600">{row.qty_per_unit ?? '—'}</td>
                <td className="px-4 py-3 text-right">
                  <div className="flex items-center justify-end gap-1">
                    <button
                      onClick={() => { setEditRow(row); setForm({ work_type_id: row.work_type_id, consumable_name: row.consumable_name, qty_per_unit: row.qty_per_unit?.toString() || '' }); setModalOpen(true); }}
                      className="p-1 text-slate-400 hover:text-blue-600"
                    >
                      <Pencil className="w-3.5 h-3.5" />
                    </button>
                    <button onClick={() => setDeleteRow(row)} className="p-1 text-slate-400 hover:text-red-600">
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {consumables?.length === 0 && (
              <tr><td colSpan={4} className="text-center py-8 text-slate-400">No consumables defined yet</td></tr>
            )}
          </tbody>
        </table>
      </Card>

      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title={editRow ? 'Edit Consumable' : 'Add Consumable'}>
        <div className="space-y-4">
          <Select
            label="Work Type"
            value={form.work_type_id}
            onChange={(v) => setForm({ ...form, work_type_id: v })}
            options={(workTypes || []).map((w) => ({ value: w.id, label: w.name }))}
            required
          />
          <Input label="Consumable Name" value={form.consumable_name} onChange={(v) => setForm({ ...form, consumable_name: v })} placeholder="e.g. Double side tape 50 inch" required />
          <Input label="Qty per unit" type="number" value={form.qty_per_unit} onChange={(v) => setForm({ ...form, qty_per_unit: v })} placeholder="e.g. 2" />
          {saveMutation.isError && <p className="text-sm text-red-600">{(saveMutation.error as Error).message}</p>}
          <button
            onClick={() => saveMutation.mutate()}
            disabled={saveMutation.isPending || !form.work_type_id || !form.consumable_name}
            className="w-full bg-blue-600 text-white font-medium py-2.5 rounded-lg disabled:opacity-50"
          >
            {saveMutation.isPending ? 'Saving...' : 'Save'}
          </button>
        </div>
      </Modal>

      <ConfirmDialog
        open={!!deleteRow}
        onClose={() => setDeleteRow(null)}
        onConfirm={() => deleteRow && deleteMutation.mutate(deleteRow)}
        title="Delete Consumable"
        message={`Remove "${deleteRow?.consumable_name}" from ${deleteRow?.work_types?.name || 'this work type'}?`}
        confirmLabel="Delete"
        danger
      />
    </div>
  );
}

function RateCardsTab() {
  const { profile } = useAuth();
  const orgId = profile?.organization_id;
  const queryClient = useQueryClient();
  const [modalOpen, setModalOpen] = useState(false);
  const [editCard, setEditCard] = useState<RateCard | null>(null);
  const [form, setForm] = useState({ client_id: '', work_type_id: '', pricing_type: 'per_sqft', rate: '' });

  const { data: rateCards } = useQuery({
    queryKey: ['rate-cards', orgId],
    queryFn: async () => {
      const { data } = await supabase
        .from('rate_cards')
        .select('*, clients(name), work_types(name)')
        .eq('organization_id', orgId)
        .order('created_at', { ascending: false });
      return data;
    },
    enabled: !!orgId,
  });

  const { data: clients } = useQuery({
    queryKey: ['clients', orgId],
    queryFn: async () => {
      const { data } = await supabase.from('clients').select('id, name').eq('organization_id', orgId).eq('is_active', true).order('name');
      return data;
    },
    enabled: !!orgId,
  });

  const { data: workTypes } = useQuery({
    queryKey: ['work-types', orgId],
    queryFn: async () => {
      const { data } = await supabase.from('work_types').select('id, name').eq('organization_id', orgId).eq('is_active', true).order('name');
      return data;
    },
    enabled: !!orgId,
  });

  const saveMutation = useMutation({
    mutationFn: async () => {
      const payload = {
        client_id: form.client_id || null,
        work_type_id: form.work_type_id || null,
        pricing_type: form.pricing_type,
        rate: parseFloat(form.rate),
      };
      if (editCard) {
        await supabase.from('rate_cards').update(payload).eq('id', editCard.id);
      } else {
        await supabase.from('rate_cards').insert({ organization_id: orgId, ...payload });
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['rate-cards', orgId] });
      setModalOpen(false);
    },
  });

  return (
    <div>
      <div className="flex justify-between items-center mb-4">
        <h2 className="text-lg font-semibold text-slate-900">Rate Cards ({rateCards?.length || 0})</h2>
        <button onClick={() => { setEditCard(null); setForm({ client_id: '', work_type_id: '', pricing_type: 'per_sqft', rate: '' }); setModalOpen(true); }} className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg font-medium text-sm transition">
          <Plus className="w-4 h-4" /> Add Rate Card
        </button>
      </div>

      <Card className="overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-slate-600">
            <tr>
              <th className="text-left px-4 py-3 font-medium">Client</th>
              <th className="text-left px-4 py-3 font-medium">Work Type</th>
              <th className="text-left px-4 py-3 font-medium">Pricing Type</th>
              <th className="text-right px-4 py-3 font-medium">Rate</th>
              <th className="px-4 py-3"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rateCards?.map((rc) => (
              <tr key={rc.id} className="hover:bg-slate-50">
                <td className="px-4 py-3 text-slate-900">{rc.clients?.name || 'All'}</td>
                <td className="px-4 py-3 text-slate-600">{rc.work_types?.name || 'All'}</td>
                <td className="px-4 py-3 text-slate-600">{rc.pricing_type.replace(/_/g, ' ')}</td>
                <td className="px-4 py-3 text-right font-medium text-slate-900">Rs {rc.rate}</td>
                <td className="px-4 py-3 text-right">
                  <button onClick={() => { setEditCard(rc); setForm({ client_id: rc.client_id || '', work_type_id: rc.work_type_id || '', pricing_type: rc.pricing_type, rate: rc.rate.toString() }); setModalOpen(true); }} className="p-1 text-slate-400 hover:text-blue-600">
                    <Pencil className="w-3.5 h-3.5" />
                  </button>
                </td>
              </tr>
            ))}
            {rateCards?.length === 0 && (
              <tr><td colSpan={5} className="text-center py-8 text-slate-400">No rate cards defined yet</td></tr>
            )}
          </tbody>
        </table>
      </Card>

      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title={editCard ? 'Edit Rate Card' : 'Add Rate Card'}>
        <div className="space-y-4">
          <Select label="Client" value={form.client_id} onChange={(v) => setForm({ ...form, client_id: v })} options={[{ value: '', label: 'All Clients' }, ...((clients || []).map((c) => ({ value: c.id, label: c.name })))]} />
          <Select label="Work Type" value={form.work_type_id} onChange={(v) => setForm({ ...form, work_type_id: v })} options={(workTypes || []).map((wt) => ({ value: wt.id, label: wt.name }))} required />
          <Select label="Pricing Type" value={form.pricing_type} onChange={(v) => setForm({ ...form, pricing_type: v })} options={[{ value: 'per_sqft', label: 'Per Sq Ft' }, { value: 'per_piece', label: 'Per Piece' }, { value: 'fixed', label: 'Fixed Price' }]} />
          <Input label="Rate (Rs)" type="number" value={form.rate} onChange={(v) => setForm({ ...form, rate: v })} required step="any" />
          <button onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending} className="w-full bg-blue-600 text-white font-medium py-2.5 rounded-lg disabled:opacity-50">
            {saveMutation.isPending ? 'Saving...' : 'Save'}
          </button>
        </div>
      </Modal>
    </div>
  );
}

// Owner/Admin's full-org view of every vehicle load — same underlying
// data and the same reusable log component Production uses on its own
// Vehicle Load screen (VehicleLoadLogView), so the numbers Owner checks
// against reports can never drift from what Production itself sees.
// canManage=true here since agency_owner/admin can mark any load
// delivered (see migration 0062's vehicle_loads_update RLS policy).
function VehicleLoadsTab() {
  const { profile } = useAuth();
  const orgId = profile?.organization_id;

  const { data: stats } = useQuery({
    queryKey: ['vehicle-load-stats', orgId],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('vehicle_load_stats').single();
      if (error) throw new Error(error.message || 'Could not load vehicle load stats.');
      return data as VehicleLoadStats;
    },
    enabled: !!orgId,
  });

  return (
    <div>
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3 mb-5">
        <OwnerStatCard label="Awaiting Load" value={stats?.shops_not_loaded} tone="red" />
        <OwnerStatCard label="Partially Loaded" value={stats?.shops_partial} tone="amber" />
        <OwnerStatCard label="Fully Loaded" value={stats?.shops_loaded} tone="emerald" />
        <OwnerStatCard label="Pending Qty" value={stats?.total_pending_qty} tone="red" />
        <OwnerStatCard label="Trips Today" value={stats?.trips_today} tone="blue" />
      </div>
      <VehicleLoadLogView canManage />
    </div>
  );
}

function OwnerStatCard({ label, value, tone }: { label: string; value: number | undefined; tone: 'red' | 'amber' | 'emerald' | 'blue' }) {
  const toneClass: Record<string, string> = {
    red: 'bg-red-50 text-red-700 border-red-100',
    amber: 'bg-amber-50 text-amber-700 border-amber-100',
    emerald: 'bg-emerald-50 text-emerald-700 border-emerald-100',
    blue: 'bg-blue-50 text-blue-700 border-blue-100',
  };
  return (
    <div className={`rounded-xl border p-3.5 ${toneClass[tone]}`}>
      <p className="text-xs font-medium opacity-80">{label}</p>
      <p className="text-2xl font-bold mt-1">{value ?? '—'}</p>
    </div>
  );
}

function AuditLogTab() {
  const { profile } = useAuth();
  const orgId = profile?.organization_id;
  const [search, setSearch] = useState('');

  const { data: logs } = useQuery({
    queryKey: ['audit-logs', orgId],
    queryFn: async () => {
      const { data } = await supabase
        .from('audit_logs')
        .select('*, profiles(full_name)')
        .eq('organization_id', orgId)
        .order('created_at', { ascending: false })
        .limit(100);
      return data as AuditLog[];
    },
    enabled: !!orgId,
  });

  const filtered = (logs || []).filter((l) => {
    if (!search) return true;
    const s = search.toLowerCase();
    return l.description?.toLowerCase().includes(s) || l.table_name.toLowerCase().includes(s) || l.profiles?.full_name?.toLowerCase().includes(s);
  });

  return (
    <div>
      <input
        placeholder="Search audit logs..."
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        className="w-full mb-4 px-4 py-2 border border-slate-300 rounded-lg text-sm outline-none focus:ring-2 focus:ring-blue-500"
      />
      <Card className="overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-slate-600">
            <tr>
              <th className="text-left px-4 py-3 font-medium">When</th>
              <th className="text-left px-4 py-3 font-medium">User</th>
              <th className="text-left px-4 py-3 font-medium">Action</th>
              <th className="text-left px-4 py-3 font-medium">Table</th>
              <th className="text-left px-4 py-3 font-medium">Description</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {filtered.map((log) => (
              <tr key={log.id} className="hover:bg-slate-50">
                <td className="px-4 py-3 text-xs text-slate-500 whitespace-nowrap">{new Date(log.created_at).toLocaleString('en-IN')}</td>
                <td className="px-4 py-3 text-slate-900">{log.profiles?.full_name || 'System'}</td>
                <td className="px-4 py-3"><StatusBadge status={log.action} /></td>
                <td className="px-4 py-3 text-slate-600">{log.table_name}</td>
                <td className="px-4 py-3 text-slate-600">{log.description || `${log.field_name || ''} ${log.old_value || ''} -> ${log.new_value || ''}`}</td>
              </tr>
            ))}
            {filtered.length === 0 && <tr><td colSpan={5} className="text-center py-8 text-slate-400">No audit logs found</td></tr>}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

function ExportTab() {
  const { profile } = useAuth();
  const orgId = profile?.organization_id;

  async function exportData() {
    const [clients, shops, surveys, invoices] = await Promise.all([
      supabase.from('clients').select('*').eq('organization_id', orgId),
      supabase.from('shops').select('*').eq('organization_id', orgId),
      supabase.from('surveys').select('*').eq('organization_id', orgId),
      supabase.from('invoices').select('*').eq('organization_id', orgId),
    ]);

    const data = {
      exported_at: new Date().toISOString(),
      organization_id: orgId,
      clients: clients.data,
      shops: shops.data,
      surveys: surveys.data,
      invoices: invoices.data,
    };

    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `org-export-${new Date().toISOString().split('T')[0]}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <Card className="p-6">
      <h2 className="text-lg font-semibold text-slate-900 mb-4">Data Export</h2>
      <p className="text-sm text-slate-600 mb-4">Export all your organization's data (clients, shops, surveys, invoices) as a JSON file for backup purposes.</p>
      <button onClick={exportData} className="bg-blue-600 hover:bg-blue-700 text-white font-medium px-6 py-2.5 rounded-lg transition">
        Export Organization Data
      </button>
    </Card>
  );
}
