import { ReactNode, useState } from 'react';
import { X, SlidersHorizontal, ChevronsLeft, ChevronLeft, ChevronRight, ChevronsRight, Loader2, AlertCircle } from 'lucide-react';

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl';
}

export function Modal({ open, onClose, title, children, size = 'md' }: ModalProps) {
  if (!open) return null;

  const sizes = {
    sm: 'max-w-md',
    md: 'max-w-lg',
    lg: 'max-w-2xl',
    xl: 'max-w-4xl',
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50" onClick={onClose}>
      <div
        className={`bg-white rounded-2xl shadow-2xl w-full ${sizes[size]} max-h-[90vh] overflow-hidden flex flex-col`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200">
          <h2 className="text-lg font-semibold text-slate-900">{title}</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600">
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-6">{children}</div>
      </div>
    </div>
  );
}

interface DrawerProps {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  children: ReactNode;
  width?: 'md' | 'lg' | 'xl';
}

// Slide-in panel from the right — used where a click on a list row should
// surface full detail without navigating away or reflowing the list
// underneath it (e.g. clicking a shop to see its full profile + photos).
export function Drawer({ open, onClose, title, subtitle, children, width = 'md' }: DrawerProps) {
  const widths = { md: 'max-w-md', lg: 'max-w-xl', xl: 'max-w-2xl' };
  return (
    <div
      className={`fixed inset-0 z-50 transition-opacity duration-200 ${open ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'}`}
      aria-hidden={!open}
    >
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div
        className={`absolute top-0 right-0 h-full w-full ${widths[width]} bg-white shadow-2xl flex flex-col transition-transform duration-200 ${open ? 'translate-x-0' : 'translate-x-full'}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 px-5 py-4 border-b border-slate-200 shrink-0">
          <div className="min-w-0">
            <h2 className="text-lg font-semibold text-slate-900 truncate">{title}</h2>
            {subtitle && <p className="text-xs text-slate-500 mt-0.5 truncate">{subtitle}</p>}
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 shrink-0">
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-5">{children}</div>
      </div>
    </div>
  );
}

// A compact "Filters" trigger that opens a side Drawer instead of a bank
// of controls sitting inline on the page — keeps every listing page's
// filter set out of the way (no more scrolling past search/status/zone/
// etc rows just to reach the actual list) while still surfacing how many
// filters are active at a glance, right where the person already is.
export function FilterButton({ activeCount, onClick }: { activeCount: number; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="relative flex items-center gap-2 border border-slate-300 hover:bg-slate-50 text-slate-700 px-3.5 py-2 rounded-lg text-sm font-medium bg-white transition shrink-0"
    >
      <SlidersHorizontal className="w-4 h-4" />
      Filters
      {activeCount > 0 && (
        <span className="flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-blue-600 text-white text-[11px] font-semibold leading-none">
          {activeCount}
        </span>
      )}
    </button>
  );
}

interface FilterDrawerProps {
  open: boolean;
  onClose: () => void;
  onClear?: () => void;
  activeCount?: number;
  resultCount?: number;
  resultLabel?: string;
  children: ReactNode;
}

// The Drawer that FilterButton opens. Filter controls (Select/Input, etc)
// go in `children`, grouped by the caller with FilterSection below.
// Applies live as the person changes each control (no separate "Apply"
// step to trip over) — the sticky footer's "Show N ___" both confirms
// what's currently matching and doubles as the close action.
export function FilterDrawer({ open, onClose, onClear, activeCount = 0, resultCount, resultLabel = 'results', children }: FilterDrawerProps) {
  return (
    <Drawer open={open} onClose={onClose} title="Filters" width="md">
      <div className="space-y-5 pb-16">{children}</div>
      <div className="fixed bottom-0 right-0 w-full max-w-md bg-white border-t border-slate-200 px-5 py-3 flex items-center justify-between gap-3">
        <button
          onClick={onClear}
          disabled={activeCount === 0}
          className="text-sm text-slate-500 hover:text-slate-700 font-medium disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Clear all{activeCount > 0 ? ` (${activeCount})` : ''}
        </button>
        <button onClick={onClose} className="bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium px-4 py-2 rounded-lg transition">
          {resultCount != null ? `Show ${resultCount.toLocaleString('en-IN')} ${resultLabel}` : 'Done'}
        </button>
      </div>
    </Drawer>
  );
}

/** Consistent label + spacing wrapper for one control inside a FilterDrawer. */
export function FilterSection({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <label className="block text-xs font-medium text-slate-500 mb-1.5">{label}</label>
      {children}
    </div>
  );
}

interface PaginationProps {
  page: number; // 0-indexed
  pageSize: number;
  totalItems: number;
  onPageChange: (page: number) => void;
  onPageSizeChange?: (size: number) => void;
  pageSizeOptions?: number[];
  itemLabel?: string;
}

// Standard page-size + prev/next/first/last footer for any list — used by
// every listing page so pagination looks and behaves identically whether
// it's driving a server-paginated query (large tables) or just slicing an
// already-fetched, filtered array client-side (smaller lists). Renders
// nothing when there's nothing to page through.
export function Pagination({ page, pageSize, totalItems, onPageChange, onPageSizeChange, pageSizeOptions = [10, 25, 50, 100], itemLabel = 'items' }: PaginationProps) {
  if (totalItems === 0) return null;
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  const rangeStart = page * pageSize + 1;
  const rangeEnd = Math.min(totalItems, page * pageSize + pageSize);

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 border-t border-slate-100 bg-slate-50/60">
      <div className="flex items-center gap-2 text-xs text-slate-500">
        {onPageSizeChange && (
          <>
            <span>Rows per page</span>
            <select
              value={pageSize}
              onChange={(e) => onPageSizeChange(Number(e.target.value))}
              className="px-2 py-1 border border-slate-300 rounded-md text-xs bg-white outline-none focus:ring-2 focus:ring-blue-500"
            >
              {pageSizeOptions.map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </>
        )}
        <span className="ml-2 hidden sm:inline">{rangeStart}–{rangeEnd} of {totalItems.toLocaleString('en-IN')} {itemLabel}</span>
      </div>
      <div className="flex items-center gap-1">
        <button
          onClick={() => onPageChange(0)}
          disabled={page === 0}
          title="First page"
          className="p-1.5 rounded-md text-slate-500 hover:bg-white hover:text-blue-600 disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-slate-500 border border-transparent hover:border-slate-200"
        >
          <ChevronsLeft className="w-4 h-4" />
        </button>
        <button
          onClick={() => onPageChange(Math.max(0, page - 1))}
          disabled={page === 0}
          title="Previous page"
          className="p-1.5 rounded-md text-slate-500 hover:bg-white hover:text-blue-600 disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-slate-500 border border-transparent hover:border-slate-200"
        >
          <ChevronLeft className="w-4 h-4" />
        </button>
        <span className="text-xs text-slate-600 font-medium px-2 whitespace-nowrap">
          Page {page + 1} of {totalPages.toLocaleString('en-IN')}
        </span>
        <button
          onClick={() => onPageChange(Math.min(totalPages - 1, page + 1))}
          disabled={page >= totalPages - 1}
          title="Next page"
          className="p-1.5 rounded-md text-slate-500 hover:bg-white hover:text-blue-600 disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-slate-500 border border-transparent hover:border-slate-200"
        >
          <ChevronRight className="w-4 h-4" />
        </button>
        <button
          onClick={() => onPageChange(totalPages - 1)}
          disabled={page >= totalPages - 1}
          title="Last page"
          className="p-1.5 rounded-md text-slate-500 hover:bg-white hover:text-blue-600 disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-slate-500 border border-transparent hover:border-slate-200"
        >
          <ChevronsRight className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}

interface ConfirmDialogProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  message: string;
  confirmLabel?: string;
  danger?: boolean;
  /** When true, the dialog does NOT auto-close after Confirm is clicked —
   *  the caller is responsible for calling onClose() itself (typically
   *  from the mutation's onSuccess). Pairs with `loading`/`error` below so
   *  a delete/confirm action can show a spinner while it's in flight and
   *  stay open with a visible error (instead of vanishing) if it fails. */
  manualClose?: boolean;
  loading?: boolean;
  error?: string | null;
}

export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  message,
  confirmLabel = 'Confirm',
  danger = false,
  manualClose = false,
  loading = false,
  error = null,
}: ConfirmDialogProps) {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50" onClick={loading ? undefined : onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm p-6" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-lg font-semibold text-slate-900 mb-2">{title}</h3>
        <p className="text-sm text-slate-600 mb-4">{message}</p>
        {error && (
          <div className="flex items-start gap-2 text-sm text-red-700 bg-red-50 border border-red-100 rounded-lg px-3 py-2 mb-4">
            <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}
        <div className="flex gap-3 justify-end">
          <button
            onClick={onClose}
            disabled={loading}
            className="px-4 py-2 text-sm font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg transition disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Cancel
          </button>
          <button
            onClick={() => {
              onConfirm();
              if (!manualClose) onClose();
            }}
            disabled={loading}
            className={`flex items-center gap-2 px-4 py-2 text-sm font-medium text-white rounded-lg transition disabled:opacity-60 disabled:cursor-not-allowed ${
              danger ? 'bg-red-600 hover:bg-red-700' : 'bg-blue-600 hover:bg-blue-700'
            }`}
          >
            {loading && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            {loading ? 'Working...' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

export function StatusBadge({ status, label }: { status: string; label?: string }) {
  const colorClass =
    {
      pending: 'bg-slate-100 text-slate-700',
      assigned: 'bg-blue-100 text-blue-700',
      survey_started: 'bg-blue-100 text-blue-700',
      surveyed: 'bg-cyan-100 text-cyan-700',
      approval_pending: 'bg-amber-100 text-amber-700',
      approved: 'bg-green-100 text-green-700',
      design_pending: 'bg-fuchsia-100 text-fuchsia-700',
      designing: 'bg-fuchsia-100 text-fuchsia-700',
      design_ready: 'bg-fuchsia-100 text-fuchsia-700',
      designed: 'bg-emerald-100 text-emerald-700',
      in_review: 'bg-amber-100 text-amber-700',
      design_approved: 'bg-green-100 text-green-700',
      produced: 'bg-teal-100 text-teal-700',
      production_pending: 'bg-orange-100 text-orange-700',
      in_production: 'bg-orange-100 text-orange-700',
      production_ready: 'bg-orange-100 text-orange-700',
      production_hold: 'bg-red-100 text-red-700',
      hold: 'bg-red-100 text-red-700',
      production_done: 'bg-teal-100 text-teal-700',
      dispatched: 'bg-teal-100 text-teal-700',
      installation_pending: 'bg-indigo-100 text-indigo-700',
      installing: 'bg-indigo-100 text-indigo-700',
      installed: 'bg-emerald-100 text-emerald-700',
      billed: 'bg-green-100 text-green-700',
      cancelled: 'bg-red-100 text-red-700',
      draft: 'bg-slate-100 text-slate-700',
      submitted: 'bg-blue-100 text-blue-700',
      rejected: 'bg-red-100 text-red-700',
      correction_requested: 'bg-amber-100 text-amber-700',
      completed: 'bg-emerald-100 text-emerald-700',
      exception: 'bg-red-100 text-red-700',
      rescheduled: 'bg-amber-100 text-amber-700',
      started: 'bg-blue-100 text-blue-700',
      accepted: 'bg-blue-100 text-blue-700',
      declined: 'bg-red-100 text-red-700',
      unpaid: 'bg-red-100 text-red-700',
      partial: 'bg-amber-100 text-amber-700',
      paid: 'bg-emerald-100 text-emerald-700',
      overdue: 'bg-red-100 text-red-700',
      active: 'bg-green-100 text-green-700',
      closed: 'bg-slate-200 text-slate-700',
      on_hold: 'bg-amber-100 text-amber-700',
      uploaded: 'bg-blue-100 text-blue-700',
      ready_for_production: 'bg-green-100 text-green-700',
      planned: 'bg-slate-100 text-slate-700',
      visited: 'bg-emerald-100 text-emerald-700',
      skipped: 'bg-slate-100 text-slate-700',
    }[status] || 'bg-slate-100 text-slate-700';

  const text = label || status.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

  return (
    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${colorClass}`}>
      {text}
    </span>
  );
}

export function Card({ children, className = '', onClick }: { children: ReactNode; className?: string; onClick?: () => void }) {
  return (
    <div className={`bg-white rounded-xl shadow-sm border border-slate-200 ${className}`} onClick={onClick}>{children}</div>
  );
}

// Simple 0-100% bar for utilization/budget readouts (PO Utilization, Billing).
// Over 100% turns red since that means the line item's budget is exceeded.
export function ProgressBar({ pct, className = '' }: { pct: number | null; className?: string }) {
  const clamped = pct == null ? 0 : Math.max(0, Math.min(pct, 100));
  const over = (pct ?? 0) > 100;
  const barColor = over ? 'bg-red-500' : clamped >= 90 ? 'bg-amber-500' : 'bg-blue-600';
  return (
    <div className={`w-full h-1.5 rounded-full bg-slate-100 overflow-hidden ${className}`}>
      <div className={`h-full rounded-full ${barColor}`} style={{ width: `${clamped}%` }} />
    </div>
  );
}

export function Input({
  label,
  type = 'text',
  value,
  onChange,
  required,
  placeholder,
  step,
  min,
  addon,
}: {
  label: string;
  type?: string;
  value: string | number;
  onChange: (val: string) => void;
  required?: boolean;
  placeholder?: string;
  step?: string;
  min?: string;
  /** Optional element (e.g. a voice-input mic button) rendered to the
   *  right of the input, inside the same row as the field itself. Purely
   *  additive — every existing caller that doesn't pass this renders
   *  exactly as before. */
  addon?: ReactNode;
}) {
  return (
    <div>
      <label className="block text-sm font-medium text-slate-700 mb-1">
        {label} {required && <span className="text-red-500">*</span>}
      </label>
      <div className="flex items-center gap-2">
        <input
          type={type}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          required={required}
          placeholder={placeholder}
          step={step}
          min={min}
          className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none transition text-slate-900"
        />
        {addon}
      </div>
    </div>
  );
}

// Prefilled-but-free-text input — shows suggestions as you type (native
// datalist, so it works with normal keyboard/mouse behaviour everywhere)
// but never blocks typing a value that isn't in the list. Used for
// State/City fields across the app: pick from India's states/major
// cities when the value is in the list, or just type it when it isn't.
let comboboxIdCounter = 0;
export function Combobox({
  label,
  value,
  onChange,
  options,
  required,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (val: string) => void;
  options: string[];
  required?: boolean;
  placeholder?: string;
}) {
  const [listId] = useState(() => `combobox-${++comboboxIdCounter}`);
  return (
    <div>
      <label className="block text-sm font-medium text-slate-700 mb-1">
        {label} {required && <span className="text-red-500">*</span>}
      </label>
      <input
        list={listId}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        required={required}
        placeholder={placeholder || 'Type or pick from the list...'}
        className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none transition text-slate-900 bg-white"
      />
      <datalist id={listId}>
        {options.map((opt) => <option key={opt} value={opt} />)}
      </datalist>
    </div>
  );
}


export function Select({
  label,
  value,
  onChange,
  options,
  required,
}: {
  label: string;
  value: string;
  onChange: (val: string) => void;
  options: { value: string; label: string }[];
  required?: boolean;
}) {
  return (
    <div>
      <label className="block text-sm font-medium text-slate-700 mb-1">
        {label} {required && <span className="text-red-500">*</span>}
      </label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        required={required}
        className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none transition text-slate-900 bg-white"
      >
        <option value="">Select...</option>
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    </div>
  );
}

export function Textarea({
  label,
  value,
  onChange,
  required,
  placeholder,
  rows = 3,
  addon,
}: {
  label: string;
  value: string;
  onChange: (val: string) => void;
  required?: boolean;
  placeholder?: string;
  rows?: number;
  /** Optional element (e.g. a voice-dictation mic button), rendered
   *  floating in the top-right corner of the textarea. Purely additive —
   *  omitting it renders exactly as before. */
  addon?: ReactNode;
}) {
  return (
    <div>
      <label className="block text-sm font-medium text-slate-700 mb-1">
        {label} {required && <span className="text-red-500">*</span>}
      </label>
      <div className="relative">
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          required={required}
          placeholder={placeholder}
          rows={rows}
          className={`w-full px-3 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none transition text-slate-900 resize-none ${addon ? 'pr-11' : ''}`}
        />
        {addon && <div className="absolute top-2 right-2">{addon}</div>}
      </div>
    </div>
  );
}

export function EmptyState({ icon, title, subtitle }: { icon: ReactNode; title: string; subtitle?: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-12 text-center">
      <div className="text-slate-300 mb-3">{icon}</div>
      <h3 className="text-sm font-semibold text-slate-700">{title}</h3>
      {subtitle && <p className="text-sm text-slate-400 mt-1">{subtitle}</p>}
    </div>
  );
}

export function PageHeader({ title, subtitle, action }: { title: string; subtitle?: string; action?: ReactNode }) {
  return (
    <div className="flex items-center justify-between mb-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">{title}</h1>
        {subtitle && <p className="text-sm text-slate-500 mt-1">{subtitle}</p>}
      </div>
      {action && <div>{action}</div>}
    </div>
  );
}
