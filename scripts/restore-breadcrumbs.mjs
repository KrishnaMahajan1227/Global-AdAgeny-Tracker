#!/usr/bin/env node
// Surgical, idempotent restore: never replace an entire AdminLayout file.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = process.argv[2] ? path.resolve(process.argv[2]) : process.cwd();
const filename = path.join(root, 'src/components/AdminLayout.tsx');
if (!fs.existsSync(filename)) throw new Error(`Missing ${filename}`);
let source = fs.readFileSync(filename, 'utf8');
if (source.includes('aria-label="Recently visited pages"')) {
  console.log('Breadcrumb navigation already present. Nothing changed.');
  process.exit(0);
}
const baseline = source;

function replaceOnce(before, after, description) {
  const segments = source.split(before);
  if (segments.length !== 2) throw new Error(`Cannot safely apply ${description}: expected exactly one matching anchor; no file changes written.`);
  source = segments.join(after);
}
replaceOnce("import { useState } from 'react';", "import { useEffect, useState } from 'react';", 'React import');
replaceOnce("import { NavLink, Outlet, useNavigate, useLocation } from 'react-router-dom';", "import { Link, NavLink, Outlet, useNavigate, useLocation } from 'react-router-dom';", 'router import');
replaceOnce("Route as RouteIcon, User,", "Route as RouteIcon, User, ChevronRight,", 'chevron icon import');
replaceOnce("  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);", `  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  // Restore the existing navigation history, scoped per agency user.
  const [recentPages, setRecentPages] = useState<{ path: string; label: string }[]>([]);`, 'breadcrumb state');
replaceOnce("  async function handleSignOut() {", `  useEffect(() => {
    if (!profile?.id || !profile.organization_id) return;
    const key = \adroute-admin-recent:\${profile.organization_id}:\${profile.id}\;
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
        typeof p?.path === 'string' && p.path.startsWith('/') && typeof p.label === 'string');
    } catch { /* Storage may be unavailable; navigation still works. */ }
    const next = [...previous.filter(p => p.path.split('?')[0] !== location.pathname),
      { path: currentPath, label }].slice(-3);
    setRecentPages(next);
    try { sessionStorage.setItem(key, JSON.stringify(next)); } catch { /* Storage unavailable. */ }
  }, [location.pathname, location.search, profile?.id, profile?.organization_id]);

  async function handleSignOut() {`, 'history effect');
replaceOnce('            <div className="flex-1" />\n            <NotificationBell />', `            <nav aria-label="Recently visited pages" className="ml-3 flex min-w-0 flex-1 items-center gap-1 overflow-hidden text-xs sm:ml-0">
              {recentPages.map((page, index) => <span key={\\${page.path}:\${index}\} className="flex min-w-0 items-center gap-1">
                {index > 0 && <ChevronRight className="h-3 w-3 shrink-0 text-slate-300" />}
                <Link to={page.path} aria-current={index === recentPages.length - 1 ? 'page' : undefined} title={page.label} className={\max-w-[85px] truncate rounded px-1 py-1 hover:bg-slate-100 focus-visible:ring-2 focus-visible:ring-blue-500 sm:max-w-[150px] \${index === recentPages.length - 1 ? 'font-semibold text-slate-900' : 'text-slate-500'}\}>{page.label}</Link>
              </span>)}
            </nav>
            <NotificationBell />`, 'header breadcrumbs');
// Convert placeholder sentinels into JS template literal backticks.
source = source.replaceAll('\u0011', '`');
const backupDir = path.join(root, '.git', 'adroute-patch-backups');
if (!fs.existsSync(path.join(root, '.git'))) throw new Error('Git repository not found; no changes written.');
fs.mkdirSync(backupDir, { recursive: true });
const backup = path.join(backupDir, `AdminLayout.before-breadcrumb-restore.${Date.now()}.${process.pid}.bak`);
fs.copyFileSync(filename, backup, fs.constants.COPYFILE_EXCL);
try {
  fs.writeFileSync(filename, source);
  console.log(`Breadcrumb history restored in ${path.relative(root, filename)}`);
  console.log(`Backup: ${path.relative(root, backup)}`);
} catch(e) {
  fs.writeFileSync(filename, baseline);
  throw e;
}
