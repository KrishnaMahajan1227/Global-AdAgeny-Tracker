import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { Card, EmptyState, ProgressBar } from '@/components/ui';
import { DonutChart } from '@/components/DonutChart';
import type { PurchaseOrder, Campaign, ClientPOLineItemProgress } from '@/lib/types';
import {
  siteBucket, stagePct, finalStage, clientPoWorkStatus, CLIENT_PO_WORK_STATUS_LABELS, CLIENT_PO_WORK_STATUS_COLORS,
} from '@/lib/clientPortal';
import { useClientRealtimeInvalidate } from '@/lib/useClientRealtimeInvalidate';
import {
  Megaphone, Store, Building2, ArrowRight, ShoppingCart, LucideIcon, Bell, ClipboardList,
  FileBarChart, Trophy, CalendarCheck, CheckCircle2, Clock, XCircle, Sparkles,
  MapPin, TrendingUp, Camera, ImageOff,
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

function greeting() {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}

// Overview (home) — the executive-summary landing page for a Client
// Organization user. Reads top to bottom the way a decision-maker
// actually scans a status page: the one hero visual (where sites stand),
// reference numbers and shortcuts beside it, then what needs a decision,
// who's executing well, what's moving, and a plain-language close.
// No billing/₹ anywhere — a client org user never sees pricing in this
// portal, only scope and progress. Polls every 20s rather than using
// useRealtimeInvalidate — that hook filters Realtime by
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

  // Region (state/zone) + gallery data — a Regional Head and Marketing
  // Manager both care about *where* sites stand and *what the branding
  // actually looks like on ground*, neither of which the grouped RPC
  // above carries. This does fetch one row per shop (id/name/city/state/
  // zone/status only — no photos, no line items), which is the same
  // shape of query the 0075 migration moved away from for the KPI donut.
  // At a single client's real scale (tens to a few hundred sites, not
  // the 10k+ multi-tenant case that RPC was built for) this is a light
  // enough read; if a client ever grows into that range, this should
  // move to a `client_shop_region_status_counts()` RPC the same way.
  const { data: shopsGeo } = useQuery({
    queryKey: ['client-overview-shops-geo', orgId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('shops')
        .select('id, name, city, state, zone, status, purchase_order_id');
      if (error) throw error;
      return data as { id: string; name: string; city: string | null; state: string | null; zone: string | null; status: string; purchase_order_id: string | null }[];
    },
    enabled: !!orgId,
    refetchInterval: 20000,
  });

  // Latest "installed" proof photos — real field photos, not placeholder
  // icons, so the dashboard actually shows the branding that's gone up
  // rather than just a percentage. Also doubles as the source for the
  // weekly momentum chart below (grouped client-side from the same
  // fetch, no second round trip for the timestamps).
  const { data: recentProofs } = useQuery({
    queryKey: ['client-overview-recent-proofs', orgId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('installation_proofs')
        .select('shop_id, photo_url, photo_type, captured_at')
        .eq('photo_type', 'installed')
        .order('captured_at', { ascending: false })
        .limit(60);
      if (error) throw error;
      return data as { shop_id: string; photo_url: string; photo_type: string; captured_at: string }[];
    },
    enabled: !!orgId,
    refetchInterval: 20000,
  });

  // "Updates This Week" — a real count from the database (`head: true`
  // returns only the count, not the rows). The live feed itself lives in
  // the notification bell (top-right, every page); this page only quotes
  // the headline number so it stays a summary, not a duplicate feed.
  const MONEY_NOTIFICATION_TITLES = ['Invoice raised', 'Invoice paid'];
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
  // assigned work to.
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

  // Regional split — % of sites completed, per state (falls back to zone,
  // then a plain "Unspecified" bucket, so a shop missing that field never
  // just disappears from the leaderboard). Sorted by total sites so a
  // Regional Head sees their biggest markets first, not just whoever's
  // furthest ahead.
  const regionMap = new Map<string, { total: number; completed: number; inProgress: number }>();
  for (const s of shopsGeo || []) {
    const bucket = siteBucket(s.status);
    if (bucket === 'cancelled') continue;
    const region = s.state || s.zone || 'Unspecified';
    const entry = regionMap.get(region) || { total: 0, completed: 0, inProgress: 0 };
    entry.total += 1;
    if (bucket === 'completed') entry.completed += 1;
    if (bucket === 'in_progress') entry.inProgress += 1;
    regionMap.set(region, entry);
  }
  const regionSplits = Array.from(regionMap.entries())
    .map(([name, v]) => ({ name, ...v, pct: v.total > 0 ? (v.completed / v.total) * 100 : 0 }))
    .sort((a, b) => b.total - a.total);

  const shopGeoById = new Map((shopsGeo || []).map((s) => [s.id, s]));
  const galleryPhotos = (recentProofs || []).filter((p) => shopGeoById.has(p.shop_id)).slice(0, 8);

  // Execution momentum — installed-photo count per week, last 6 weeks
  // (Mon–Sun buckets), from the same recentProofs fetch above.
  function weekStart(d: Date) {
    const dt = new Date(d);
    const day = dt.getDay();
    dt.setDate(dt.getDate() + ((day === 0 ? -6 : 1) - day));
    dt.setHours(0, 0, 0, 0);
    return dt;
  }
  const now = new Date();
  const momentumWeeks = Array.from({ length: 6 }, (_, i) => {
    const ws = weekStart(new Date(now.getTime() - (5 - i) * 7 * 24 * 60 * 60 * 1000));
    return { label: ws.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }), start: ws.getTime(), count: 0 };
  });
  for (const p of recentProofs || []) {
    if (!shopGeoById.has(p.shop_id)) continue;
    const ws = weekStart(new Date(p.captured_at)).getTime();
    const bucket = momentumWeeks.find((w) => w.start === ws);
    if (bucket) bucket.count += 1;
  }
  const maxWeekCount = Math.max(...momentumWeeks.map((w) => w.count), 1);
  const totalMomentum = momentumWeeks.reduce((sum, w) => sum + w.count, 0);

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

  // "Needs Attention" — the one thing progressive-disclosure dashboards
  // (Linear, Notion-style) do that a plain stats page doesn't: surface
  // what actually needs a decision, not just what happened. Built only
  // from data already on this page (no extra fetches) — genuinely
  // objective conditions, not a fuzzy "insight" invented from a threshold.
  const pendingAcceptancePos = (pos || []).filter((po) => po.assignment_status === 'pending_acceptance');
  const rejectedPos = (pos || []).filter((po) => po.assignment_status === 'rejected');
  const attentionItems = [
    pendingAcceptancePos.length > 0 && {
      key: 'pending', icon: Clock, color: 'text-amber-600 bg-amber-50',
      label: `${pendingAcceptancePos.length} Work Order${pendingAcceptancePos.length === 1 ? '' : 's'} awaiting agency acceptance`,
      to: '/client/campaigns',
    },
    rejectedPos.length > 0 && {
      key: 'rejected', icon: XCircle, color: 'text-red-600 bg-red-50',
      label: `${rejectedPos.length} Work Order${rejectedPos.length === 1 ? '' : 's'} declined by the agency`,
      to: '/client/campaigns',
    },
  ].filter((x): x is { key: string; icon: LucideIcon; color: string; label: string; to: string } => !!x);

  const updatesThisWeek = weekUpdatesCount ?? 0;
  const today = new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const firstName = profile?.full_name?.split(' ')[0] || '';

  return (
    <div>
      <div className="flex items-center justify-between mb-6 flex-wrap gap-2">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">{greeting()}{firstName ? `, ${firstName}` : ''}</h1>
          <p className="text-sm text-slate-500 mt-1">{today} · Your campaigns across every linked agency, at a glance</p>
        </div>
        <span className="flex items-center gap-1.5 text-xs font-medium text-emerald-700 bg-emerald-50 border border-emerald-100 rounded-full px-3 py-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" /> Live
        </span>
      </div>

      {/* ---------- Top: Site Status (hero, ~68%) + KPIs & Quick Access (~32%, stacked) ---------- */}
      <div className="grid grid-cols-1 lg:grid-cols-10 gap-6 mb-6 items-start">
        <div className="lg:col-span-7">
          <Card className="p-5">
            <div className="mb-5">
              <h2 className="font-semibold text-slate-900">Site Status</h2>
              <p className="text-xs text-slate-400 mt-0.5">Where every site stands, across all your Work Orders</p>
            </div>
            {totalSites === 0 ? (
              <EmptyState icon={<Store className="w-10 h-10" />} title="No sites yet" subtitle="Sites will appear here once an agency starts work on your campaigns" />
            ) : (
              <>
                <div className="flex flex-col sm:flex-row items-center gap-6 mb-5">
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
                      <div key={s.key} className="border-l-2 pl-3 py-0.5" style={{ borderColor: SITE_DONUT_COLORS[s.key] }}>
                        <span className="text-xs text-slate-500">{s.label}</span>
                        <p className="text-2xl font-bold text-slate-900 leading-tight">{siteCounts[s.key]}</p>
                        <p className="text-[11px] text-slate-400">{totalSites > 0 ? `${Math.round((siteCounts[s.key] / totalSites) * 100)}% of sites` : '—'}</p>
                      </div>
                    ))}
                  </div>
                </div>
                {/* A slim composition bar as a second, denser read of the
                    same proportions — fills the width the donut leaves
                    idle beside it and doubles as a familiar "build
                    status" style strip for a quick horizontal scan. */}
                <div className="flex h-2 rounded-full overflow-hidden bg-slate-100">
                  {siteCounts.completed > 0 && <div style={{ width: `${(siteCounts.completed / totalSites) * 100}%`, backgroundColor: SITE_DONUT_COLORS.completed }} />}
                  {siteCounts.in_progress > 0 && <div style={{ width: `${(siteCounts.in_progress / totalSites) * 100}%`, backgroundColor: SITE_DONUT_COLORS.in_progress }} />}
                  {siteCounts.pending > 0 && <div style={{ width: `${(siteCounts.pending / totalSites) * 100}%`, backgroundColor: SITE_DONUT_COLORS.pending }} />}
                </div>
              </>
            )}
          </Card>
        </div>

        <div className="lg:col-span-3 flex flex-col gap-4">
          {/* KPIs — the four reference numbers, each with a colored
              accent bar and its own supporting line, so the block reads
              as a designed panel rather than a plain data list. */}
          <Card className="p-4">
            <h2 className="text-[11px] font-semibold text-slate-400 uppercase tracking-wide mb-3">At a Glance</h2>
            <div className="grid grid-cols-2 gap-3">
              <KpiTile icon={Megaphone} label="Active Campaigns" value={activeCampaignsCount} color="#7c3aed" iconClass="text-violet-600 bg-violet-50" />
              <KpiTile icon={Store} label="Total Sites" value={totalSites} color="#9333ea" iconClass="text-purple-600 bg-purple-50" />
              <KpiTile icon={Building2} label="Linked Agencies" value={(links || []).length} color="#d97706" iconClass="text-amber-600 bg-amber-50" />
              <KpiTile icon={Bell} label="Updates This Week" value={updatesThisWeek} color="#2563eb" iconClass="text-blue-600 bg-blue-50" />
            </div>
          </Card>

          <Card className="p-4">
            <h2 className="text-[11px] font-semibold text-slate-400 uppercase tracking-wide mb-3">Quick Access</h2>
            <div className="grid grid-cols-2 gap-2.5">
              <QuickAccessTile to="/client/campaigns" icon={ClipboardList} label="Campaigns" color="text-violet-600 bg-violet-50" />
              <QuickAccessTile to="/client/shops" icon={Store} label="Shops" color="text-purple-600 bg-purple-50" />
              <QuickAccessTile to="/client/agencies" icon={Building2} label="Agencies" color="text-amber-600 bg-amber-50" />
              <QuickAccessTile to="/client/reports" icon={FileBarChart} label="Reports" color="text-blue-600 bg-blue-50" />
            </div>
          </Card>
        </div>
      </div>

      {/* Needs Attention + Regional Performance — side by side. Both are
          "where should I look first" widgets, so they read as a pair
          rather than one long stack of full-width cards. Stretched to
          equal height so the pair reads as one designed row, not two
          cards of whatever height their own content happened to need. */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6 items-stretch">
        {/* Needs Attention — what actually wants a decision from the
            client, ahead of anything that's just informational. A calm
            all-clear state when there's genuinely nothing pending,
            rather than the section just disappearing. */}
        <Card className="p-5 flex flex-col">
          <h2 className="font-semibold text-slate-900 flex items-center gap-1.5 mb-4"><Sparkles className="w-4 h-4 text-amber-500" /> Needs Your Attention</h2>
          {attentionItems.length === 0 ? (
            <div className="flex-1 flex items-center gap-2.5 text-sm text-slate-500 bg-slate-50/60 border border-slate-100 rounded-lg px-3.5 py-3">
              <CheckCircle2 className="w-4 h-4 text-emerald-500 shrink-0" /> Nothing needs a decision from you right now — every Work Order is in motion.
            </div>
          ) : (
            <div className="space-y-2.5">
              {attentionItems.map((item) => {
                const Icon = item.icon;
                return (
                  <Link key={item.key} to={item.to} className="flex items-center gap-3 border border-slate-100 hover:border-blue-200 hover:bg-blue-50/30 rounded-lg px-3.5 py-2.5 transition">
                    <div className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${item.color}`}>
                      <Icon className="w-4 h-4" />
                    </div>
                    <span className="text-sm text-slate-700 flex-1">{item.label}</span>
                    <ArrowRight className="w-3.5 h-3.5 text-slate-300 shrink-0" />
                  </Link>
                );
              })}
            </div>
          )}
        </Card>

        {/* Regional Performance — a Regional Head's first question is
            almost never "how are we doing overall", it's "how is MY
            region doing vs the others". Grouped by shop.state (falls
            back to zone), sorted by market size so the biggest
            territories lead, not just whoever happens to be furthest
            along. */}
        <Card className="p-5 flex flex-col">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="font-semibold text-slate-900 flex items-center gap-1.5"><MapPin className="w-4 h-4 text-blue-500" /> Regional Performance</h2>
              <p className="text-xs text-slate-400 mt-0.5">By state/zone · sorted by number of sites</p>
            </div>
            <Link to="/client/shops" className="text-sm text-blue-600 hover:underline flex items-center gap-1 shrink-0">
              All <ArrowRight className="w-3.5 h-3.5" />
            </Link>
          </div>
          {regionSplits.length === 0 ? (
            <div className="flex-1 flex items-center justify-center">
              <EmptyState icon={<MapPin className="w-10 h-10" />} title="No site data yet" />
            </div>
          ) : (
            <div className="space-y-3.5">
              {regionSplits.slice(0, 6).map((r) => (
                <div key={r.name} className="flex items-center gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between text-sm mb-1.5">
                      <span className="font-medium text-slate-800 truncate">{r.name}</span>
                      <span className="text-slate-500 shrink-0 ml-2">{Math.round(r.pct)}% complete</span>
                    </div>
                    <ProgressBar pct={r.pct} />
                  </div>
                  <span className="text-[11px] text-slate-400 shrink-0 w-16 text-right">{r.completed}/{r.total} sites</span>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      {/* Agency Performance + Execution Momentum — side by side. The
          leaderboard answers "who's executing well"; the trend answers
          "is the pace of installs picking up or stalling" — both are
          the Trade Marketing Manager's questions more than anyone
          else's in the room. Same equal-height treatment as the row
          above so the chart's bars have real vertical room to read,
          instead of being squeezed against a fixed height. */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6 items-stretch">
        <Card className="p-5 flex flex-col">
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
            <div className="flex-1 flex items-center justify-center">
              <EmptyState icon={<Building2 className="w-10 h-10" />} title="No site data yet" />
            </div>
          ) : (
            <div className="space-y-3.5">
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
                    <div className="flex items-center justify-between text-sm mb-1.5">
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

        {/* Execution Momentum — installed-photo count per week, last 6
            weeks. Built from the same recentProofs fetch as the gallery
            below, so it's one query doing double duty rather than a
            separate time-series call. */}
        <Card className="p-5 flex flex-col">
          <div className="mb-4">
            <h2 className="font-semibold text-slate-900 flex items-center gap-1.5"><TrendingUp className="w-4 h-4 text-emerald-500" /> Execution Momentum</h2>
            <p className="text-xs text-slate-400 mt-0.5">Sites installed per week, last 6 weeks</p>
          </div>
          {totalMomentum === 0 ? (
            <div className="flex-1 flex items-center justify-center">
              <EmptyState icon={<TrendingUp className="w-10 h-10" />} title="No installations recorded yet" />
            </div>
          ) : (
            <div className="flex-1 flex items-end gap-2.5 min-h-[144px]">
              {momentumWeeks.map((w) => (
                <div key={w.start} className="flex-1 flex flex-col items-center justify-end h-full gap-1.5">
                  <span className="text-xs font-semibold text-slate-700">{w.count}</span>
                  <div
                    className="w-full rounded-t-md bg-emerald-500/85"
                    style={{ height: `${Math.max((w.count / maxWeekCount) * 100, w.count > 0 ? 6 : 2)}%` }}
                  />
                  <span className="text-[10px] text-slate-400 whitespace-nowrap">{w.label}</span>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      {/* Recent Visual Proof — actual field photos of installed
          branding, not another stat. This is the single most
          persuasive thing on the page for a Marketing Manager sitting
          in a demo: proof the work is real, current, and looks good. */}
      <Card className="p-5 mb-6">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="font-semibold text-slate-900 flex items-center gap-1.5"><Camera className="w-4 h-4 text-violet-500" /> Recent Visual Proof</h2>
            <p className="text-xs text-slate-400 mt-0.5">Latest installed sites, straight from the field</p>
          </div>
          <Link to="/client/reports" className="text-sm text-blue-600 hover:underline flex items-center gap-1 shrink-0">
            Full report <ArrowRight className="w-3.5 h-3.5" />
          </Link>
        </div>
        {galleryPhotos.length === 0 ? (
          <EmptyState icon={<Camera className="w-10 h-10" />} title="No installation photos yet" subtitle="Photos will appear here as sites go live" />
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-4">
            {galleryPhotos.map((p, i) => (
              <ProofThumb key={`${p.shop_id}-${i}`} url={p.photo_url} shopName={shopGeoById.get(p.shop_id)?.name} shopCity={shopGeoById.get(p.shop_id)?.city} />
            ))}
          </div>
        )}
      </Card>

      {/* Recent Work Orders + Summary — side by side. Work Orders gets
          the wider column since it's a scannable list; Summary is one
          paragraph and reads fine narrower. */}
      <div className="grid grid-cols-1 lg:grid-cols-10 gap-6 items-start">
        <div className="lg:col-span-6">
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
            <div className="divide-y divide-slate-50">
              {recentPos.map((po) => {
                const { pct, workStatus } = poCompletion(po);
                return (
                  <Link
                    key={po.id}
                    to={po.campaign_id ? `/client/campaigns/${po.campaign_id}/po/${po.id}` : '/client/campaigns'}
                    className="flex items-center gap-3 px-2 py-3 hover:bg-slate-50/80 rounded-lg transition -mx-2"
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

        {/* ---------- Summary — a quiet, plain-language close. Every
            figure quoted here is one already computed above; nothing
            new, and visually secondary to everything beside it. ---------- */}
        <div className="lg:col-span-4">
          <Card className="p-4 bg-slate-50/60 border-slate-200 h-full">
            <div className="flex items-center gap-2 mb-2">
              <CalendarCheck className="w-4 h-4 text-slate-400" />
              <h2 className="text-sm font-semibold text-slate-700">Summary</h2>
            </div>
            {totalSites === 0 ? (
              <p className="text-sm text-slate-500">No campaign activity yet — this summary will build itself in as soon as your first sites are underway.</p>
            ) : (
              <p className="text-sm text-slate-500 leading-relaxed">
                You have <span className="font-semibold text-slate-800">{activeCampaignsCount} active campaign{activeCampaignsCount === 1 ? '' : 's'}</span> running
                {' '}<span className="font-semibold text-slate-800">{activePos.length} Work Order{activePos.length === 1 ? '' : 's'}</span> across
                {' '}<span className="font-semibold text-slate-800">{(links || []).length} linked agenc{(links || []).length === 1 ? 'y' : 'ies'}</span>.
                {' '}Of <span className="font-semibold text-slate-800">{totalSites} total sites</span>,
                {' '}<span className="font-semibold text-emerald-700">{siteCounts.completed} are complete</span> ({overallCompletionPct != null ? Math.round(overallCompletionPct) : 0}%),
                {' '}<span className="font-semibold text-amber-700">{siteCounts.in_progress} are in progress</span>, and
                {' '}<span className="font-semibold text-slate-500">{siteCounts.pending} are yet to start</span>.
                {agencySplits.length > 0 && (
                  <> Top-performing agency this period: <span className="font-semibold text-slate-800">{agencySplits[0].name}</span> at{' '}
                  <span className="font-semibold text-slate-800">{Math.round(agencySplits[0].pct)}%</span> completion.</>
                )}
                {' '}<span className="font-semibold text-slate-800">{updatesThisWeek} update{updatesThisWeek === 1 ? '' : 's'}</span> {updatesThisWeek === 1 ? 'was' : 'were'} recorded this week across surveys, design, installation and dispatch.
              </p>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}

function KpiTile({ icon: Icon, label, value, iconClass, color }: { icon: LucideIcon; label: string; value: number; iconClass: string; color: string }) {
  return (
    <div className="border-l-2 pl-2.5 py-0.5" style={{ borderColor: color }}>
      <div className={`w-6 h-6 rounded-md flex items-center justify-center mb-1.5 ${iconClass}`}>
        <Icon className="w-3.5 h-3.5" />
      </div>
      <p className="text-lg font-bold text-slate-900 leading-tight">{value.toLocaleString('en-IN')}</p>
      <p className="text-[10px] text-slate-500 leading-tight">{label}</p>
    </div>
  );
}

function ProofThumb({ url, shopName, shopCity }: { url: string; shopName?: string; shopCity?: string | null }) {
  const [failed, setFailed] = useState(false);
  return (
    <a href={url} target="_blank" rel="noreferrer" className="group block">
      <div className="aspect-square rounded-lg overflow-hidden border border-slate-200 bg-slate-50 flex items-center justify-center">
        {failed ? (
          <ImageOff className="w-5 h-5 text-slate-300" />
        ) : (
          <img
            src={url}
            alt={shopName || 'Installed site'}
            className="w-full h-full object-cover group-hover:scale-105 transition duration-200"
            onError={() => setFailed(true)}
          />
        )}
      </div>
      <p className="text-[11px] font-medium text-slate-700 truncate mt-1.5">{shopName || 'Site'}</p>
      <p className="text-[10px] text-slate-400 truncate mt-0.5">{shopCity || '—'}</p>
    </a>
  );
}

function QuickAccessTile({ to, icon: Icon, label, color }: { to: string; icon: LucideIcon; label: string; color: string }) {
  return (
    <Link
      to={to}
      className="group flex flex-col gap-1.5 p-3 rounded-xl border border-slate-100 hover:border-blue-200 hover:bg-blue-50/30 transition"
    >
      <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${color}`}>
        <Icon className="w-4 h-4" />
      </div>
      <span className="text-xs font-medium text-slate-700">{label}</span>
    </Link>
  );
}
