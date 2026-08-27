import { useEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider, useAuth } from '@/lib/auth';
import { Role } from '@/lib/types';
import LoginPage from '@/pages/LoginPage';
import AdminLayout from '@/components/AdminLayout';
import DashboardPage from '@/pages/DashboardPage';
import OwnerConsolePage from '@/pages/OwnerConsolePage';
import { ClientsPage, CampaignsPage, ShopsPage, ShopDetailPage } from '@/pages/ShopsPages';
import PurchaseOrdersPage from '@/pages/PurchaseOrdersPage';
import SupplyOrdersPage from '@/pages/SupplyOrdersPage';
import SurveyReviewPage from '@/pages/SurveyReviewPage';
import DesignerPage from '@/pages/DesignerPage';
import ProductionPage from '@/pages/ProductionPage';
import InstallationReviewPage from '@/pages/InstallationReviewPage';
import ReportsPage from '@/pages/ReportsPage';
import BillingPage from '@/pages/BillingPage';
import FieldMapPage from '@/pages/FieldMapPage';
import RoutePlanningPage from '@/pages/RoutePlanningPage';
import SurveyorPage from '@/pages/SurveyorPage';
import InstallerPage from '@/pages/InstallerPage';
import ClientPortalPage from '@/pages/ClientPortalPage';
import ClientOverviewPage from '@/pages/client/ClientOverviewPage';
import ClientCampaignsPage from '@/pages/client/ClientCampaignsPage';
import ClientCampaignDetailPage from '@/pages/client/ClientCampaignDetailPage';
import ClientPODetailPage from '@/pages/client/ClientPODetailPage';
import ClientShopsPage from '@/pages/client/ClientShopsPage';
import ClientAgenciesPage from '@/pages/client/ClientAgenciesPage';
import ClientReportsPage from '@/pages/client/ClientReportsPage';
import { Loader2 } from 'lucide-react';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { refetchOnWindowFocus: false, retry: 1 },
  },
});

const FIELD_ROLES: Role[] = ['surveyor', 'installer'];
const CLIENT_ORG_ROLES: Role[] = ['client_admin', 'client_viewer'];

// Phase H — roles allowed to open money-carrying screens (Purchase Orders,
// Supply Orders entry, Shops, Billing, Reports). This mirrors what
// AdminLayout's sidebar already hides from 'designer'/'printing' — this is
// the same rule enforced at the route level too, since the sidebar alone
// doesn't stop someone from typing the URL directly. The RLS lockdown
// (migration 0029) is still the real backstop if this is ever missed
// somewhere; this is just so a designer/printing account gets redirected
// instead of landing on a page that now fails to load its data.
const FINANCIAL_ROLES: Role[] = ['agency_owner', 'admin', 'accounts', 'client_manager', 'demo'];

function ProtectedRoute({ children, allowedRoles }: { children: React.ReactNode; allowedRoles?: Role[] }) {
  const { session, profile, loading } = useAuth();
  const location = useLocation();

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <Loader2 className="w-8 h-8 text-blue-600 animate-spin" />
      </div>
    );
  }

  if (!session || !profile) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  if (allowedRoles && !allowedRoles.includes(profile.role)) {
    return <Navigate to={homeRouteForRole(profile.role)} replace />;
  }

  return <>{children}</>;
}

function homeRouteForRole(role: Role) {
  if (FIELD_ROLES.includes(role)) return '/mobile';
  if (CLIENT_ORG_ROLES.includes(role)) return '/client';
  return '/';
}

function RoleRedirect() {
  const { profile } = useAuth();
  if (!profile) return <Navigate to="/login" replace />;
  return <Navigate to={homeRouteForRole(profile.role)} replace />;
}

function AppRoutes() {
  const { session, profile, loading } = useAuth();

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <Loader2 className="w-8 h-8 text-blue-600 animate-spin" />
      </div>
    );
  }

  return (
    <Routes>
      <Route path="/login" element={session ? <RoleRedirect /> : <LoginPage />} />

      {/* Mobile routes for field roles */}
      <Route path="/mobile" element={
        <ProtectedRoute allowedRoles={['surveyor', 'installer']}>
          <MobileRouter />
        </ProtectedRoute>
      } />

      {/* Client Organization portal — Overview / Campaigns / PO Detail
          (with its own nested Shops+Photos / Report / Map) / Agencies /
          Reports. No Billing route — a client org user never sees
          pricing/payment data anywhere in this app. Map Feed is no longer
          a top-level route either — it's scoped inside each PO's own
          detail page (see ClientPODetailPage.tsx's "Map" tab). */}
      <Route path="/client" element={
        <ProtectedRoute allowedRoles={CLIENT_ORG_ROLES}>
          <ClientPortalPage />
        </ProtectedRoute>
      }>
        <Route index element={<ClientOverviewPage />} />
        <Route path="campaigns" element={<ClientCampaignsPage />} />
        <Route path="campaigns/:campaignId" element={<ClientCampaignDetailPage />} />
        <Route path="campaigns/:campaignId/po/:poId" element={<ClientPODetailPage />} />
        <Route path="shops" element={<ClientShopsPage />} />
        <Route path="agencies" element={<ClientAgenciesPage />} />
        <Route path="reports" element={<ClientReportsPage />} />
      </Route>

      {/* Admin/Office routes */}
      <Route element={
        <ProtectedRoute allowedRoles={['agency_owner', 'admin', 'client_manager', 'designer', 'printing', 'accounts', 'demo']}>
          <AdminLayout />
        </ProtectedRoute>
      }>
        <Route path="/" element={<DashboardPage />} />
        <Route path="/clients" element={<ClientsPage />} />
        <Route path="/campaigns" element={<CampaignsPage />} />
        <Route path="/projects" element={<Navigate to="/campaigns" replace />} />
        <Route path="/purchase-orders" element={
          <ProtectedRoute allowedRoles={FINANCIAL_ROLES}><PurchaseOrdersPage /></ProtectedRoute>
        } />
        <Route path="/supply-orders" element={
          <ProtectedRoute allowedRoles={FINANCIAL_ROLES}><SupplyOrdersPage /></ProtectedRoute>
        } />
        <Route path="/shops" element={
          <ProtectedRoute allowedRoles={FINANCIAL_ROLES}><ShopsPage /></ProtectedRoute>
        } />
        <Route path="/shops/:shopId" element={
          <ProtectedRoute allowedRoles={FINANCIAL_ROLES}><ShopDetailPageWrapper /></ProtectedRoute>
        } />
        <Route path="/survey-review" element={<SurveyReviewPage />} />
        <Route path="/design" element={<DesignerPage />} />
        <Route path="/production" element={<ProductionPage />} />
        <Route path="/installation-review" element={<InstallationReviewPage />} />
        <Route path="/field-map" element={<FieldMapPage />} />
        <Route path="/route-planning" element={
          <ProtectedRoute allowedRoles={['agency_owner', 'admin', 'demo']}><RoutePlanningPage /></ProtectedRoute>
        } />
        <Route path="/reports" element={
          <ProtectedRoute allowedRoles={FINANCIAL_ROLES}><ReportsPage /></ProtectedRoute>
        } />
        <Route path="/billing" element={
          <ProtectedRoute allowedRoles={FINANCIAL_ROLES}><BillingPage /></ProtectedRoute>
        } />
        <Route path="/owner" element={
          <ProtectedRoute allowedRoles={['agency_owner']}>
            <OwnerConsolePage />
          </ProtectedRoute>
        } />
      </Route>

      <Route path="*" element={<Navigate to={session && profile ? homeRouteForRole(profile.role) : '/login'} replace />} />
    </Routes>
  );
}

function MobileRouter() {
  const { profile } = useAuth();
  if (profile?.role === 'surveyor') return <SurveyorPage />;
  if (profile?.role === 'installer') return <InstallerPage />;
  return <Navigate to="/login" replace />;
}

function ShopDetailPageWrapper() {
  const location = useLocation();
  const shopId = location.pathname.split('/').pop() || '';
  return <ShopDetailPage shopId={shopId} />;
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <BrowserRouter>
          <AppRoutes />
        </BrowserRouter>
      </AuthProvider>
    </QueryClientProvider>
  );
}
