import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { format, formatDistanceToNowStrict } from 'date-fns';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { Link } from 'react-router-dom';
import { Card, ProgressBar, EmptyState } from '@/components/ui';
import { DonutChart } from '@/components/DonutChart';
import { formatRupees } from '@/lib/poUtilization';
import { useRealtimeInvalidate } from '@/lib/useRealtimeInvalidate';
import {
  Building2, ShoppingCart, Store, Ruler, FileCheck, Palette,
  Printer, Wrench, CheckCircle2, IndianRupee, Activity, ArrowRight,
  ArrowUpRight, Clock, Zap, PartyPopper, ChevronRight,
} from 'lucide-react';

// Buckets a raw shop.status into the one stage of the pipeline it actually
// belongs to right now. Kept in one place so the KPI cards, the pipeline
// rail and the "needs your attention" list can never quietly disagree
// with each other about which bucket a given status falls into.
const STAGE_DEFS = [
  { key: 'survey', label: 'Survey', to: '/shops', icon: Ruler, statuses: ['pending', 'assigned', 'survey_started'] },
  { key: 'review', label: 'Review', to: '/survey-review', icon: FileCheck, statuses: ['surveyed', 'approval_pending'] },
  { key: 'design', label: 'Design', to: '/design', icon: Palette, statuses: ['design_pending', 'designing', 'design_ready', 'in_review'] },
  { key: 'production', label: 'Production', to: '/production', icon: Printer, statuses: ['production_pending', 'in_production', 'production_ready', 'production_hold', 'production_done'] },
  { key: 'install', label: 'Install', to: '/installation-review', icon: Wrench, statuses: ['dispatched', 'installation_pending', 'installing'] },
  { key: 'done', label: 'Billed', to: '/billing', icon: CheckCircle2, statuses: ['installed', 'billed'] },
] as const;

function greeting() {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

export default function DashboardPage() {
  const { profile } = useAuth();
  const orgId = profile?.organization_id;
  const [showAllActivity, setShowAllActivity] = useState(false);

  const { data: stats, isLoading: statsLoading } = useQuery({
    queryKey: ['dashboard-stats', orgId],
    queryFn: async () => {
      if (!orgId) return null;
      const [clients, projects, shops, invoices] = await Promise.all([
        supabase.from('clients').select('id', { count: 'exact', head: true }).eq('organization_id', orgId).eq('is_active', true),
        supabase.from('projects').select('id', { count: 'exact', head: true }).eq('organization_id', orgId),
        supabase.from('shops').select('id, status', { count: 'exact' }).eq('organization_id', orgId),
        supabase.from('invoices').select('total, payment_status').eq('organization_id', orgId),
      ]);

      const shopList = shops.data || [];
      const invoiceList = invoices.data || [];

      const stageCounts: Record<string, number> = {};
      for (const stage of STAGE_DEFS) {
        stageCounts[stage.key] = shopList.filter((s) => (stage.statuses as readonly string[]).includes(s.status)).length;
      }

      const totalShops = shops.count || 0;
      const completed = stageCounts.done || 0;
      const inPipeline = Math.max(0, totalShops - completed);

      const billingTotal = invoiceList.reduce((sum, i) => sum + (i.total || 0), 0);
      const paidAmount = invoiceList.filter((i) => i.payment_status === 'paid').reduce((s, i) => s + (i.total || 0), 0);
      const partialAmount = invoiceList.filter((i) => i.payment_status === 'partial').reduce((s, i) => s + (i.total || 0), 0);
      const outstandingAmount = invoiceList.filter((i) => i.payment_status === 'unpaid' || i.payment_status === 'overdue').reduce((s, i) => s + (i.total || 0), 0);

      const statusCount = (status: string) => shopList.filter((s) => s.status === status).length;

      return {
        clients: clients.count || 0,
        projects: projects.count || 0,
        totalShops,
        stageCounts,
        completed,
        completedPct: totalShops > 0 ? Math.round((completed / totalShops) * 100) : 0,
        inPipeline,
        invoiceCount: invoiceList.length,
        billingTotal,
        paidAmount,
        partialAmount,
        outstandingAmount,
        attention: {
          reviewPending: stageCounts.review || 0,
          designPending: shopList.filter((s) => ['design_pending', 'designing'].includes(s.status)).length,
          readyToDispatch: statusCount('production_done') + statusCount('production_ready'),
          installReview: statusCount('installation_review'),
        },
      };
    },
    enabled: !!orgId,
  });

  const { data: recentActivity } = useQuery({
    queryKey: ['recent-activity', orgId],
    queryFn: async () => {
      const { data } = await supabase
        .from('audit_logs')
        .select('*, profiles(full_name)')
        .eq('organization_id', orgId)
        .order('created_at', { ascending: false })
        .limit(15);
      return data || [];
    },
    enabled: !!orgId,
  });

  // Keeps the KPI row, the pipeline rail and the activity feed all live —
  // a survey submitted or a design approved elsewhere in the app updates
  // this screen the moment it happens, no manual refresh needed.
  useRealtimeInvalidate(
    ['shops', 'surveys', 'design_tasks', 'production_orders', 'installation_jobs', 'invoices', 'audit_logs'],
    orgId,
    [['dashboard-stats', orgId], ['recent-activity', orgId]]
  );

  const attentionItems = stats ? [
    { key: 'review', label: 'Surveys awaiting your approval', count: stats.attention.reviewPending, to: '/survey-review', icon: FileCheck, color: 'amber' },
    { key: 'design', label: 'Shops waiting on a designer', count: stats.attention.designPending, to: '/design', icon: Palette, color: 'fuchsia' },
    { key: 'dispatch', label: 'Ready to dispatch', count: stats.attention.readyToDispatch, to: '/production', icon: Printer, color: 'orange' },
    { key: 'install', label: 'Installations to review', count: stats.attention.installReview, to: '/installation-review', icon: Wrench, color: 'indigo' },
  ].filter((i) => i.count > 0) : [];

  const colorMap: Record<string, string> = {
    amber: 'bg-amber-50 text-amber-600',
    fuchsia: 'bg-fuchsia-50 text-fuchsia-600',
    orange: 'bg-orange-50 text-orange-600',
    indigo: 'bg-indigo-50 text-indigo-600',
  };

  const quickActions = [
    { to: '/shops', label: 'Shops', icon: Store },
    { to: '/survey-review', label: 'Survey Review', icon: FileCheck },
    { to: '/design', label: 'Design Queue', icon: Palette },
    { to: '/production', label: 'Production', icon: Printer },
    { to: '/installation-review', label: 'Installation', icon: Wrench },
    { to: '/billing', label: 'Billing', icon: IndianRupee },
  ];

  const billingSegments = stats ? [
    { key: 'paid', label: 'Paid', value: stats.paidAmount, color: '#10b981' },
    { key: 'partial', label: 'Partially paid', value: stats.partialAmount, color: '#f59e0b' },
    { key: 'outstanding', label: 'Outstanding', value: stats.outstandingAmount, color: '#ef4444' },
  ] : [];

  return (
    <div className="max-w-[1400px] mx-auto">
      {/* Greeting header */}
      <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3 mb-6">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">{greeting()}, {profile?.full_name?.split(' ')[0] || 'there'}</h1>
          <p className="text-sm text-slate-500 mt-1">{format(new Date(), 'EEEE, d MMMM yyyy')} · Here's how things stand right now</p>
        </div>
        <div className="flex items-center gap-4 text-sm">
          <div className="flex items-center gap-1.5 text-slate-500">
            <Building2 className="w-4 h-4 text-slate-400" />
            <span className="font-medium text-slate-700">{stats?.clients ?? '—'}</span> clients
          </div>
          <div className="w-px h-4 bg-slate-200" />
          <div className="flex items-center gap-1.5 text-slate-500">
            <ShoppingCart className="w-4 h-4 text-slate-400" />
            <span className="font-medium text-slate-700">{stats?.projects ?? '—'}</span> campaigns
          </div>
        </div>
      </div>

      {/* KPI row */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <Card className="p-5">
          <div className="flex items-center justify-between mb-3">
            <div className="w-10 h-10 rounded-lg bg-blue-50 text-blue-600 flex items-center justify-center">
              <Store className="w-5 h-5" />
            </div>
          </div>
          <p className="text-2xl font-bold text-slate-900">{stats?.totalShops ?? 0}</p>
          <p className="text-xs text-slate-500 mt-1">Total shops on the books</p>
        </Card>

        <Card className="p-5">
          <div className="flex items-center justify-between mb-3">
            <div className="w-10 h-10 rounded-lg bg-cyan-50 text-cyan-600 flex items-center justify-center">
              <Activity className="w-5 h-5" />
            </div>
          </div>
          <p className="text-2xl font-bold text-slate-900">{stats?.inPipeline ?? 0}</p>
          <p className="text-xs text-slate-500 mt-1">Currently moving through the pipeline</p>
        </Card>

        <Card className="p-5">
          <div className="flex items-center justify-between mb-2">
            <div className="w-10 h-10 rounded-lg bg-emerald-50 text-emerald-600 flex items-center justify-center">
              <CheckCircle2 className="w-5 h-5" />
            </div>
            <span className="text-xs font-semibold text-emerald-600">{stats?.completedPct ?? 0}%</span>
          </div>
          <p className="text-2xl font-bold text-slate-900">{stats?.completed ?? 0}</p>
          <p className="text-xs text-slate-500 mt-1 mb-2">Installed &amp; billed</p>
          <ProgressBar pct={stats?.completedPct ?? 0} />
        </Card>

        <Card className="p-5">
          <div className="flex items-center justify-between mb-3">
            <div className="w-10 h-10 rounded-lg bg-green-50 text-green-600 flex items-center justify-center">
              <IndianRupee className="w-5 h-5" />
            </div>
          </div>
          <p className="text-2xl font-bold text-slate-900">{formatRupees(stats?.billingTotal ?? 0)}</p>
          <p className="text-xs text-slate-500 mt-1">Billed across {stats?.invoiceCount ?? 0} invoices</p>
        </Card>
      </div>

      {/* Pipeline rail */}
      <Card className="p-5 mb-6">
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-sm font-semibold text-slate-900">Pipeline at a glance</h2>
          <span className="text-xs text-slate-400">Tap a stage to open its queue</span>
        </div>
        <div className="grid grid-cols-3 sm:grid-cols-6 gap-3">
          {STAGE_DEFS.map((stage, idx) => {
            const Icon = stage.icon;
            const count = stats?.stageCounts?.[stage.key] ?? 0;
            return (
              <Link
                key={stage.key}
                to={stage.to}
                className="group relative flex flex-col items-center text-center px-2 py-3 rounded-lg hover:bg-slate-50 transition"
              >
                {idx < STAGE_DEFS.length - 1 && (
                  <span className="hidden sm:block absolute top-8 left-1/2 w-full h-px bg-slate-200" style={{ transform: 'translateX(20px)' }} />
                )}
                <div className="relative z-10 w-11 h-11 rounded-full bg-white border-2 border-slate-200 group-hover:border-blue-400 flex items-center justify-center mb-2 transition-colors">
                  <Icon className="w-[18px] h-[18px] text-slate-500 group-hover:text-blue-600" />
                </div>
                <p className="text-lg font-bold text-slate-900 leading-none">{count}</p>
                <p className="text-[11px] text-slate-500 mt-1">{stage.label}</p>
              </Link>
            );
          })}
        </div>
      </Card>

      {/* Attention + Billing snapshot */}
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-6 mb-6">
        <Card className="p-6 lg:col-span-3">
          <div className="flex items-center gap-2 mb-4">
            <Zap className="w-[18px] h-[18px] text-amber-500" />
            <h2 className="text-sm font-semibold text-slate-900">Needs your attention</h2>
          </div>
          {statsLoading ? (
            <p className="text-sm text-slate-400">Loading…</p>
          ) : attentionItems.length > 0 ? (
            <div className="space-y-2">
              {attentionItems.map((item) => {
                const Icon = item.icon;
                return (
                  <Link
                    key={item.key}
                    to={item.to}
                    className="flex items-center gap-3 p-3 rounded-lg border border-slate-100 hover:border-slate-200 hover:bg-slate-50 transition group"
                  >
                    <div className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 ${colorMap[item.color]}`}>
                      <Icon className="w-[18px] h-[18px]" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-slate-800">{item.label}</p>
                    </div>
                    <span className="text-sm font-bold text-slate-900">{item.count}</span>
                    <ChevronRight className="w-4 h-4 text-slate-300 group-hover:text-slate-500 shrink-0" />
                  </Link>
                );
              })}
            </div>
          ) : (
            <div className="flex items-center gap-3 py-6 px-3 text-center flex-col">
              <PartyPopper className="w-7 h-7 text-emerald-500" />
              <div>
                <p className="text-sm font-semibold text-slate-700">All caught up</p>
                <p className="text-xs text-slate-400 mt-0.5">Nothing is waiting on you right now.</p>
              </div>
            </div>
          )}
        </Card>

        <Card className="p-6 lg:col-span-2">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-semibold text-slate-900">Billing snapshot</h2>
            <Link to="/billing" className="text-xs text-blue-600 hover:text-blue-700 font-medium flex items-center gap-0.5">
              View <ArrowRight className="w-3 h-3" />
            </Link>
          </div>
          <div className="flex items-center gap-5">
            <DonutChart
              segments={billingSegments}
              size={128}
              strokeWidth={16}
              centerValue={formatRupees(stats?.billingTotal ?? 0).replace('Rs ', '')}
              centerLabel="total"
            />
            <div className="flex-1 space-y-2.5 min-w-0">
              {billingSegments.map((seg) => (
                <div key={seg.key} className="flex items-center gap-2 text-xs">
                  <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: seg.color }} />
                  <span className="text-slate-500 flex-1 truncate">{seg.label}</span>
                  <span className="font-semibold text-slate-800">{formatRupees(seg.value)}</span>
                </div>
              ))}
            </div>
          </div>
        </Card>
      </div>

      {/* Activity + Quick actions */}
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
        <Card className="p-6 lg:col-span-3">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <Clock className="w-[18px] h-[18px] text-slate-400" />
              <h2 className="text-sm font-semibold text-slate-900">Recent activity</h2>
            </div>
            {recentActivity && recentActivity.length > 6 && (
              <button
                onClick={() => setShowAllActivity((v) => !v)}
                className="text-xs text-blue-600 hover:text-blue-700 font-medium"
              >
                {showAllActivity ? 'Show less' : 'Show more'}
              </button>
            )}
          </div>
          {recentActivity && recentActivity.length > 0 ? (
            <div className="space-y-0.5">
              {(showAllActivity ? recentActivity : recentActivity.slice(0, 6)).map((log) => (
                <div key={log.id} className="flex items-start gap-3 py-2 border-b border-slate-50 last:border-0">
                  <div className="w-1.5 h-1.5 rounded-full bg-blue-500 mt-2 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-slate-700 leading-snug">{log.description || `${log.action} on ${log.table_name}`}</p>
                    <p className="text-xs text-slate-400 mt-0.5">
                      {log.profiles?.full_name || 'System'} · {formatDistanceToNowStrict(new Date(log.created_at), { addSuffix: true })}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <EmptyState icon={<Activity className="w-8 h-8" />} title="No activity yet" subtitle="Actions across the platform will show up here." />
          )}
        </Card>

        <Card className="p-6 lg:col-span-2">
          <div className="flex items-center gap-2 mb-4">
            <ArrowUpRight className="w-[18px] h-[18px] text-slate-400" />
            <h2 className="text-sm font-semibold text-slate-900">Quick actions</h2>
          </div>
          <div className="grid grid-cols-2 gap-2.5">
            {quickActions.map((action) => {
              const Icon = action.icon;
              return (
                <Link
                  key={action.to}
                  to={action.to}
                  className="flex flex-col gap-2 p-3.5 rounded-lg border border-slate-100 hover:border-blue-200 hover:bg-blue-50/50 transition group"
                >
                  <Icon className="w-[18px] h-[18px] text-slate-400 group-hover:text-blue-600 transition-colors" />
                  <span className="text-sm font-medium text-slate-700 group-hover:text-slate-900">{action.label}</span>
                </Link>
              );
            })}
          </div>
        </Card>
      </div>
    </div>
  );
}
