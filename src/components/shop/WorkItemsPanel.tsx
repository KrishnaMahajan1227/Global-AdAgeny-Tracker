import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { MoreHorizontal, Ruler, Camera, Palette, Wrench, Pencil, Trash2, Plus, Ban, CheckCircle2, ListChecks, Package, AlertTriangle, Check } from 'lucide-react';
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
const STEPS = [{ key: 'survey', label: 'Survey' }, { key: 'approved', label: 'Approved' }, { key: 'produced', label: 'Produced' }, { key: 'installed', label: 'Installed' }] as const;

/** Small overflow menu — closes on outside click / Esc. Secondary actions only. */
function Menu({ children }: { children: (close: () => void) => ReactNode }) {
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
      <button onClick={() => setOpen((o) => !o)} aria-label="More actions" className="rounded-md p-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-800"><MoreHorizontal className="h-5 w-5" /></button>
      {open && <div className="absolute right-0 z-20 mt-1 w-56 rounded-lg border border-slate-200 bg-white py-1 shadow-lg">{children(() => setOpen(false))}</div>}
    </div>
  );
}
const MenuItem = ({ icon, label, onClick, danger }: { icon: ReactNode; label: string; onClick: () => void; danger?: boolean }) => (
  <button onClick={onClick} className={`flex w-full items-center gap-2.5 px-3 py-2 text-sm hover:bg-slate-50 ${danger ? 'text-red-600' : 'text-slate-700'}`}>{icon}{label}</button>
);

export function WorkItemsPanel(p: Props) {
  const [filter, setFilter] = useState<Filter>('all');
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

  const filtered = p.items.filter((it) => {
    if (filter === 'installed') return isInstalled(it);
    if (filter === 'unavailable') return isUnavailable(it);
    if (filter === 'redo') return hasRedo(it);
    if (filter === 'pending') return !isInstalled(it) && !isUnavailable(it);
    return true;
  });

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
    <button key={k} onClick={() => setFilter(k)} className={`px-3 py-1.5 text-xs font-medium transition first:rounded-l-lg last:rounded-r-lg border-y border-r first:border-l ${filter === k ? 'bg-slate-900 border-slate-900 text-white' : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50'}`}>
      {label} <span className={filter === k ? 'text-slate-300' : 'text-slate-400'}>{n}</span>
    </button>
  );
  const ghost = 'inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50';

  return (
    <section className="rounded-2xl border border-slate-200 bg-white">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-100 px-5 py-4">
        <div>
          <h2 className="text-base font-semibold text-slate-900">Work Items <span className="font-normal text-slate-400">({stats.total})</span></h2>
          <p className="mt-1 text-sm text-slate-500">
            {stats.installed} of {stats.active} installed
            {stats.unavailable > 0 && <> · <span className="text-amber-700">{stats.unavailable} not available</span></>}
            {stats.planned > 0 && <> · {r2(stats.done)} / {r2(stats.planned)} sq.ft <span className="text-slate-400">({r2(Math.max(0, stats.planned - stats.done))} baaki)</span></>}
          </p>
          {stats.planned > 0 && <div className="mt-2 h-1.5 w-64 max-w-full overflow-hidden rounded-full bg-slate-100"><div className="h-full rounded-full bg-slate-800" style={{ width: `${stats.pct}%` }} /></div>}
        </div>
        {p.canEdit && (
          <div className="flex flex-wrap items-center gap-2">
            <button onClick={() => p.onAddSurvey(null)} className={ghost}><Camera className="h-3.5 w-3.5" />Survey photos</button>
            <button onClick={() => p.onAddDesign(null)} className={ghost}><Palette className="h-3.5 w-3.5" />Designs</button>
            <button onClick={() => p.onAddInstall(null)} className={ghost}><Wrench className="h-3.5 w-3.5" />Installation photos</button>
            <button onClick={p.onAddItem} className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-800"><Plus className="h-3.5 w-3.5" />Add item</button>
          </div>
        )}
      </div>

      {p.items.length > 1 && (
        <div className="flex px-5 pt-4">
          {seg('all', 'All', stats.total)}{seg('pending', 'Pending', p.items.filter((i) => !isInstalled(i) && !isUnavailable(i)).length)}{seg('installed', 'Installed', stats.installed)}
          {stats.redo > 0 && seg('redo', 'Redo', stats.redo)}{stats.unavailable > 0 && seg('unavailable', 'Not available', stats.unavailable)}
        </div>
      )}

      <div className="space-y-3 p-5">
        {p.items.length === 0 && (
          <div className="rounded-xl border border-dashed border-slate-300 py-10 text-center">
            <Package className="mx-auto mb-2 h-7 w-7 text-slate-300" /><p className="text-sm font-medium text-slate-700">Abhi koi work item nahi</p>
            <p className="mt-1 text-xs text-slate-500">Survey se apne aap aayenge, ya "Add item" se jodiye.</p>
          </div>
        )}
        {p.items.length > 0 && filtered.length === 0 && <p className="py-6 text-center text-sm text-slate-400">Is filter me koi item nahi.</p>}

        {filtered.map((item) => {
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

          const Group = ({ icon, title, count, onAdd, children }: { icon: ReactNode; title: string; count: number; onAdd?: () => void; children: ReactNode }) => (
            <div className="min-w-0 px-4 py-3 first:pl-0 last:pr-0">
              <div className="mb-2 flex items-center justify-between gap-2">
                <p className="flex items-center gap-1.5 text-xs font-medium text-slate-600">{icon}{title}<span className="text-slate-400">{count}</span></p>
                {onAdd && <button onClick={onAdd} title={`Add ${title.toLowerCase()}`} className="rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-800"><Plus className="h-4 w-4" /></button>}
              </div>
              <div className="flex min-h-[96px] items-center gap-2 overflow-x-auto pb-1">{children}</div>
            </div>
          );
          const empty = (t: string) => <p className="text-xs text-slate-400">{t}</p>;

          return (
            <article key={item.id} className="rounded-xl border border-slate-200 bg-white">
              {/* Title row */}
              <div className="flex items-start gap-3 px-4 pt-4">
                <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-slate-100 text-xs font-semibold text-slate-600">{idx + 1}</span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <h3 className="text-[15px] font-semibold text-slate-900 break-words">{name}</h3>
                    <span className="inline-flex items-center gap-1.5 text-xs font-medium capitalize text-slate-600"><span className={`h-2 w-2 rounded-full ${dot}`} />{statusText}</span>
                    {sDec && <span className="text-[11px] text-slate-500">Survey {sDec.decision === 'approved' ? '✓ approved' : '· redo'}</span>}
                    {iDec && <span className="text-[11px] text-slate-500">Install {iDec.decision === 'approved' ? '✓ approved' : '· redo'}</span>}
                  </div>
                  <p className="mt-1 flex flex-wrap items-center gap-x-2 text-sm text-slate-600">
                    <span className="inline-flex items-center gap-1 font-medium text-slate-900"><Ruler className="h-3.5 w-3.5 text-slate-400" />{sizeTxt}</span>
                    <span className="text-slate-300">•</span><span>Qty {item.approved_quantity ?? item.survey_quantity ?? 1}</span>
                    {area != null && <><span className="text-slate-300">•</span><span>{r2(num(area))} sq.ft</span></>}
                    {item.material && <><span className="text-slate-300">•</span><span>{item.material}</span></>}
                    {line && <><span className="text-slate-300">•</span><span className="max-w-[280px] truncate text-slate-500" title={line.description}>PO: {line.description}</span></>}
                  </p>
                </div>
                {p.canEdit && (
                  <Menu>{(close) => (<>
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
                  <p><span className="font-medium">Install nahi hua:</span> {item.execution_reason || 'reason not given'}{item.execution_note ? ` — ${item.execution_note}` : ''}. <span className="text-amber-700">Installed qty / sq.ft / billing me count nahi hoga.</span></p>
                </div>
              )}

              {/* Evidence — always visible, zero clicks */}
              <div className="mt-3 grid grid-cols-1 divide-y divide-slate-100 border-t border-slate-100 px-4 lg:grid-cols-3 lg:divide-x lg:divide-y-0">
                <Group icon={<Camera className="h-3.5 w-3.5" />} title="Survey" count={ev.survey.length} onAdd={p.canEdit ? () => p.onAddSurvey(item.id) : undefined}>
                  {ev.survey.length ? ev.survey.map((ph: any, i: number) => { const d = decisionFor('survey', 'survey_photo', ph.id); return <EvidenceThumb key={ph.id} slide={surveySlides[i]} onOpen={() => open(surveySlides, i)} onDelete={p.canEdit ? () => p.onDeleteSurveyPhoto(ph) : undefined} badge={d ? (d.decision === 'approved' ? '✓' : 'REDO') : undefined} badgeTone={d?.decision === 'approved' ? 'ok' : 'redo'} />; }) : empty('Photo nahi')}
                </Group>
                <Group icon={<Palette className="h-3.5 w-3.5" />} title="Design" count={ev.designs.length} onAdd={p.canEdit ? () => p.onAddDesign(item.id) : undefined}>
                  {ev.designs.length ? ev.designs.map((v: any) => { const si = designSlides.findIndex((s) => s.src === v.file_url); return isImageUrl(v.file_url) && si >= 0 ? <EvidenceThumb key={v.id} slide={designSlides[si]} onOpen={() => open(designSlides, si)} badge={`v${v.version_number}`} /> : <FileTile key={v.id} url={v.file_url} label={`v${v.version_number}`} tone="border-slate-200 text-slate-700" />; }) : empty('Design nahi')}
                </Group>
                <Group icon={<Wrench className="h-3.5 w-3.5" />} title="Installation" count={ev.install.length} onAdd={p.canEdit ? () => p.onAddInstall(item.id) : undefined}>
                  {ev.install.length ? ev.install.map((pr: any, i: number) => { const d = decisionFor('installation', 'installation_photo', pr.id); return <EvidenceThumb key={pr.id} slide={installSlides[i]} onOpen={() => open(installSlides, i)} onDelete={p.canEdit ? () => p.onDeleteInstallProof(pr) : undefined} badge={/^NOT INSTALLED/i.test(pr.caption || '') ? 'N/A' : d ? (d.decision === 'approved' ? '✓' : 'REDO') : undefined} badgeTone={d?.decision === 'approved' ? 'ok' : 'redo'} />; }) : empty('Photo nahi')}
                </Group>
              </div>

              {/* Footer — only when there is something to say */}
              {(item.approved_notes || item.survey_notes || item.po_variance_note || comps.length > 0 || (p.hasPO && p.canEdit)) && (
                <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-slate-100 bg-slate-50/50 px-4 py-2.5 text-xs text-slate-600 rounded-b-xl">
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

      {viewer && <EvidenceViewer slides={viewer.slides} index={viewer.index} onIndex={(i) => setViewer((v) => (v ? { ...v, index: i } : v))} onClose={() => setViewer(null)} />}
    </section>
  );
}
