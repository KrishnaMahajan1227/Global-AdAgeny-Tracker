import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { Card, PageHeader, Input } from '@/components/ui';
import { ROLE_LABELS } from '@/lib/types';
import { logAudit } from '@/lib/helpers';
import { User, Lock, Building2, CheckCircle2, AlertCircle, Loader2, Mail, Phone } from 'lucide-react';

// Every role except surveyor/installer lands here for their own account —
// those two already have a dedicated mobile "Profile" tab (ProfileView in
// SurveyorPage.tsx) built for a small touch screen, so this page is
// deliberately not reused there. Works the same for agency-side office
// roles (via AdminLayout's "/account") and Client Organization users
// (via ClientPortalPage's "/client/account") — the content is identical
// either way, just mounted under two different shells.
export default function AccountSettingsPage() {
  const { profile, session, refreshProfile } = useAuth();
  const queryClient = useQueryClient();
  const orgId = profile?.organization_id;

  const [fullName, setFullName] = useState(profile?.full_name || '');
  const [phone, setPhone] = useState(profile?.phone || '');
  const [profileNotice, setProfileNotice] = useState<{ kind: 'error' | 'success'; message: string } | null>(null);

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [pwNotice, setPwNotice] = useState<{ kind: 'error' | 'success'; message: string } | null>(null);

  const { data: org } = useQuery({
    queryKey: ['account-settings-org', orgId],
    queryFn: async () => {
      const { data } = await supabase.from('organizations').select('name').eq('id', orgId).maybeSingle();
      return data as { name: string } | null;
    },
    enabled: !!orgId,
  });

  const saveProfileMutation = useMutation({
    mutationFn: async () => {
      if (!profile) return;
      const { error } = await supabase.from('profiles').update({ full_name: fullName, phone: phone || null }).eq('id', profile.id);
      if (error) throw error;
      await logAudit('profiles', profile.id, 'update', null, null, null, 'Updated own account details');
    },
    onSuccess: async () => {
      setProfileNotice({ kind: 'success', message: 'Your details have been updated.' });
      await refreshProfile();
      queryClient.invalidateQueries({ queryKey: ['profiles'] });
    },
    onError: (err: Error) => setProfileNotice({ kind: 'error', message: err.message || 'Could not save your details.' }),
  });

  // Properly linked to the account it's changing: re-authenticates with
  // the CURRENT password first (via a real sign-in call, not just trusting
  // whatever's typed in) before calling Supabase's own updateUser — so a
  // wrong "current password" is actually caught instead of the field being
  // decorative, which is what the mobile ProfileView's simpler version does.
  const changePasswordMutation = useMutation({
    mutationFn: async () => {
      if (!session?.user?.email) throw new Error('No email on this account to verify against.');
      if (newPassword.length < 8) throw new Error('New password must be at least 8 characters.');
      if (newPassword !== confirmPassword) throw new Error("New password and confirmation don't match.");

      const { error: reauthError } = await supabase.auth.signInWithPassword({ email: session.user.email, password: currentPassword });
      if (reauthError) throw new Error('Current password is incorrect.');

      const { error } = await supabase.auth.updateUser({ password: newPassword });
      if (error) throw error;
      if (profile) await logAudit('profiles', profile.id, 'update', 'password', null, null, 'Changed own account password');
    },
    onSuccess: () => {
      setPwNotice({ kind: 'success', message: 'Password updated. Use it next time you sign in.' });
      setCurrentPassword(''); setNewPassword(''); setConfirmPassword('');
    },
    onError: (err: Error) => setPwNotice({ kind: 'error', message: err.message || 'Could not update your password.' }),
  });

  return (
    <div className="max-w-2xl mx-auto">
      <PageHeader title="My Account" subtitle="Your own login details — visible only to you" />

      <Card className="p-5 mb-5">
        <div className="flex items-center gap-3 mb-5">
          <div className="w-12 h-12 rounded-full bg-blue-100 flex items-center justify-center text-blue-600 font-bold text-lg shrink-0">
            {profile?.full_name?.charAt(0) || '?'}
          </div>
          <div className="min-w-0">
            <p className="font-semibold text-slate-900 truncate">{profile?.full_name}</p>
            <p className="text-sm text-slate-500">{profile ? (ROLE_LABELS[profile.role] || profile.role) : ''}</p>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3 mb-5 text-sm">
          <div className="flex items-center gap-2 text-slate-500">
            <Mail className="w-4 h-4 shrink-0" /> {session?.user?.email || 'No email on file'}
          </div>
          {org && (
            <div className="flex items-center gap-2 text-slate-500">
              <Building2 className="w-4 h-4 shrink-0" /> {org.name}
            </div>
          )}
        </div>

        <div className="space-y-3 border-t border-slate-100 pt-4">
          <p className="text-sm font-medium text-slate-700 flex items-center gap-1.5"><User className="w-4 h-4 text-slate-400" /> Your Details</p>
          <Input label="Full Name" value={fullName} onChange={setFullName} required />
          <Input label="Phone" value={phone} onChange={setPhone} placeholder="+91 90000 00000" />
          {profileNotice && (
            <div className={`flex items-start gap-2 rounded-lg px-3 py-2 text-sm ${profileNotice.kind === 'error' ? 'bg-red-50 text-red-700' : 'bg-emerald-50 text-emerald-700'}`}>
              {profileNotice.kind === 'error' ? <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" /> : <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0" />}
              <p>{profileNotice.message}</p>
            </div>
          )}
          <button
            onClick={() => { setProfileNotice(null); saveProfileMutation.mutate(); }}
            disabled={saveProfileMutation.isPending || !fullName.trim()}
            className="flex items-center justify-center gap-2 bg-blue-600 hover:bg-blue-700 text-white font-medium px-4 py-2 rounded-lg text-sm transition disabled:opacity-50"
          >
            {saveProfileMutation.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
            Save Details
          </button>
        </div>
      </Card>

      <Card className="p-5">
        <p className="text-sm font-medium text-slate-700 flex items-center gap-1.5 mb-4"><Lock className="w-4 h-4 text-slate-400" /> Reset Password</p>
        <div className="space-y-3">
          <Input label="Current Password" type="password" value={currentPassword} onChange={setCurrentPassword} required />
          <div className="grid grid-cols-2 gap-3">
            <Input label="New Password" type="password" value={newPassword} onChange={setNewPassword} required />
            <Input label="Confirm New Password" type="password" value={confirmPassword} onChange={setConfirmPassword} required />
          </div>
          <p className="text-xs text-slate-400 flex items-center gap-1"><Phone className="w-3 h-3" /> At least 8 characters. You'll stay signed in on this device after changing it.</p>
          {pwNotice && (
            <div className={`flex items-start gap-2 rounded-lg px-3 py-2 text-sm ${pwNotice.kind === 'error' ? 'bg-red-50 text-red-700' : 'bg-emerald-50 text-emerald-700'}`}>
              {pwNotice.kind === 'error' ? <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" /> : <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0" />}
              <p>{pwNotice.message}</p>
            </div>
          )}
          <button
            onClick={() => { setPwNotice(null); changePasswordMutation.mutate(); }}
            disabled={changePasswordMutation.isPending || !currentPassword || !newPassword || !confirmPassword}
            className="flex items-center justify-center gap-2 bg-slate-900 hover:bg-slate-800 text-white font-medium px-4 py-2 rounded-lg text-sm transition disabled:opacity-50"
          >
            {changePasswordMutation.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
            Update Password
          </button>
        </div>
      </Card>
    </div>
  );
}
