import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { Card, EmptyState, ProgressBar } from '@/components/ui';
import { DonutChart } from '@/components/DonutChart';
import type { PurchaseOrder, Campaign, ClientPOLineItemProgress, Notification } from '@/lib/types';
import {
  siteBucket, stagePct, finalStage, clientPoWorkStatus, CLIENT_PO_WORK_STATUS_LABELS, CLIENT_PO_WORK_STATUS_COLORS,
} from '@/lib/clientPortal';
import { useClientRealtimeInvalidate } from '@/lib/useClientRealtimeInvalidate';
import {
  Megaphone, Store, Building2, ArrowRight, ShoppingCart, LucideIcon, Bell, ClipboardList,
  FileBarChart, Camera, PenTool, CheckCircle2, Truck, XCircle, ThumbsUp, Clock,
  ArrowUpRight, Trophy,
} from 'lucide-react';

type PoRow = PurchaseOrder & { agency_org: { name: string } | null };

const SITE_DONUT_COLORS: Record<'pending' | 'in_progress' | 'completed', string> = {
  pending: '#94a3b8',    // slate-400 — mirrors SITE_BUCKET_DOT_COLORS
  in_progress: '#f59e0b', // amber-500
  completed: '#10b981',   // emerald-500
};

const FULFILLMENT_LABELS: Record<string, string> = {
  survey_install: 'Full Branding',
  supply_only: 'Supply Only',
  custom: 'Custom Scope',
};

// Icon + accent per notification title this app actually generates for a
// Client Organization user (migrations 0038/0042 + notifyLinkedOrg calls
// in PurchaseOrdersPage.tsx / ClientPODetailPage.tsx) — a closed, known
// set, so this can be a direct lookup rather than guessing from message text.
const ACTIVITY_META: Record<string, { icon: LucideIcon; color: string }> = {
  'Survey completed': { icon: Camera, color: 'text-blue-600 bg-blue-50' },
  'Design approved': { icon: PenTool, color: 'text-fuchsia-600 bg-fuchsia-50' },
  'Site installed': { icon: CheckCircle2, color: 'text-emerald-600 bg-emerald-50' },
  'Order dispatched': { icon: Truck, color: 'text-teal-600 bg-teal-50' },
  'PO Accepted': { icon: ThumbsUp, color: 'text-emerald-600 bg-emerald-50' },
  'PO Declined': { icon: XCircle, color: 'text-red-600 bg-red-50' },
};
const DEFAULT_ACTIVITY_META = { icon: Bell, color: 'text-slate-500 bg-slate-100' };

// A Client Organization user never sees money anywhere in this portal —
// so billing-related notifications ('Invoice raised' / 'Invoice paid',
// left over from a Client Billing screen this portal no longer has) are
// excluded at the query itself, not just hidden in the UI. Kept as a
// named list (rather than an inverse "only show these titles" allowlist)
// so any new milestone notification this app adds later shows up here
// automatically instead of silently needing a code change.
const MONEY_NOTIFICATION_TITLES = ['Invoice raised', 'Invoice paid'];

// Titles whose stored `link` points at a shop-stage PO id
// (`/client/campaigns/{poId}`) rather than the actual nested route
// (`/client/campaigns/{campaignId}/po/{poId}`) — resolved safely below
// using the PO list already on this page, instead of trusting the raw
// stored link. Titles whose stored link points at `/client/billing`
// (a route this portal deliberately doesn't have — money never appears
// in the Client Organization portal) are shown as information-only, not
// as a dead link.
const SHOP_STAGE_TITLES = new Set(['Survey completed', 'Design approved', 'Site installed', 'Order dispatched']);

function timeAgo(dateStr: string): string {
  const seconds = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 2592000) return `${Math.floor(seconds / 86400)}d ago`;
  return new Date(dateStr).toLocaleDateString('en-IN');
}

// Overview (home): KPI cards, a site-status donut, an agency-performance
// leaderboard, recent Work Orders, and a live activity feed — the
// executive-summary landing page for a Client Organization user. No
// billing/₹ anywhere — a client org user never sees pricing/payment data
// in this portal, only scope and progress. Polls every 20s rather than
// using useRealtimeInvalidate — that hook filters Realtime by
// `organization_id`, which on purchase_orders/shops is the AGENCY's org
// id, not this client org's id, so it can't scope a subscription for a
// client_org viewer.
export default function ClientOverviewPage() {
  const { profile } = useAuth();
  const orgId = profile?.organization_id;

  const { data: pos, isLoading: posLoading } = useQuery({
    queryKey: ['client-overview-pos', orgId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('purchase_orders')
        .select('*, agency_org:organizations!purchase_orders_assigned_agency_id_fkey(name)')
        .eq('client_org_id', orgId)
        .order('created_at', { ascending: false });
      if (error) throw error;
      return data as PoRow[];
    },
    enabled: !!orgId,
    refetchInterval: 20000,
  });

  // Grouped counts, not one row per shop — the whole point is that this
  // scales the same whether there are 20 shops or 20,000 (see migration
  // 0075). siteBucket() below still does the same status→bucket mapping
  // it always did, just applied to grouped rows instead of raw ones.
  const { data: shopStatusCounts } = useQuery({
    queryKey: ['client-overview-shop-status-counts', orgId],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('client_shop_status_counts');
      if (error) throw error;
      return data as { purchase_order_id: string; status: string; shop_count: number }[];
    },
    enabled: !!orgId,
    refetchInterval: 20000,
  });

  const { data: links } = useQuery({
    queryKey: ['client-overview-links', orgId],
    queryFn: async () => {
      const { data, error } = await supabase.from('client_agency_links').select('id, status').eq('client_org_id', orgId).eq('status', 'active');
      if (error) throw error;
      return data;
    },
    enabled: !!orgId,
    refetchInterval: 20000,
  });

  const { data: campaigns } = useQuery({
    queryKey: ['client-overview-campaigns', orgId],
    queryFn: async () => {
      const { data, error } = await supabase.from('campaigns').select('id, status').eq('client_org_id', orgId);
      if (error) throw error;
      return data as Pick<Campaign, 'id' | 'status'>[];
    },
    enabled: !!orgId,
    refetchInterval: 20000,
  });

  const { data: progress } = useQuery({
    queryKey: ['client-overview-progress', orgId],
    queryFn: async () => {
      const { data, error } = await supabase.from('v_client_po_line_item_progress').select('*');
      if (error) throw error;
      return data as ClientPOLineItemProgress[];
    },
    enabled: !!orgId,
    refetchInterval: 20000,
  });

  // Recent Activity feed — reuses the exact same `notifications` rows the
  // header bell already reads (RLS is user_id-scoped, so this is
  // automatically just this client_admin's own updates). Deliberately
  // fetches only as many rows as the feed actually displays (not "all
  // notifications, filtered client-side") — with many agencies and many
  // shops this table only grows, and pulling a wide window just to throw
  // most of it away doesn't scale. Money-related titles are excluded in
  // the query itself, never fetched at all.
  const RECENT_ACTIVITY_LIMIT = 6;
  const { data: recentActivity } = useQuery({
    queryKey: ['client-overview-notifications-feed', profile?.id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('notifications')
        .select('*')
        .eq('user_id', profile!.id)
        .not('title', 'in', `(${MONEY_NOTIFICATION_TITLES.map((t) => `"${t}"`).join(',')})`)
        .order('created_at', { ascending: false })
        .limit(RECENT_ACTIVITY_LIMIT);
      if (error) throw error;
      return data as Notification[];
    },
    enabled: !!profile?.id,
    refetchInterval: 20000,
  });

  // "Updates This Week" KPI — a real count from the database (`head:
  // true` returns only the count, not the rows), not a client-side tally
  // over a capped fetch. This stays accurate at any volume of
  // agencies/shops instead of silently undercounting once a busy week
  // produces more updates than a fixed row-limit would have fetched.
  const weekAgoIso = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const { data: weekUpdatesCount } = useQuery({
    queryKey: ['client-overview-notifications-week-count', profile?.id],
    queryFn: async () => {
      const { count, error } = await supabase
        .from('notifications')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', profile!.id)
        .not('title', 'in', `(${MONEY_NOTIFICATION_TITLES.map((t) => `"${t}"`).join(',')})`)
        .gte('created_at', weekAgoIso);
      if (error) throw error;
      return count ?? 0;
    },
    enabled: !!profile?.id,
    refetchInterval: 20000,
  });

  useClientRealtimeInvalidate(orgId, [
    ['client-overview-pos', orgId],
    ['client-overview-shop-status-counts', orgId],
  ]);

  const activePos = (pos || []).filter((po) => po.status !== 'cancelled' && po.assignment_status !== 'rejected');
  const activeCampaignsCount = (campaigns || []).filter((c) => c.status === 'active').length;

  const siteCounts = { pending: 0, in_progress: 0, completed: 0 };
  for (const row of shopStatusCounts || []) {
    const bucket = siteBucket(row.status);
    if (bucket === 'cancelled') continue;
    siteCounts[bucket] += row.shop_count;
  }
  const totalSites = siteCounts.pending + siteCounts.in_progress + siteCounts.completed;
  const overallCompletionPct = totalSites > 0 ? (siteCounts.completed / totalSites) * 100 : null;

  // Agency-wise split — % of sites completed, per agency this client has
  // assigned work to. finalStage() picks installed vs produced per PO's
  // fulfillment type (supply_only POs dispatch rather than install), but
  // shops don't carry fulfillment_type, so this uses the simpler "site
  // status bucket" completion the KPI cards above already use.
  const poById = new Map((pos || []).map((po) => [po.id, po]));
  const agencyMap = new Map<string, { name: string; total: number; completed: number }>();
  for (const row of shopStatusCounts || []) {
    const po = row.purchase_order_id ? poById.get(row.purchase_order_id) : null;
    if (!po?.assigned_agency_id) continue;
    const bucket = siteBucket(row.status);
    if (bucket === 'cancelled') continue;
    const key = po.assigned_agency_id;
    const entry = agencyMap.get(key) || { name: po.agency_org?.name || 'Agency', total: 0, completed: 0 };
    entry.total += row.shop_count;
    if (bucket === 'completed') entry.completed += row.shop_count;
    agencyMap.set(key, entry);
  }
  const agencySplits = Array.from(agencyMap.entries())
    .map(([id, v]) => ({ id, name: v.name, pct: v.total > 0 ? (v.completed / v.total) * 100 : 0, total: v.total, completed: v.completed }))
    .sort((a, b) => b.pct - a.pct);

  const recentPos = activePos.slice(0, 5);

  const progressByPo = new Map<string, ClientPOLineItemProgress[]>();
  for (const row of progress || []) {
    const arr = progressByPo.get(row.purchase_order_id) || [];
    arr.push(row);
    progressByPo.set(row.purchase_order_id, arr);
  }
  function poCompletion(po: PoRow) {
    const poProgress = progressByPo.get(po.id) || [];
    const pct = stagePct(poProgress, finalStage(po.fulfillment_type));
    return { pct, workStatus: clientPoWorkStatus(po, pct) };
  }

  // Resolve a notification's stored `link` into something safe to
  // navigate to — see SHOP_STAGE_TITLES comment above. Returns null when
  // there's nothing safe to link to, which renders the row as
  // information-only instead of a dead click.
  function safeActivityLink(n: Notification): string | null {
    if (SHOP_STAGE_TITLES.has(n.title) && n.link) {
      const poId = n.link.split('/').pop();
      const po = poId ? poById.get(poId) : null;
      if (po?.campaign_id) return `/client/campaigns/${po.campaign_id}/po/${po.id}`;
      return null;
    }
    if (n.link && n.link.startsWith('/client/') && !n.link.startsWith('/client/billing')) return n.link;
    return null;
  }

  const updatesThisWeek = weekUpdatesCount ?? 0;

  return (
    <div>
      <div className="flex items-center justify-between mb-6 flex-wrap gap-2">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Overview</h1>
          <p className="text-sm text-slate-500 mt-1">Your campaigns across every linked agency, at a glance</p>
        </div>
        <span className="flex items-center gap-1.5 text-xs font-medium text-emerald-700 bg-emerald-50 border border-emerald-100 rounded-full px-3 py-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" /> Live
        </span>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <KpiCard icon={Megaphone} label="Active Campaigns" value={String(activeCampaignsCount)} sub={`${activePos.length} Work Order${activePos.length === 1 ? '' : 's'} total`} accent="border-t-violet-500" color="text-violet-600 bg-violet-50" />
        <KpiCard icon={Store} label="Total Sites" value={String(totalSites)} sub={`${siteCounts.completed} completed · ${siteCounts.in_progress} in progress`} accent="border-t-purple-500" color="text-purple-600 bg-purple-50" />
        <KpiCard icon={Building2} label="Linked Agencies" value={String((links || []).length)} sub={agencySplits.length > 0 ? `Top: ${agencySplits[0].name}` : undefined} accent="border-t-amber-500" color="text-amber-600 bg-amber-50" />
        <KpiCard icon={Bell} label="Updates This Week" value={String(updatesThisWeek)} sub="Across surveys, design, install & dispatch" accent="border-t-blue-500" color="text-blue-600 bg-blue-50" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* ---------- Left column ---------- */}
        <div className="lg:col-span-2 space-y-6">
          {/* Site Status — the hero visual: a donut of every site's stage
              bucket, with overall completion sitting right in the center
              instead of duplicated as its own KPI card. */}
          <Card className="p-5">
            <div className="mb-4">
              <h2 className="font-semibold text-slate-900">Site Status</h2>
              <p className="text-xs text-slate-400 mt-0.5">Where every site stands, across all your Work Orders</p>
            </div>
            {totalSites === 0 ? (
              <EmptyState icon={<Store className="w-10 h-10" />} title="No sites yet" subtitle="Sites will appear here once an agency starts work on your campaigns" />
            ) : (
              <div className="flex flex-col sm:flex-row items-center gap-6">
                <DonutChart
                  segments={[
                    { key: 'completed', label: 'Completed', value: siteCounts.completed, color: SITE_DONUT_COLORS.completed },
                    { key: 'in_progress', label: 'In Progress', value: siteCounts.in_progress, color: SITE_DONUT_COLORS.in_progress },
                    { key: 'pending', label: 'Pending', value: siteCounts.pending, color: SITE_DONUT_COLORS.pending },
                  ]}
                  centerValue={overallCompletionPct != null ? `${Math.round(overallCompletionPct)}%` : '—'}
                  centerLabel="Complete"
                />
                <div className="flex-1 w-full grid grid-cols-1 sm:grid-cols-3 gap-3">
                  {([
                    { key: 'completed', label: 'Completed' },
                    { key: 'in_progress', label: 'In Progress' },
                    { key: 'pending', label: 'Pending' },
                  ] as const).map((s) => (
                    <div key={s.key} className="border border-slate-100 rounded-lg p-3">
                      <span className="flex items-center gap-1.5 text-xs text-slate-500 mb-1.5">
                        <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: SITE_DONUT_COLORS[s.key] }} />
                        {s.label}
                      </span>
                      <p className="text-xl font-bold text-slate-900">{siteCounts[s.key]}</p>
                      <p className="text-[11px] text-slate-400">{totalSites > 0 ? `${Math.round((siteCounts[s.key] / totalSites) * 100)}% of sites` : '—'}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </Card>

          {/* Agency Performance — a leaderboard, not just a progress-bar
              list, since comparing agencies against each other is
              genuinely the question this client cares about when they
              work with more than one. */}
          <Card className="p-5">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h2 className="font-semibold text-slate-900 flex items-center gap-1.5"><Trophy className="w-4 h-4 text-amber-500" /> Agency Performance</h2>
                <p className="text-xs text-slate-400 mt-0.5">Ranked by % of sites completed</p>
              </div>
              <Link to="/client/agencies" className="text-sm text-blue-600 hover:underline flex items-center gap-1 shrink-0">
                All <ArrowRight className="w-3.5 h-3.5" />
              </Link>
            </div>
            {agencySplits.length === 0 ? (
              <EmptyState icon={<Building2 className="w-10 h-10" />} title="No site data yet" />
            ) : (
              <div className="space-y-3">
                {agencySplits.slice(0, 6).map((a, i) => (
                  <div key={a.id} className="flex items-center gap-3">
                    <span
                      className={`shrink-0 w-6 h-6 rounded-full flex items-center justify-center text-[11px] font-bold ${
                        i === 0 ? 'bg-amber-100 text-amber-700' : i === 1 ? 'bg-slate-200 text-slate-600' : i === 2 ? 'bg-orange-100 text-orange-700' : 'bg-slate-100 text-slate-400'
                      }`}
                    >
                      {i + 1}
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between text-sm mb-1">
                        <span className="font-medium text-slate-800 truncate">{a.name}</span>
                        <span className="text-slate-500 shrink-0 ml-2">{Math.round(a.pct)}%</span>
                      </div>
                      <ProgressBar pct={a.pct} />
                    </div>
                    <span className="text-[11px] text-slate-400 shrink-0 w-16 text-right">{a.completed}/{a.total} sites</span>
                  </div>
                ))}
              </div>
            )}
          </Card>

          {/* Recent Work Orders */}
          <Card className="p-5">
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-semibold text-slate-900">Recent Work Orders</h2>
              <Link to="/client/campaigns" className="text-sm text-blue-600 hover:underline flex items-center gap-1">
                View all <ArrowRight className="w-3.5 h-3.5" />
              </Link>
            </div>
            {!posLoading && recentPos.length === 0 && (
              <EmptyState icon={<ShoppingCart className="w-10 h-10" />} title="No campaigns yet" subtitle="Create your first Work Order from the Campaigns page" />
            )}
            <div className="space-y-2.5">
              {recentPos.map((po) => {
                const { pct, workStatus } = poCompletion(po);
                return (
                  <Link
                    key={po.id}
                    to={po.campaign_id ? `/client/campaigns/${po.campaign_id}/po/${po.id}` : '/client/campaigns'}
                    className="flex items-center gap-3 px-3 py-2.5 rounded-lg border border-slate-100 hover:border-blue-200 hover:bg-blue-50/30 transition"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="text-sm font-medium text-slate-900 truncate">{po.name || po.po_number}</p>
                        <span className={`shrink-0 px-1.5 py-0.5 rounded-full text-[10px] font-medium ${CLIENT_PO_WORK_STATUS_COLORS[workStatus]}`}>
                          {CLIENT_PO_WORK_STATUS_LABELS[workStatus]}
                        </span>
                        <span className="shrink-0 px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-slate-100 text-slate-500">
                          {FULFILLMENT_LABELS[po.fulfillment_type as string] || po.fulfillment_type}
                        </span>
                      </div>
                      <p className="text-xs text-slate-500 mt-0.5">{po.agency_org?.name || 'Unassigned'} · {new Date(po.po_date).toLocaleDateString('en-IN')}</p>
                      <div className="mt-1.5 max-w-[220px]"><ProgressBar pct={pct} /></div>
                    </div>
                    <ArrowRight className="w-4 h-4 text-slate-300 shrink-0" />
                  </Link>
                );
              })}
            </div>
          </Card>
        </div>

        {/* ---------- Right column ---------- */}
        <div className="space-y-6">
          {/* Recent Activity — a live timeline of the same milestones the
              notification bell already tracks, surfaced right on the
              home page so "what's happening" doesn't require opening the
              bell dropdown. */}
          <Card className="p-5">
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-semibold text-slate-900 flex items-center gap-1.5"><Clock className="w-4 h-4 text-slate-400" /> Recent Activity</h2>
            </div>
            {(recentActivity || []).length === 0 ? (
              <EmptyState icon={<Bell className="w-9 h-9" />} title="No activity yet" subtitle="Updates on your sites will show up here" />
            ) : (
              <div className="space-y-0.5">
                {(recentActivity || []).map((n, i) => {
                  const meta = ACTIVITY_META[n.title] || DEFAULT_ACTIVITY_META;
                  const Icon = meta.icon;
                  const href = safeActivityLink(n);
                  const isLast = i === (recentActivity || []).length - 1;
                  const content = (
                    <div className={`flex gap-3 py-2.5 ${!isLast ? 'border-b border-slate-50' : ''}`}>
                      <span className={`w-7 h-7 rounded-full flex items-center justify-center shrink-0 ${meta.color}`}>
                        <Icon className="w-3.5 h-3.5" />
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium text-slate-800 truncate">{n.title}</p>
                        <p className="text-xs text-slate-400 truncate">{n.message}</p>
                      </div>
                      <span className="text-[11px] text-slate-400 shrink-0 whitespace-nowrap">{timeAgo(n.created_at)}</span>
                    </div>
                  );
                  return href ? (
                    <Link key={n.id} to={href} className="block -mx-1 px-1 rounded-lg hover:bg-slate-50 transition">
                      {content}
                    </Link>
                  ) : (
                    <div key={n.id}>{content}</div>
                  );
                })}
              </div>
            )}
          </Card>

          {/* Quick Access — the four cross-campaign screens, one tap away. */}
          <Card className="p-5">
            <h2 className="font-semibold text-slate-900 mb-4">Quick Access</h2>
            <div className="grid grid-cols-2 gap-3">
              <QuickAccessTile to="/client/campaigns" icon={ClipboardList} label="Campaigns" color="text-violet-600 bg-violet-50" />
              <QuickAccessTile to="/client/shops" icon={Store} label="Shops" color="text-purple-600 bg-purple-50" />
              <QuickAccessTile to="/client/agencies" icon={Building2} label="Agencies" color="text-amber-600 bg-amber-50" />
              <QuickAccessTile to="/client/reports" icon={FileBarChart} label="Reports" color="text-blue-600 bg-blue-50" />
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}

function KpiCard({ icon: Icon, label, value, sub, color, accent }: { icon: LucideIcon; label: string; value: string; sub?: string; color: string; accent?: string }) {
  return (
    <Card className={`p-4 border-t-2 ${accent || 'border-t-transparent'} hover:shadow-md transition-shadow`}>
      <div className="flex items-start gap-3">
        <div className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${color}`}>
          <Icon className="w-5 h-5" />
        </div>
        <div className="min-w-0">
          <p className="text-xs text-slate-500">{label}</p>
          <p className="text-xl font-bold text-slate-900 truncate">{value}</p>
          {sub && <p className="text-[11px] text-slate-400 mt-0.5 truncate">{sub}</p>}
        </div>
      </div>
    </Card>
  );
}

function QuickAccessTile({ to, icon: Icon, label, color }: { to: string; icon: LucideIcon; label: string; color: string }) {
  return (
    <Link
      to={to}
      className="group flex flex-col gap-2 p-3.5 rounded-xl border border-slate-100 hover:border-blue-200 hover:bg-blue-50/30 transition"
    >
      <div className={`w-9 h-9 rounded-lg flex items-center justify-center ${color}`}>
        <Icon className="w-4.5 h-4.5" />
      </div>
      <span className="text-sm font-medium text-slate-700 flex items-center gap-1">
        {label}
        <ArrowUpRight className="w-3.5 h-3.5 text-slate-300 group-hover:text-blue-500 transition-colors" />
      </span>
    </Link>
  );
}
