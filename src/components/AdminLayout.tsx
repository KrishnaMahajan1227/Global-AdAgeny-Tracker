import { useEffect, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useNavigate, useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { ROLE_LABELS } from '@/lib/types';
import { NotificationBell } from '@/components/NotificationBell';
import { useRealtimeInvalidate } from '@/lib/useRealtimeInvalidate';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { APP_RELEASE, APP_WORKFLOW } from '@/lib/release';
import { LayoutDashboard, Building2, FileCheck, Palette,
  Printer, Wrench, FileText, IndianRupee, Settings, LogOut, Menu, X, PanelLeftClose, PanelLeftOpen,
  Map as MapIcon, ClipboardCheck, ClipboardList, Route as RouteIcon, User, ChevronRight,
} from 'lucide-react';

export default function AdminLayout() {
  const { profile, signOut } = useAuth();
  const navigate = useNavigate();
  // Keys the Outlet's error boundary below, so navigating to ANY other
  // page — even by clicking a sidebar link while the current page is
  // showing that boundary's crash fallback — mounts a fresh boundary
  // with a clean slate for the new page. Without this, a boundary that
  // catches an error stays showing that fallback forever (error
  // boundaries don't reset their own state just because their children
  // changed), which would otherwise mean one broken page effectively
  // breaks the sidebar-navigation recovery path too.
  const location = useLocation();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const sidebarRef = useRef<HTMLElement>(null);
  const openNavButtonRef = useRef<HTMLButtonElement>(null);
  // Restore the existing navigation history, scoped per agency user.
  const [recentPages, setRecentPages] = useState<{ path: string; label: string }[]>([]);
  const orgId = profile?.organization_id;

  const isOwner = profile?.role === 'agency_owner';
  const isClientManager = profile?.role === 'client_manager';
  const isAdmin = profile?.role === 'admin' || isOwner || profile?.role === 'demo';
  const isAccounts = profile?.role === 'accounts';
  const isDesigner = profile?.role === 'designer';
  const isProduction = profile?.role === 'printing';

  // Live "things waiting on you" counts for the nav — so a newly submitted
  // survey / design ready for review / production ready to complete is
  // visible the moment it happens, not just after a manual page reload.
  // Kept separate from each page's own query so this works even before
  // that page has ever been opened in this session.
  const { data: pendingCounts } = useQuery({
    queryKey: ['nav-pending-counts', orgId, profile?.id, isDesigner, isProduction],
    queryFn: async () => {
      if (!orgId) return { survey: 0, design: 0, production: 0, installation: 0, clientRequests: 0 };
      // Admin's "Design Queue" badge means "waiting on YOU to review" —
      // in_review. A designer's own sidebar badge means something
      // different ("waiting on you to actually design something"), so it
      // counts their own assigned/in-progress tasks that have no design
      // uploaded yet, scoped to designer_id so one designer never sees
      // another designer's pending count.
      const designQuery = isDesigner && !isAdmin
        ? supabase.from('design_tasks').select('id', { count: 'exact', head: true }).eq('organization_id', orgId).eq('designer_id', profile?.id).in('status', ['assigned', 'designing'])
        : supabase.from('design_tasks').select('id', { count: 'exact', head: true }).eq('organization_id', orgId).eq('status', 'in_review');
      // Same split as design: admin's badge means "orders ready for me to
      // mark completed" (in_production/ready); a production/printing
      // user's own badge means "orders assigned to me still needing work"
      // (pending/in_production), scoped to them so one printer never sees
      // another printer's queue size.
      const productionQuery = isProduction && !isAdmin
        ? supabase.from('production_orders').select('id', { count: 'exact', head: true }).eq('organization_id', orgId).eq('assigned_to', profile?.id).in('status', ['pending', 'in_production'])
        : supabase.from('production_orders').select('id', { count: 'exact', head: true }).eq('organization_id', orgId).in('status', ['in_production', 'ready']);
      const [surveys, designTasks, productionOrders, installationJobs, clientRequests] = await Promise.all([
        supabase.from('surveys').select('id', { count: 'exact', head: true }).eq('organization_id', orgId).eq('status', 'submitted'),
        designQuery,
        productionQuery,
        supabase.from('installation_jobs').select('id', { count: 'exact', head: true }).eq('organization_id', orgId).eq('review_status', 'pending'),
        // Phase 2 — client-created POs still waiting on Accept/Reject
        // (Client Requests inbox on the Purchase Orders page).
        supabase.from('purchase_orders').select('id', { count: 'exact', head: true }).eq('organization_id', orgId).eq('origin', 'client_created').eq('assignment_status', 'pending_acceptance'),
      ]);
      return {
        survey: surveys.count || 0,
        design: designTasks.count || 0,
        production: productionOrders.count || 0,
        installation: installationJobs.count || 0,
        clientRequests: clientRequests.count || 0,
      };
    },
    enabled: !!orgId && (isAdmin || isDesigner || isProduction),
  });

  useRealtimeInvalidate(
    ['surveys', 'design_tasks', 'production_orders', 'installation_jobs', 'purchase_orders'],
    (isAdmin || isDesigner || isProduction) ? orgId : undefined,
    [['nav-pending-counts', orgId, profile?.id, isDesigner, isProduction]]
  );

  const navItems = [
    { to: '/dashboard', label: 'Dashboard', icon: LayoutDashboard, show: isAdmin || isAccounts || isClientManager },
    { to: '/clients', label: 'Clients', icon: Building2, show: isAdmin || isClientManager },
    { to: '/purchase-orders', label: 'Work Orders', icon: ClipboardList, show: isAdmin || isAccounts || isClientManager, badge: pendingCounts?.clientRequests },
    { to: '/survey-review', label: 'Survey Review', icon: FileCheck, show: isAdmin, badge: pendingCounts?.survey },
    { to: '/design', label: 'Design Queue', icon: Palette, show: isOwner || profile?.role === 'admin' || isDesigner, badge: (isOwner || profile?.role === 'admin' || isDesigner) ? pendingCounts?.design : undefined },
    { to: '/production', label: 'Production', icon: Printer, show: isOwner || profile?.role === 'admin' || isProduction, badge: (isOwner || profile?.role === 'admin' || isProduction) ? pendingCounts?.production : undefined },
    { to: '/installation-review', label: 'Installation Review', icon: ClipboardCheck, show: isAdmin, badge: pendingCounts?.installation },
    { to: '/field-map', label: 'Live Field Map', icon: MapIcon, show: isAdmin },
    { to: '/route-planning', label: 'Route Planning', icon: RouteIcon, show: isAdmin },
    { to: '/reports', label: 'Reports', icon: FileText, show: isAdmin || isAccounts || isClientManager },
    { to: '/billing', label: 'Billing', icon: IndianRupee, show: isAdmin || isAccounts || isClientManager },
    { to: '/owner', label: 'Owner Console', icon: Settings, show: isOwner },
    { to: '/account', label: 'My Account', icon: User, show: true },
  ].filter((item) => item.show);

  useEffect(() => {
    if (!profile?.id || !profile.organization_id) return;
    const key = `adroute-admin-recent:${profile.organization_id}:${profile.id}`;
    const labels: Record<string, string> = {
      '/dashboard': 'Dashboard', '/clients': 'Clients', '/purchase-orders': 'Work Orders',
      '/supply-orders': 'Work Orders', '/survey-review': 'Survey Review', '/design': 'Design Queue',
      '/production': 'Production', '/installation-review': 'Installation Review',
      '/field-map': 'Field Map', '/route-planning': 'Route Planning', '/reports': 'Reports',
      '/billing': 'Billing', '/owner': 'Owner Console', '/account': 'My Account', '/shops': 'Shops',
    };
    const label = labels[location.pathname] ||
      Object.entries(labels).find(([prefix]) => location.pathname.startsWith(prefix + '/'))?.[1] || 'Details';
    const currentPath = location.pathname + location.search;
    let previous: { path: string; label: string }[] = [];
    try {
      const parsed = JSON.parse(sessionStorage.getItem(key) || '[]');
      if (Array.isArray(parsed)) previous = parsed.filter((p: any) =>
        typeof p?.path === 'string' && p.path.startsWith('/') &&
        !/^\/(campaigns|projects)(\/|\?|$)/.test(p.path) &&
        (navItems.some(item => p.path.split('?')[0] === item.to) ||
          (p.path.startsWith('/shops') && navItems.some(item => item.to==='/purchase-orders'))) &&
        typeof p.label === 'string');
    } catch { /* Storage may be unavailable; navigation still works. */ }
    const next = [...previous.filter(p => p.path.split('?')[0] !== location.pathname),
      { path: currentPath, label }].slice(-3);
    setRecentPages(next);
    try { sessionStorage.setItem(key, JSON.stringify(next)); } catch { /* Storage unavailable. */ }
  }, [location.pathname, location.search, profile?.id, profile?.organization_id]);

  // Mobile drawer scroll/focus behavior: prevent the page beneath the
  // navigation from scrolling; Escape closes it. Desktop nav is unchanged.
  useEffect(() => {
    if (!sidebarOpen || window.innerWidth >= 1024) return;
    const previousOverflow = document.body.style.overflow;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    document.body.style.overflow = 'hidden';
    sidebarRef.current?.querySelector<HTMLButtonElement>('[aria-label="Close navigation"]')?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); setSidebarOpen(false); }
      if (event.key !== 'Tab') return;
      const focusable = Array.from(sidebarRef.current?.querySelectorAll<HTMLElement>('a[href], button:not([disabled])') || [])
        .filter(element => element.getClientRects().length > 0);
      if (!focusable.length) return;
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', onKeyDown);
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, [sidebarOpen]);

  async function handleSignOut() {
    await signOut();
    navigate('/login');
  }

  return (
    <div className="min-h-screen bg-slate-50">
      {/* Sidebar - Desktop */}
      <aside ref={sidebarRef} className={`fixed inset-y-0 left-0 z-40 flex h-[100dvh] w-64 flex-col overflow-hidden bg-slate-900 text-white transform transition-[width,transform] duration-200 lg:translate-x-0 ${sidebarCollapsed ? 'lg:w-[76px]' : 'lg:w-64'} ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'}`}>
        <div className="flex shrink-0 items-center justify-between gap-2 border-b border-slate-700 px-3 py-3">
          <button type="button" onClick={() => setSidebarCollapsed(!sidebarCollapsed)} className="hidden lg:inline-flex rounded-lg p-2 hover:bg-slate-800" aria-label={sidebarCollapsed ? 'Expand navigation' : 'Collapse navigation'} title={sidebarCollapsed ? 'Expand navigation' : 'Collapse navigation'}>{sidebarCollapsed ? <PanelLeftOpen className="w-5 h-5" /> : <PanelLeftClose className="w-5 h-5" />}</button>
          <div className={`min-w-0 flex-1 ${sidebarCollapsed ? 'lg:hidden' : ''}`}>
            <p className="truncate text-base font-semibold leading-6">Darshan Ad Agency</p>
            <p className="truncate text-[11px] text-slate-400">Operations Platform</p>
          </div>
          <button type="button" aria-label="Close navigation" onClick={() => setSidebarOpen(false)} className="lg:hidden rounded-lg p-2 text-slate-400 hover:bg-slate-800">
            <X className="w-5 h-5" />
          </button>
        </div>

        <nav id="agency-sidebar-navigation" className="app-sidebar-scroll min-h-0 flex-1 space-y-1 overflow-y-auto overscroll-contain px-2 py-3" aria-label="Agency navigation">
          {navItems.map((item) => {
            const Icon = item.icon;
            return (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.to === '/dashboard'}
                onClick={() => setSidebarOpen(false)}
                title={item.label}
                aria-label={item.label}
                className={({ isActive }) =>
                  `relative flex min-h-10 items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                    isActive ? 'bg-blue-600 text-white' : 'text-slate-300 hover:bg-slate-800'
                  }`
                }
              >
                <Icon className="w-5 h-5" />
                <span className={`flex-1 ${sidebarCollapsed ? 'lg:hidden' : ''}`}>{item.label}</span>
                {!!item.badge && (
                  <span className={`${sidebarCollapsed ? 'lg:absolute lg:right-0 lg:top-0 lg:translate-x-1/3 lg:-translate-y-1/3' : ''} min-w-[20px] h-5 px-1.5 rounded-full bg-red-500 text-white text-[11px] font-bold flex items-center justify-center`}>
                    {item.badge}
                  </span>
                )}
              </NavLink>
            );
          })}
        </nav>

        <div className="shrink-0 border-t border-slate-700 bg-slate-900 px-3 py-3">
          <div className="flex items-center gap-3 mb-2">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-slate-700 font-semibold text-white">
              {profile?.full_name?.charAt(0)}
            </div>
            <div className={`flex-1 min-w-0 ${sidebarCollapsed ? 'lg:hidden' : ''}`}>
              <p className="text-sm font-medium truncate">{profile?.full_name}</p>
              <p className="text-xs text-slate-400">{ROLE_LABELS[profile?.role || ''] || profile?.role}</p>
            </div>
          </div>
          <div className={`mb-1 px-2 text-[10px] text-slate-500 ${sidebarCollapsed ? 'lg:hidden' : ''}`} title={`Release ${APP_RELEASE} — ${APP_WORKFLOW}`} data-testid="release-marker">
            Work Orders · v{APP_RELEASE}
          </div>
          <button onClick={handleSignOut} title="Sign out" aria-label="Sign out" className="flex min-h-9 w-full items-center gap-2 rounded-lg px-2 text-sm text-slate-400 transition-colors hover:bg-slate-800 hover:text-white">
            <LogOut className="w-4 h-4" /> <span className={sidebarCollapsed ? 'lg:hidden' : ''}>Sign Out</span>
          </button>
        </div>
      </aside>

      {/* Overlay for mobile */}
      {sidebarOpen && <div className="fixed inset-0 bg-black/50 z-30 lg:hidden" onClick={() => setSidebarOpen(false)} />}

      {/* Main content */}
      <div className={`${sidebarCollapsed ? 'lg:ml-[76px]' : 'lg:ml-64'} transition-all duration-200`}>
        {/* Top bar */}
        <header className="bg-white border-b border-slate-200 sticky top-0 z-20">
          <div className="flex items-center justify-between px-4 py-3">
            <button ref={openNavButtonRef} type="button" aria-label="Open navigation" aria-controls="agency-sidebar-navigation" aria-expanded={sidebarOpen} onClick={() => setSidebarOpen(true)} className="lg:hidden rounded-lg p-2 text-slate-600 hover:bg-slate-100">
              <Menu className="w-6 h-6" />
            </button>
            <nav aria-label="Recently visited pages" className="ml-3 flex min-w-0 flex-1 items-center gap-1 overflow-hidden text-xs sm:ml-0">
              {recentPages.map((page, index) => <span key={`${page.path}:${index}`} className="flex min-w-0 items-center gap-1">
                {index > 0 && <ChevronRight className="h-3 w-3 shrink-0 text-slate-300" />}
                <Link to={page.path} aria-current={index === recentPages.length - 1 ? 'page' : undefined} title={page.label} className={`max-w-[85px] truncate rounded px-1 py-1 hover:bg-slate-100 focus-visible:ring-2 focus-visible:ring-blue-500 sm:max-w-[150px] ${index === recentPages.length - 1 ? 'font-semibold text-slate-900' : 'text-slate-500'}`}>{page.label}</Link>
              </span>)}
            </nav>
            <NotificationBell />
          </div>
        </header>

        <main className="p-4 lg:p-6">
          <ErrorBoundary key={location.pathname} boundaryName={location.pathname}>
            <Outlet />
          </ErrorBoundary>
        </main>
      </div>
    </div>
  );
}
