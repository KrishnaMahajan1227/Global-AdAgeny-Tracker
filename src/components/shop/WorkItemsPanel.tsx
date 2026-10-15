import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { MoreHorizontal, Ruler, Camera, Palette, Wrench, Pencil, Trash2, Plus, Ban, CheckCircle2, ListChecks, Package, AlertTriangle, Search } from 'lucide-react';
import { itemSizeLabel } from '@/lib/units';
import { EvidenceThumb, EvidenceViewer, FileTile, isImageUrl, type Slide, type Mark } from './EvidenceViewer';

type Props = {
  items: any[]; names: string[]; canEdit: boolean; hasPO: boolean;
  surveyPhotos: any[]; photoItemLinks: { survey_photo_id: string; work_item_id: string }[]; markings: any[];
  designTasks: any[]; installations: any[]; decisions: any[]; poLineItems: any[]; components: any[];
  onAddSurvey: (itemId: string | null) => void; onAddDesign: (itemId: string | null) => void; onAddInstall: (itemId: string | null) => void;
  onAddItem: () => void; onEdit: (item: any) => void; onDelete: (item: any) => void; onToggleAvailability: (item: any) => void;
  onDeleteSurveyPhoto: (photo: any) => void; onDeleteInstallProof: (proof: any) => void;
  onAssignLine: (itemId: string, lineId: string | null) => void;
  extra?: ReactNode;
};
type Filter = 'all' | 'pending' | 'installed' | 'redo' | 'unavailable';
const num = (v: any) => (v == null ? 0 : Number(v) || 0);
const r2 = (v: number) => Math.round(v * 100) / 100;

/** Small overflow menu — closes on outside click / Esc. Secondary actions only. */
function Menu({ children, label = 'More actions' }: { children: (close: () => void) => ReactNode; label?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', down); document.addEventListener('keydown', key);
    return () => { document.removeEventListener('mousedown', down); document.removeEventListener('keydown', key); };
  }, [open]);
  return (
    <div ref={ref} className="relative">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-label={label} aria-expanded={open} className={`inline-flex items-center gap-1.5 rounded-md border border-transparent px-2 py-1.5 text-xs font-medium text-slate-600 hover:border-slate-200 hover:bg-slate-50 hover:text-slate-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-600 ${label === 'More actions' ? 'px-1.5' : ''}`}><MoreHorizontal className="h-4 w-4" />{label === 'Add evidence' && label}</button>
      {open && <div className="absolute right-0 z-20 mt-1 w-56 rounded-lg border border-slate-200 bg-white py-1 shadow-lg">{children(() => setOpen(false))}</div>}
    </div>
  );
}
const MenuItem = ({ icon, label, onClick, danger }: { icon: ReactNode; label: string; onClick: () => void; danger?: boolean }) => (
  <button type="button" onClick={onClick} className={`flex w-full items-center gap-2.5 px-3 py-2 text-sm hover:bg-slate-50 ${danger ? 'text-red-600' : 'text-slate-700'}`}>{icon}{label}</button>
);

/** One stable preview per stage; the rest stay in a native, keyboard-operable disclosure.
 * This prevents a shop with 50 work items and hundreds of photos becoming an endless masonry wall.
 */
function EvidenceStage({ icon, title, count, onAdd, preview, remaining }: {
  icon: ReactNode; title: string; count: number; onAdd?: () => void; preview?: ReactNode; remaining?: ReactNode;
}) {
  return (
    <section aria-label={`${title} evidence`} className="min-w-0 rounded-lg border border-slate-200 bg-slate-50/40 p-2.5">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h4 className="flex min-w-0 items-center gap-1.5 text-xs font-semibold text-slate-700">
          {icon}<span>{title}</span><span className="font-normal tabular-nums text-slate-500">{count}</span>
        </h4>
        {onAdd && <button type="button" onClick={onAdd} aria-label={`Add ${title.toLowerCase()} evidence`} title={`Add ${title.toLowerCase()} evidence`} className="flex h-7 w-7 items-center justify-center rounded-md border border-slate-200 bg-white text-slate-600 hover:bg-slate-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-600"><Plus className="h-4 w-4" /></button>}
      </div>
      {count > 0 ? preview : (
        <div className="flex h-40 items-center justify-center rounded-lg border border-dashed border-slate-200 bg-white px-2 text-center text-xs text-slate-500">No {title.toLowerCase()} evidence</div>
      )}
      {count > 1 && <details className="mt-2 min-w-0">
        <summary className="w-fit cursor-pointer rounded-md px-1 py-1 text-xs font-medium text-blue-700 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-600">Show {count - 1} more <span aria-hidden="true">▾</span></summary>
        <div className="mt-2 grid max-h-[420px] grid-cols-1 gap-2 overflow-y-auto overscroll-contain" aria-label={`Additional ${title.toLowerCase()} evidence`}>{remaining}</div>
      </details>}
    </section>
  );
}

export function WorkItemsPanel(p: Props) {
  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');
  const [pageSize, setPageSize] = useState(10);
  const [page, setPage] = useState(1);
  const [viewer, setViewer] = useState<{ slides: Slide[]; index: number } | null>(null);

  const decisionFor = (stage: string, type: string, id: string) => p.decisions.find((d: any) => d.stage === stage && d.entity_type === type && d.entity_id === id);
  const isUnavailable = (it: any) => !!it.excluded_from_calculations;
  const isInstalled = (it: any) => !isUnavailable(it) && (it.status === 'installed' || (it.installed_width != null && it.installed_area != null));
  const hasRedo = (it: any) => ['measurement', 'work_item'].some((t) => ['survey', 'installation', 'design'].some((st) => decisionFor(st, t, it.id)?.decision === 'redo'));

  const stats = useMemo(() => {
    const active = p.items.filter((i) => !isUnavailable(i));
    const planned = active.reduce((t, i) => t + num(i.approved_area ?? i.survey_area), 0);
    const done = active.reduce((t, i) => t + num(i.installed_area), 0);
    return { total: p.items.length, active: active.length, installed: p.items.filter(isInstalled).length, unavailable: p.items.length - active.length,
      redo: p.items.filter(hasRedo).length, planned, done, pct: planned > 0 ? Math.min(100, Math.round((done / planned) * 100)) : 0 };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.items, p.decisions]);

  const filtered = p.items.filter((it, index) => {
    if (filter === 'installed' && !isInstalled(it)) return false;
    if (filter === 'unavailable' && !isUnavailable(it)) return false;
    if (filter === 'redo' && !hasRedo(it)) return false;
    if (filter === 'pending' && (isInstalled(it) || isUnavailable(it))) return false;
    const term = search.trim().toLowerCase();
    if (!term) return true;
    return [p.names[index], it.work_type_name, it.material, it.status,
      p.poLineItems.find((line: any) => line.id === it.po_line_item_id)?.description]
      .some(value => String(value || '').toLowerCase().includes(term));
  });
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(page, pageCount);
  const visibleItems = filtered.slice((safePage - 1) * pageSize, safePage * pageSize);
  useEffect(() => { setPage(1); }, [filter, search, pageSize]);

  const marksFor = (photoId: string, itemId: string): Mark[] =>
    p.markings.filter((m: any) => m.survey_photo_id === photoId && m.points?.length >= 3).map((m: any) => {
      const owner = p.items.find((i) => i.id === m.work_item_id);
      return { points: m.points, label: owner ? `${p.names[p.items.indexOf(owner)]} · ${itemSizeLabel(owner, 'survey')}` : 'Board', own: m.work_item_id === itemId };
    });

  function evidenceFor(item: any) {
    const only = p.items.length === 1;
    const linked = (id: string) => p.photoItemLinks.some((x) => x.survey_photo_id === id && x.work_item_id === item.id) || p.markings.some((m: any) => m.survey_photo_id === id && m.work_item_id === item.id);
    const anyLink = (id: string) => p.photoItemLinks.some((x) => x.survey_photo_id === id) || p.markings.some((m: any) => m.survey_photo_id === id && m.work_item_id);
    return {
      survey: p.surveyPhotos.filter((ph) => linked(ph.id) || (only && !anyLink(ph.id))),
      designs: p.designTasks.flatMap((d: any) => (d.design_versions || []).filter((v: any) => (v.design_version_items || []).some((x: any) => x.work_item_id === item.id) || (only && !(v.design_version_items || []).length))),
      install: p.installations.flatMap((j: any) => (j.installation_proofs || []).filter((pr: any) => pr.work_item_id === item.id || (only && !pr.work_item_id))),
    };
  }

  const seg = (k: Filter, label: string, n: number) => (
    <button key={k} type="button" aria-pressed={filter === k} onClick={() => setFilter(k)} className={`px-3 py-1.5 text-xs font-medium transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-600 first:rounded-l-lg last:rounded-r-lg border-y border-r first:border-l ${filter === k ? 'bg-slate-900 border-slate-900 text-white' : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50'}`}>
      {label} <span className={filter === k ? 'text-slate-300' : 'text-slate-400'}>{n}</span>
    </button>
  );

  return (
    <section className="min-w-0 rounded-xl border border-slate-200 bg-white">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-2 border-b border-slate-100 px-3 py-3 sm:px-4">
        <div>
          <h2 className="text-base font-semibold text-slate-900">Work Items <span className="font-normal text-slate-400">({stats.total})</span></h2>
          <p className="mt-1 text-sm text-slate-500">
            {stats.installed} of {stats.active} installed
            {stats.unavailable > 0 && <> · <span className="text-amber-700">{stats.unavailable} not available</span></>}
            {stats.planned > 0 && <> · {r2(stats.done)} / {r2(stats.planned)} sq.ft <span className="text-slate-400">({r2(Math.max(0, stats.planned - stats.done))} pending)</span></>}
          </p>
          {stats.planned > 0 && <div className="mt-2 h-1.5 w-64 max-w-full overflow-hidden rounded-full bg-slate-100"><div className="h-full rounded-full bg-slate-800" style={{ width: `${stats.pct}%` }} /></div>}
        </div>
        {p.canEdit && (
          <div className="flex flex-wrap items-center gap-2">
            <Menu label="Add evidence">{close => <>
              <MenuItem icon={<Camera className="h-4 w-4" />} label="Survey photos" onClick={() => { close(); p.onAddSurvey(null); }} />
              <MenuItem icon={<Palette className="h-4 w-4" />} label="Design files" onClick={() => { close(); p.onAddDesign(null); }} />
              <MenuItem icon={<Wrench className="h-4 w-4" />} label="Installation photos" onClick={() => { close(); p.onAddInstall(null); }} />
            </>}</Menu>
            <button type="button" onClick={p.onAddItem} className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-600"><Plus className="h-3.5 w-3.5" />Add item</button>
          </div>
        )}
      </div>

      {p.items.length > 1 && (
        <div className="flex max-w-full overflow-x-auto px-3 pt-3 sm:px-4">
          {seg('all', 'All', stats.total)}{seg('pending', 'Pending', p.items.filter((i) => !isInstalled(i) && !isUnavailable(i)).length)}{seg('installed', 'Installed', stats.installed)}
          {stats.redo > 0 && seg('redo', 'Redo', stats.redo)}{stats.unavailable > 0 && seg('unavailable', 'Not available', stats.unavailable)}
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2 px-3 pb-1 pt-3 sm:px-4">
        <label className="relative min-w-[170px] flex-1 sm:max-w-sm">
          <Search className="pointer-events-none absolute left-2.5 top-2 h-3.5 w-3.5 text-slate-400" />
          <span className="sr-only">Find work item</span>
          <input value={search} onChange={event => setSearch(event.target.value)} placeholder="Find work item or material" className="w-full rounded-md border border-slate-300 bg-white py-1.5 pl-8 pr-2 text-xs focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-600" />
        </label>
        <label className="flex items-center gap-2 text-xs text-slate-600">Show
          <select aria-label="Work items per page" value={pageSize} onChange={event => setPageSize(Number(event.target.value))} className="rounded-md border border-slate-300 bg-white px-2 py-1.5 text-xs focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-600">
            {[10, 25, 50].map(n => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
      </div>
      <div className="space-y-2.5 p-3 sm:p-4">
        {p.items.length === 0 && (
          <div className="rounded-xl border border-dashed border-slate-300 py-10 text-center">
            <Package className="mx-auto mb-2 h-7 w-7 text-slate-300" /><p className="text-sm font-medium text-slate-700">No work items yet</p>
            <p className="mt-1 text-xs text-slate-500">Survey se apne aap aayenge, ya "Add item" se jodiye.</p>
          </div>
        )}
        {p.items.length > 0 && filtered.length === 0 && <p className="py-6 text-center text-sm text-slate-500">No work items match. Try a different filter or search.</p>}

        {visibleItems.map((item) => {
          const idx = p.items.indexOf(item);
          const name = p.names[idx];
          const unavailable = isUnavailable(item);
          const installed = isInstalled(item);
          const redo = hasRedo(item);
          const ev = evidenceFor(item);
          const line = p.poLineItems.find((l: any) => l.id === item.po_line_item_id);
          const done: Record<string, boolean> = { survey: item.survey_width != null, approved: item.approved_width != null, produced: item.produced_quantity != null, installed };
          const dates: Record<string, string> = { produced: item.produced_at ? new Date(item.produced_at).toLocaleDateString('en-IN') : '', installed: item.installed_at ? new Date(item.installed_at).toLocaleDateString('en-IN') : '' };
          const comps = p.components.filter((c: any) => c.work_item_id === item.id);
          const ready = comps.filter((c: any) => c.status === 'ready').length;
          const sizeTxt = itemSizeLabel(item, item.approved_width != null ? 'approved' : 'survey');
          const area = item.approved_area ?? item.survey_area;
          const sDec = decisionFor('survey', 'measurement', item.id), iDec = decisionFor('installation', 'work_item', item.id);
          const statusText = unavailable ? 'Not installed' : installed ? 'Installed' : redo ? 'Redo pending' : String(item.status || '').replace(/_/g, ' ');
          const dot = unavailable || redo ? 'bg-amber-500' : installed ? 'bg-emerald-500' : 'bg-slate-400';

          const surveySlides: Slide[] = ev.survey.map((ph: any, i: number) => ({ src: ph.photo_url, kind: 'survey', title: `Survey ${i + 1}`, subtitle: `${name}${ph.caption ? ' · ' + ph.caption : ''}`, marks: marksFor(ph.id, item.id) }));
          const designSlides: Slide[] = ev.designs.filter((v: any) => isImageUrl(v.file_url)).map((v: any) => ({ src: v.file_url, kind: 'design', title: `Design v${v.version_number}`, subtitle: name }));
          const installSlides: Slide[] = ev.install.map((pr: any, i: number) => ({ src: pr.photo_url, kind: 'install', title: /^NOT INSTALLED/i.test(pr.caption || '') ? 'Site photo — not installed' : `Installation ${i + 1}`, subtitle: `${name}${pr.caption ? ' · ' + pr.caption : ''}${pr.captured_at ? ' · ' + new Date(pr.captured_at).toLocaleDateString('en-IN') : ''}` }));
          const open = (slides: Slide[], index: number) => setViewer({ slides, index });

          const renderSurvey = (ph: any, i: number) => { const d = decisionFor('survey', 'survey_photo', ph.id); return <EvidenceThumb key={ph.id} slide={surveySlides[i]} onOpen={() => open(surveySlides, i)} onDelete={p.canEdit ? () => p.onDeleteSurveyPhoto(ph) : undefined} badge={d ? (d.decision === 'approved' ? '✓' : 'REDO') : undefined} badgeTone={d?.decision === 'approved' ? 'ok' : 'redo'} />; };
          const renderDesign = (v: any) => { const si = designSlides.findIndex((s) => s.src === v.file_url); return isImageUrl(v.file_url) && si >= 0 ? <EvidenceThumb key={v.id} slide={designSlides[si]} onOpen={() => open(designSlides, si)} badge={`v${v.version_number}`} /> : <FileTile key={v.id} url={v.file_url} label={`v${v.version_number}`} tone="border-slate-200 text-slate-700" />; };
          const renderInstall = (pr: any, i: number) => { const d = decisionFor('installation', 'installation_photo', pr.id); return <EvidenceThumb key={pr.id} slide={installSlides[i]} onOpen={() => open(installSlides, i)} onDelete={p.canEdit ? () => p.onDeleteInstallProof(pr) : undefined} badge={/^NOT INSTALLED/i.test(pr.caption || '') ? 'N/A' : d ? (d.decision === 'approved' ? '✓' : 'REDO') : undefined} badgeTone={d?.decision === 'approved' ? 'ok' : 'redo'} />; };
          const totalEvidence = ev.survey.length + ev.designs.length + ev.install.length;

          return (
            <article key={item.id} className="rounded-xl border border-slate-200 bg-white">
              {/* Title row */}
              <div className="flex items-start gap-2 px-3 pt-3">
                <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-slate-100 text-xs font-semibold text-slate-600">{idx + 1}</span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <h3 className="break-words text-sm font-semibold text-slate-900">{name}</h3>
                    <span className="inline-flex items-center gap-1.5 text-xs font-medium capitalize text-slate-600"><span className={`h-2 w-2 rounded-full ${dot}`} />{statusText}</span>
                    {sDec && <span className="text-[11px] text-slate-500">Survey {sDec.decision === 'approved' ? '✓ approved' : '· redo'}</span>}
                    {iDec && <span className="text-[11px] text-slate-500">Install {iDec.decision === 'approved' ? '✓ approved' : '· redo'}</span>}
                  </div>
                  <p className="mt-1 flex flex-wrap items-center gap-x-2 text-xs text-slate-600">
                    <span className="inline-flex items-center gap-1 font-medium text-slate-900"><Ruler className="h-3.5 w-3.5 text-slate-400" />{sizeTxt}</span>
                    <span className="text-slate-300">•</span><span>Qty {item.approved_quantity ?? item.survey_quantity ?? 1}</span>
                    {area != null && <><span className="text-slate-300">•</span><span>{r2(num(area))} sq.ft</span></>}
                    {item.material && <><span className="text-slate-300">•</span><span>{item.material}</span></>}
                    {line && <><span className="text-slate-300">•</span><span className="max-w-[280px] truncate text-slate-500" title={line.description}>PO: {line.description}</span></>}
                  </p>
                </div>
                {p.canEdit && (
                  <Menu label={`Actions for ${name}`}>{(close) => (<>
                    <MenuItem icon={<Pencil className="h-4 w-4" />} label="Edit details" onClick={() => { close(); p.onEdit(item); }} />
                    <MenuItem icon={unavailable ? <CheckCircle2 className="h-4 w-4" /> : <Ban className="h-4 w-4" />} label={unavailable ? 'Make installable again' : 'Mark not available'} onClick={() => { close(); p.onToggleAvailability(item); }} />
                    <div className="my-1 border-t border-slate-100" />
                    <MenuItem danger icon={<Trash2 className="h-4 w-4" />} label="Delete item" onClick={() => { close(); if (window.confirm('Is work item aur uske links ko delete karein?')) p.onDelete(item); }} />
                  </>)}</Menu>
                )}
              </div>

              {unavailable && (
                <div className="mx-4 mt-3 flex items-start gap-2 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
                  <p><span className="font-medium">Not Installed:</span> {item.execution_reason || 'reason not given'}{item.execution_note ? ` — ${item.execution_note}` : ''}. <span className="text-amber-700">Installed qty / sq.ft / billing me excluded from totals.</span></p>
                </div>
              )}

              {/* One readable, identical-size image per stage. More stay inline, not in a modal. */}
              {totalEvidence > 0 ? <div className="mt-2 grid min-w-0 grid-cols-1 gap-2 border-t border-slate-100 p-2 sm:grid-cols-2 xl:grid-cols-3 sm:p-3">
                {ev.survey.length > 0 && <EvidenceStage icon={<Camera className="h-3.5 w-3.5" />} title="Survey" count={ev.survey.length} onAdd={p.canEdit ? () => p.onAddSurvey(item.id) : undefined}
                  preview={ev.survey[0] && renderSurvey(ev.survey[0], 0)} remaining={ev.survey.slice(1).map((ph: any, i: number) => renderSurvey(ph, i + 1))} />}
                {ev.designs.length > 0 && <EvidenceStage icon={<Palette className="h-3.5 w-3.5" />} title="Design" count={ev.designs.length} onAdd={p.canEdit ? () => p.onAddDesign(item.id) : undefined}
                  preview={ev.designs[0] && renderDesign(ev.designs[0])} remaining={ev.designs.slice(1).map(renderDesign)} />}
                {ev.install.length > 0 && <EvidenceStage icon={<Wrench className="h-3.5 w-3.5" />} title="Installation" count={ev.install.length} onAdd={p.canEdit ? () => p.onAddInstall(item.id) : undefined}
                  preview={ev.install[0] && renderInstall(ev.install[0], 0)} remaining={ev.install.slice(1).map((pr: any, i: number) => renderInstall(pr, i + 1))} />}
              </div> : <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-slate-100 px-3 py-2 text-xs text-slate-500">
                <Camera className="h-3.5 w-3.5" /> No evidence yet.
                {p.canEdit && <button type="button" onClick={() => p.onAddSurvey(item.id)} className="font-medium text-blue-700 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-600">Add survey photo</button>}
              </div>}

              {/* Footer — only when there is something to say */}
              {(item.approved_notes || item.survey_notes || item.po_variance_note || comps.length > 0 || (p.hasPO && p.canEdit)) && (
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 rounded-b-xl border-t border-slate-100 bg-slate-50/50 px-3 py-2 text-xs text-slate-600">
                  {(item.approved_notes || item.survey_notes) && <span><span className="font-medium text-slate-700">Note:</span> {item.approved_notes || item.survey_notes}</span>}
                  {item.po_variance_note && <span className="text-amber-700">PO variance: {item.po_variance_note}</span>}
                  {comps.length > 0 && <span className="inline-flex items-center gap-1"><ListChecks className="h-3.5 w-3.5" />BOM {ready}/{comps.length} ready</span>}
                  {p.hasPO && p.canEdit && (
                    <label className="ml-auto inline-flex items-center gap-2">PO line
                      <select value={item.po_line_item_id || ''} onChange={(e) => p.onAssignLine(item.id, e.target.value || null)} className="max-w-[260px] rounded-md border border-slate-300 bg-white px-2 py-1 text-xs outline-none focus:ring-2 focus:ring-slate-400">
                        <option value="">Unassigned</option>{p.poLineItems.map((l: any) => <option key={l.id} value={l.id}>{l.description} ({l.uom})</option>)}
                      </select>
                    </label>
                  )}
                </div>
              )}
            </article>
          );
        })}
        {p.extra}
      </div>
      {filtered.length > pageSize && <nav aria-label="Work item pages" className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 px-3 py-2 text-xs text-slate-600 sm:px-4">
        <span>{(safePage - 1) * pageSize + 1}–{Math.min(safePage * pageSize, filtered.length)} of {filtered.length} work items</span>
        <div className="flex gap-1.5">
          <button type="button" disabled={safePage === 1} onClick={() => setPage(p => Math.max(1, p - 1))} className="rounded-md border border-slate-300 px-2.5 py-1.5 disabled:opacity-40">Previous</button>
          <span className="px-2 py-1.5">{safePage} / {pageCount}</span>
          <button type="button" disabled={safePage >= pageCount} onClick={() => setPage(p => Math.min(pageCount, p + 1))} className="rounded-md border border-slate-300 px-2.5 py-1.5 disabled:opacity-40">Next</button>
        </div>
      </nav>}

      {viewer && <EvidenceViewer slides={viewer.slides} index={viewer.index} onIndex={(i) => setViewer((v) => (v ? { ...v, index: i } : v))} onClose={() => setViewer(null)} />}
    </section>
  );
}
