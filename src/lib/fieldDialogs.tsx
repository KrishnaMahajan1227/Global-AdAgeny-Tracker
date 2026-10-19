import { useEffect, useRef, useState } from 'react';
import { useAuth } from './auth';
import { AlertCircle } from 'lucide-react';

type DialogRequest = { id: number; message: string; title?: string; danger?: boolean; confirm?: boolean; resolve: (value: boolean) => void };
let nextId = 0;
const listeners = new Set<(request: DialogRequest) => void>();

function dispatch(request: Omit<DialogRequest, 'id'>) {
  const full = { ...request, id: ++nextId };
  // No native localhost alert/confirm. The host is mounted in field role screens.
  if (!listeners.size) { request.resolve(false); return; }
  listeners.forEach((listener) => listener(full));
}

export function fieldNotice(message: string, title = 'Notice'): void {
  dispatch({ message, title, resolve: () => {} });
}
export function fieldConfirm(message: string, title = 'Confirm action'): Promise<boolean> {
  return new Promise((resolve) => dispatch({ message, title, confirm: true, danger: true, resolve }));
}

/** Mounted once per field role; accessible modal replaces browser-native dialogs. */
export function FieldDialogHost() {
  const { session } = useAuth();
  const activeUserId = session?.user.id ?? null;
  const [queue, setQueue] = useState<DialogRequest[]>([]);
  const pendingRef = useRef<DialogRequest[]>([]);
  // Resolve every outstanding confirm as false on logout/account switch.
  // The previous account's modal must not remain actionable as a new user.
  useEffect(() => {
    pendingRef.current.forEach(request => request.resolve(false));
    pendingRef.current = [];
    setQueue([]);
  }, [activeUserId]);
  useEffect(() => {
    const add = (request: DialogRequest) => {
      pendingRef.current.push(request);
      setQueue((previous) => [...previous, request]);
    };
    listeners.add(add);
    return () => {
      listeners.delete(add);
      pendingRef.current.forEach(request => request.resolve(false));
      pendingRef.current = [];
    };
  }, []);
  const current = queue[0];
  if (!current) return null;
  const finish = (accepted: boolean) => {
    pendingRef.current = pendingRef.current.filter(request => request.id !== current.id);
    current.resolve(accepted);
    setQueue((pending) => pending.filter(request => request.id !== current.id));
  };
  return (
    <div className="fixed inset-0 z-[150] flex items-center justify-center bg-slate-950/60 p-4" role="presentation">
      <div role="alertdialog" aria-modal="true" aria-labelledby="field-dialog-title" aria-describedby="field-dialog-body" className="w-full max-w-sm rounded-2xl bg-white p-5 shadow-2xl">
        <div className="mb-3 flex items-start gap-2">
          <AlertCircle className={`mt-0.5 h-5 w-5 shrink-0 ${current.danger ? 'text-rose-600' : 'text-blue-600'}`} />
          <h2 id="field-dialog-title" className="text-base font-semibold text-slate-900">{current.title}</h2>
        </div>
        <p id="field-dialog-body" className="whitespace-pre-wrap text-sm leading-6 text-slate-600">{current.message}</p>
        <div className="mt-5 flex justify-end gap-2">
          {current.confirm && <button type="button" autoFocus onClick={() => finish(false)} className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700">Keep current</button>}
          <button type="button" autoFocus={!current.confirm} onClick={() => finish(true)} className={`rounded-lg px-4 py-2 text-sm font-semibold text-white ${current.danger ? 'bg-rose-700' : 'bg-blue-700'}`}>{current.confirm ? 'Continue' : 'OK'}</button>
        </div>
      </div>
    </div>
  );
}
