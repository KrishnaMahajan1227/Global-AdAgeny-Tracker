import { useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { ROLE_LABELS } from '@/lib/types';
import { NotificationBell } from '@/components/NotificationBell';
import { useRealtimeInvalidate } from '@/lib/useRealtimeInvalidate';
import {
  LayoutDashboard, Store, Building2, ShoppingCart, FileCheck, Palette,
  Printer, Wrench, FileText, IndianRupee, Settings, LogOut, Menu, X,
  Map as MapIcon, ClipboardCheck, ClipboardList, Truck, Route as RouteIcon,
} from 'lucide-react';

export default function AdminLayout() {
  const { profile, signOut } = useAuth();
  const navigate = useNavigate();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const orgId = profile?.organization_id;

  const isOwner = profile?.role === 'agency_owner';
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
    { to: '/', label: 'Dashboard', icon: LayoutDashboard, show: isAdmin || isAccounts },
    { to: '/clients', label: 'Clients', icon: Building2, show: isAdmin },
    { to: '/campaigns', label: 'Campaigns', icon: ShoppingCart, show: isAdmin },
    { to: '/purchase-orders', label: 'Work Orders', icon: ClipboardList, show: isAdmin || isAccounts, badge: pendingCounts?.clientRequests },
    { to: '/supply-orders', label: 'Supply Orders', icon: Truck, show: isAdmin || isAccounts },
    { to: '/shops', label: 'Shops', icon: Store, show: isAdmin || isAccounts },
    { to: '/survey-review', label: 'Survey Review', icon: FileCheck, show: isAdmin, badge: pendingCounts?.survey },
    { to: '/design', label: 'Design Queue', icon: Palette, show: isAdmin || isDesigner, badge: (isAdmin || isDesigner) ? pendingCounts?.design : undefined },
    { to: '/production', label: 'Production', icon: Printer, show: isAdmin || isProduction, badge: (isAdmin || isProduction) ? pendingCounts?.production : undefined },
    { to: '/installation-review', label: 'Installation Review', icon: ClipboardCheck, show: isAdmin, badge: pendingCounts?.installation },
    { to: '/field-map', label: 'Live Field Map', icon: MapIcon, show: isAdmin },
    { to: '/route-planning', label: 'Route Planning', icon: RouteIcon, show: isAdmin },
    { to: '/reports', label: 'Reports', icon: FileText, show: isAdmin || isAccounts },
    { to: '/billing', label: 'Billing', icon: IndianRupee, show: isAdmin || isAccounts },
    { to: '/owner', label: 'Owner Console', icon: Settings, show: isOwner },
  ].filter((item) => item.show);

  async function handleSignOut() {
    await signOut();
    navigate('/login');
  }

  return (
    <div className="min-h-screen bg-slate-50">
      {/* Sidebar - Desktop */}
      <aside className={`fixed inset-y-0 left-0 w-64 bg-slate-900 text-white z-40 transform transition-transform lg:translate-x-0 ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'}`}>
        <div className="flex items-center justify-between p-4 border-b border-slate-700">
          <div>
            <h1 className="font-bold text-lg">Darshan Ad Agency</h1>
            <p className="text-xs text-slate-400">Operations Platform</p>
          </div>
          <button onClick={() => setSidebarOpen(false)} className="lg:hidden text-slate-400">
            <X className="w-5 h-5" />
          </button>
        </div>

        <nav className="p-3 space-y-1 overflow-y-auto" style={{ maxHeight: 'calc(100vh - 200px)' }}>
          {navItems.map((item) => {
            const Icon = item.icon;
            return (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.to === '/'}
                onClick={() => setSidebarOpen(false)}
                className={({ isActive }) =>
                  `flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition ${
                    isActive ? 'bg-blue-600 text-white' : 'text-slate-300 hover:bg-slate-800'
                  }`
                }
              >
                <Icon className="w-5 h-5" />
                <span className="flex-1">{item.label}</span>
                {!!item.badge && (
                  <span className="min-w-[20px] h-5 px-1.5 rounded-full bg-red-500 text-white text-[11px] font-bold flex items-center justify-center">
                    {item.badge}
                  </span>
                )}
              </NavLink>
            );
          })}
        </nav>

        <div className="absolute bottom-0 left-0 right-0 p-4 border-t border-slate-700">
          <div className="flex items-center gap-3 mb-3">
            <div className="w-10 h-10 rounded-full bg-slate-700 flex items-center justify-center text-white font-semibold">
              {profile?.full_name?.charAt(0)}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium truncate">{profile?.full_name}</p>
              <p className="text-xs text-slate-400">{ROLE_LABELS[profile?.role || ''] || profile?.role}</p>
            </div>
          </div>
          <button onClick={handleSignOut} className="flex items-center gap-2 text-sm text-slate-400 hover:text-white transition">
            <LogOut className="w-4 h-4" /> Sign Out
          </button>
        </div>
      </aside>

      {/* Overlay for mobile */}
      {sidebarOpen && <div className="fixed inset-0 bg-black/50 z-30 lg:hidden" onClick={() => setSidebarOpen(false)} />}

      {/* Main content */}
      <div className="lg:ml-64">
        {/* Top bar */}
        <header className="bg-white border-b border-slate-200 sticky top-0 z-20">
          <div className="flex items-center justify-between px-4 py-3">
            <button onClick={() => setSidebarOpen(true)} className="lg:hidden text-slate-600">
              <Menu className="w-6 h-6" />
            </button>
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
