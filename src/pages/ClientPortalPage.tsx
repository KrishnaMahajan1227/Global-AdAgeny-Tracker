import { useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { ROLE_LABELS } from '@/lib/types';
import { NotificationBell } from '@/components/NotificationBell';
import {
  LayoutDashboard, ClipboardList, Building2, Store,
  FileBarChart, LogOut, Menu, X, Megaphone, User,
} from 'lucide-react';

// The Client Organization portal shell. Mirrors AdminLayout.tsx's sidebar +
// top-bar pattern so the two apps feel like one product. IA is
// deliberately a drill-down: Overview -> Campaigns -> (open one) -> its
// Work Orders -> (open one) -> everything about that Work Order
// (progress, shops+photos, report, map) lives nested inside its own
// detail page. Shops also gets its own top-level entry — a client-wide
// view across every campaign/Work Order, since at real scale a client
// needs to find "that one site" without first remembering which campaign
// or Work Order it lives under. Agencies and Reports stay top-level too,
// for the same reason: genuinely cross-campaign views.
//
// No Billing / pricing anywhere in this portal, on purpose — a Client
// Organization user never sees agency rate, Work Order amounts, or
// invoice/payment data.
const NAV_ITEMS = [
  { to: '/client', label: 'Overview', icon: LayoutDashboard, end: true, accent: 'text-blue-400', countKey: null as null | 'campaigns' | 'shops' | 'agencies' },
  { to: '/client/campaigns', label: 'Campaigns', icon: ClipboardList, end: false, accent: 'text-violet-400', countKey: 'campaigns' as const },
  { to: '/client/shops', label: 'Shops', icon: Store, end: false, accent: 'text-purple-400', countKey: 'shops' as const },
  { to: '/client/agencies', label: 'Agencies', icon: Building2, end: false, accent: 'text-amber-400', countKey: 'agencies' as const },
  { to: '/client/reports', label: 'Reports', icon: FileBarChart, end: false, accent: 'text-teal-400', countKey: null },
  { to: '/client/account', label: 'My Account', icon: User, end: false, accent: 'text-slate-400', countKey: null },
];

export default function ClientPortalPage() {
  const { profile, signOut } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const orgId = profile?.organization_id;
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const { data: org } = useQuery({
    queryKey: ['client-portal-org', orgId],
    queryFn: async () => {
      const { data, error } = await supabase.from('organizations').select('id, name').eq('id', orgId).maybeSingle();
      if (error) throw error;
      return data;
    },
    enabled: !!orgId,
  });

  // Live counts for the sidebar's badges — each a `head: true` count
  // query (returns just a number, never the rows), so this stays cheap
  // and accurate regardless of how many agencies or shops this client
  // ends up with. Independent from whatever the currently-open page has
  // already fetched, since the sidebar is a shared shell around every
  // client page, not just Overview.
  const { data: campaignCount } = useQuery({
    queryKey: ['client-nav-count-campaigns', orgId],
    queryFn: async () => {
      const { count, error } = await supabase.from('campaigns').select('id', { count: 'exact', head: true }).eq('client_org_id', orgId).eq('status', 'active');
      if (error) throw error;
      return count ?? 0;
    },
    enabled: !!orgId,
    refetchInterval: 30000,
  });
  const { data: shopCount } = useQuery({
    queryKey: ['client-nav-count-shops', orgId],
    queryFn: async () => {
      const { count, error } = await supabase.from('shops').select('id', { count: 'exact', head: true }).neq('status', 'cancelled');
      if (error) throw error;
      return count ?? 0;
    },
    enabled: !!orgId,
    refetchInterval: 30000,
  });
  const { data: agencyCount } = useQuery({
    queryKey: ['client-nav-count-agencies', orgId],
    queryFn: async () => {
      const { count, error } = await supabase.from('client_agency_links').select('id', { count: 'exact', head: true }).eq('client_org_id', orgId).eq('status', 'active');
      if (error) throw error;
      return count ?? 0;
    },
    enabled: !!orgId,
    refetchInterval: 30000,
  });
  const navCounts = { campaigns: campaignCount, shops: shopCount, agencies: agencyCount };

  async function handleSignOut() {
    await signOut();
    navigate('/login');
  }

  const initials = (profile?.full_name || '')
    .split(' ')
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase();

  const currentSection = NAV_ITEMS.find((item) => (item.end ? location.pathname === item.to : location.pathname.startsWith(item.to)));

  return (
    <div className="min-h-screen bg-slate-50">
      {/* Sidebar - Desktop */}
      <aside className={`fixed inset-y-0 left-0 w-64 bg-slate-900 text-white z-40 flex flex-col transform transition-transform lg:translate-x-0 ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'}`}>
        <div className="flex items-center justify-between px-4 py-4 border-b border-slate-800">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-blue-600 flex items-center justify-center shrink-0">
              <Megaphone className="w-4.5 h-4.5 text-white" />
            </div>
            <div className="leading-tight">
              <h1 className="font-semibold text-[15px]">Client Portal</h1>
              <p className="text-[11px] text-slate-500">Campaign Tracking</p>
            </div>
          </div>
          <button onClick={() => setSidebarOpen(false)} className="lg:hidden text-slate-400 hover:text-white">
            <X className="w-5 h-5" />
          </button>
        </div>

        <nav className="flex-1 px-3 py-4 space-y-0.5 overflow-y-auto">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            const count = item.countKey ? navCounts[item.countKey] : undefined;
            return (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                onClick={() => setSidebarOpen(false)}
                className={({ isActive }) =>
                  `group flex items-center gap-3 pl-2.5 pr-3 py-2.5 rounded-lg text-sm font-medium border-l-2 transition ${
                    isActive
                      ? 'bg-slate-800 text-white border-blue-500'
                      : 'text-slate-400 border-transparent hover:bg-slate-800/60 hover:text-slate-200'
                  }`
                }
              >
                {({ isActive }) => (
                  <>
                    <Icon className={`w-[18px] h-[18px] shrink-0 ${isActive ? item.accent : ''}`} />
                    <span className="flex-1">{item.label}</span>
                    {!!count && count > 0 && (
                      <span className={`text-[11px] font-semibold rounded-full px-1.5 py-0.5 min-w-[20px] text-center ${isActive ? 'bg-slate-700 text-slate-200' : 'bg-slate-800 text-slate-400'}`}>
                        {count}
                      </span>
                    )}
                  </>
                )}
              </NavLink>
            );
          })}
        </nav>

        <div className="p-3 border-t border-slate-800 shrink-0">
          <div className="flex items-center gap-3 px-2 py-2 rounded-lg mb-1">
            <div className="w-9 h-9 rounded-full bg-blue-600 flex items-center justify-center text-white text-xs font-semibold shrink-0">
              {initials || profile?.full_name?.charAt(0)}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium truncate">{profile?.full_name}</p>
              <p className="text-[11px] text-slate-500">{ROLE_LABELS[profile?.role || ''] || profile?.role}</p>
            </div>
            <button onClick={handleSignOut} title="Sign out" className="text-slate-500 hover:text-white transition p-1.5 rounded-lg hover:bg-slate-800">
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        </div>
      </aside>

      {/* Overlay for mobile */}
      {sidebarOpen && <div className="fixed inset-0 bg-black/50 z-30 lg:hidden" onClick={() => setSidebarOpen(false)} />}

      {/* Main content */}
      <div className="lg:ml-64">
        <header className="bg-white border-b border-slate-200 sticky top-0 z-20">
          <div className="flex items-center justify-between px-4 py-3 gap-3">
            <button onClick={() => setSidebarOpen(true)} className="lg:hidden text-slate-600 shrink-0">
              <Menu className="w-6 h-6" />
            </button>
            {/* Desktop-only breadcrumb — gives the top bar real content
                (which section you're in, and which org you're signed in
                as) instead of sitting empty except for the bell. */}
            <div className="hidden lg:flex items-center gap-2 text-sm min-w-0">
              <span className="font-medium text-slate-700 truncate">{org?.name || 'Client Portal'}</span>
              {currentSection && (
                <>
                  <span className="text-slate-300">/</span>
                  <span className="text-slate-400">{currentSection.label}</span>
                </>
              )}
            </div>
            <div className="flex-1" />
            <NotificationBell />
          </div>
        </header>

        <main className="p-4 lg:p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
