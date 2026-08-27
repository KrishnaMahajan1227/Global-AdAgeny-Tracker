import { LucideIcon } from 'lucide-react';
import { Card, PageHeader } from '@/components/ui';

interface Props {
  title: string;
  subtitle: string;
  phase: string;
  icon: LucideIcon;
  detail: string;
}

// Phase 3 ships Overview / Campaigns / PO Detail (see GLOBAL_ARCHITECTURE.md
// section 8 rollout plan). Map Feed (Phase 4), the full Billing screen
// (Phase 5) and Reports (Phase 6) get this placeholder for now instead of a
// broken nav link or a redirect loop — same idea as the old whole-portal
// stub, just scoped to one screen at a time as each phase ships around it.
export default function ClientComingSoonPage({ title, subtitle, phase, icon: Icon, detail }: Props) {
  return (
    <div>
      <PageHeader title={title} subtitle={subtitle} />
      <Card className="p-10">
        <div className="flex flex-col items-center text-center max-w-md mx-auto">
          <div className="w-14 h-14 rounded-full bg-blue-50 flex items-center justify-center mb-4">
            <Icon className="w-7 h-7 text-blue-500" />
          </div>
          <h3 className="text-base font-semibold text-slate-900 mb-1.5">{phase} — coming next</h3>
          <p className="text-sm text-slate-500 leading-relaxed">{detail}</p>
        </div>
      </Card>
    </div>
  );
}
