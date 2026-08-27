import { supabase } from './supabase';

export async function logAudit(
  tableName: string,
  recordId: string | null,
  action: string,
  fieldName: string | null,
  oldValue: string | null,
  newValue: string | null,
  description: string
) {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return;

  const { data: profile } = await supabase
    .from('profiles')
    .select('organization_id')
    .eq('id', user.id)
    .maybeSingle();

  if (!profile?.organization_id) return;

  await supabase.from('audit_logs').insert({
    organization_id: profile.organization_id,
    user_id: user.id,
    table_name: tableName,
    record_id: recordId,
    action,
    field_name: fieldName,
    old_value: oldValue,
    new_value: newValue,
    description,
  });
}

export async function createNotification(
  userId: string,
  title: string,
  message: string,
  type: string = 'info',
  link: string | null = null
) {
  const { data: profile } = await supabase
    .from('profiles')
    .select('organization_id')
    .eq('id', userId)
    .maybeSingle();

  if (!profile?.organization_id) return;

  await supabase.from('notifications').insert({
    organization_id: profile.organization_id,
    user_id: userId,
    title,
    message,
    type,
    link,
  });
}

// Cross-org counterpart to createNotification — used for the Client <->
// Agency handshake (Phase 2), e.g. telling a client org's users their PO
// was accepted/rejected. Plain notifications_insert RLS only allows
// writing inside your own org, so this goes through a SECURITY DEFINER
// RPC (migration 0038) that re-checks an active client_agency_links row
// exists between the caller's org and the target org before writing
// anything. Silently no-ops on failure — this is a courtesy notification,
// never something that should block the underlying action (e.g. accepting
// a PO) if it fails.
export async function notifyLinkedOrg(
  targetOrgId: string,
  title: string,
  message: string,
  type: string = 'info',
  link: string | null = null
) {
  try {
    await supabase.rpc('notify_linked_org_users', {
      p_target_org_id: targetOrgId,
      p_title: title,
      p_message: message,
      p_type: type,
      p_link: link,
    });
  } catch (err) {
    console.error('notifyLinkedOrg failed:', err);
  }
}

// Team Workload display helpers — shared between Owner Console's own
// Team Workload tab and the small read-only snapshot on the Live Field
// Map page (§9.2), so both render the exact same "who's loaded" logic
// instead of two copies drifting apart.
export function workloadLevel(assignedOpen: number): { label: string; dot: string; text: string } {
  if (assignedOpen >= 10) return { label: 'Heavy', dot: 'bg-red-500', text: 'text-red-600' };
  if (assignedOpen >= 5) return { label: 'Busy', dot: 'bg-amber-500', text: 'text-amber-600' };
  if (assignedOpen > 0) return { label: 'Light', dot: 'bg-green-500', text: 'text-green-600' };
  return { label: 'Free', dot: 'bg-slate-300', text: 'text-slate-400' };
}

export function initials(name: string | null | undefined): string {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] || '') + (parts[1]?.[0] || '')).toUpperCase() || name[0].toUpperCase();
}
