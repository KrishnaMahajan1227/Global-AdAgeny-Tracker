import type { PurchaseOrder } from '@/lib/types';
import type { StageRequirements } from '@/lib/workCompletion';
export type Order = { po_line_items?: StageRequirements[] } & Pick<PurchaseOrder, 'id' | 'client_id' | 'project_id' | 'campaign_id' | 'status' | 'assignment_status' | 'name' | 'po_number' | 'created_at'> & Partial<Pick<PurchaseOrder, 'fulfillment_type' | 'total_amount'>>;
export const percent = (done: number, total: number) => total > 0 ? Math.max(0, Math.min(100, Math.round(done * 100 / total))) : 0;
export const isDone = (o: Order) => o.status === 'closed' || o.assignment_status === 'completed';
export const orderState = (o: Order) => isDone(o) ? 'Done' : o.assignment_status === 'pending_acceptance' ? 'Review' : o.status === 'cancelled' || o.assignment_status === 'rejected' ? 'Cancelled' : o.assignment_status === 'in_progress' ? 'In Progress' : 'Pending';
export const isOverdue = (dueDate: string | null | undefined, done = false, now = new Date()) => !!dueDate && !done && new Date(`${dueDate}T23:59:59`).getTime() < now.getTime();
export const completion = (orders: Order[]) => percent(orders.filter(isDone).length, orders.length);
export const dateLabel = (d: string | null | undefined) => d ? new Date(`${d}T12:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : 'Not set';
