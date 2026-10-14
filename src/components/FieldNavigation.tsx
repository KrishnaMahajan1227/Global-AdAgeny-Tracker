import { useState } from 'react';
import { Home, Briefcase, Map, Bell, User, Menu, X } from 'lucide-react';

type FieldTab = 'home' | 'work' | 'map' | 'notifications' | 'profile';
export function FieldNavigation({ tab, onChange, activeWork = false }: { tab: FieldTab; onChange: (tab: FieldTab) => void; activeWork?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const entries = [
    { id: 'home' as const, label: 'Home', icon: Home },
    { id: 'work' as const, label: 'My Work', icon: Briefcase },
    { id: 'map' as const, label: 'Map', icon: Map },
    { id: 'notifications' as const, label: 'Alerts', icon: Bell },
    { id: 'profile' as const, label: 'Profile', icon: User },
  ];
  const action = (id: FieldTab) => { onChange(id); setExpanded(false); };
  return <>
    {expanded && <button type="button" className="fixed inset-0 z-40 bg-slate-950/45" aria-label="Close navigation" onClick={() => setExpanded(false)} />}
    {expanded && <nav aria-label="Additional navigation" className="fixed bottom-[76px] left-3 right-3 max-w-md mx-auto z-50 rounded-2xl border border-slate-200 bg-white p-3 shadow-2xl grid grid-cols-3 gap-2">
      {entries.map(({ id, label, icon: Icon }) => <button key={id} type="button" onClick={() => action(id)} className={`flex flex-col items-center gap-1 rounded-xl p-3 text-xs font-semibold ${!activeWork && tab === id ? 'bg-blue-50 text-blue-700' : 'text-slate-600 hover:bg-slate-100'}`}><Icon className="h-5 w-5"/>{label}</button>)}
    </nav>}
    <nav aria-label="Field navigation" className="fixed bottom-0 left-0 right-0 max-w-md mx-auto z-50 flex items-center justify-around gap-1 border-t border-slate-200 bg-white/95 px-3 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] shadow-[0_-8px_24px_rgba(15,23,42,0.07)] backdrop-blur-xl">
      {entries.slice(0, 3).map(({ id, label, icon: Icon }) => <button key={id} type="button" onClick={() => action(id)} className={`flex min-w-0 flex-1 flex-col items-center gap-1 rounded-xl px-2 py-2 text-xs font-semibold transition-colors ${!activeWork && tab === id ? 'bg-blue-50 text-blue-700' : 'text-slate-500 hover:bg-slate-100'}`}><Icon className="w-5 h-5"/>{label}</button>)}
      <button type="button" aria-expanded={expanded} aria-label={expanded ? 'Close more navigation' : 'Open more navigation'} onClick={() => setExpanded(!expanded)} className={`flex min-w-0 flex-1 flex-col items-center gap-1 rounded-xl px-2 py-2 text-xs font-semibold ${expanded ? 'bg-blue-50 text-blue-700' : 'text-slate-500 hover:bg-slate-100'}`}>{expanded ? <X className="w-5 h-5"/> : <Menu className="w-5 h-5"/>}More</button>
    </nav>
  </>;
}
