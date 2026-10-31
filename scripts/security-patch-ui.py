from pathlib import Path
root=Path(__file__).resolve().parent.parent
p=root/'src/lib/auth.tsx';s=p.read_text()
s=s.replace("  signInWithPhone: (phone: string, password: string) => Promise<{ error: string | null }>;\n",'')
s=s.replace('''      if (mountedRef.current && revision === authRevisionRef.current && identityRef.current === userId) {
        setProfile(data as Profile | null);
      }''','''      if (mountedRef.current && revision === authRevisionRef.current && identityRef.current === userId) {
        if (!data || data.is_active !== true) {
          void queryClient.cancelQueries();
          queryClient.clear();
          setProfile(null);
        } else {
          setProfile(previous => {
            // Role/tenant changes invalidate everything fetched under older privileges.
            if (previous && (previous.role !== data.role || previous.organization_id !== data.organization_id)) {
              void queryClient.cancelQueries();
              queryClient.clear();
            }
            return data as Profile;
          });
        }
      }''')
start=s.index('  const signInWithPhone = async (')
end=s.index('  const signOut = async () => {',start)
s=s[:start]+s[end:]
s=s.replace('const { error } = await supabase.auth.signInWithPassword({ email, password });\n    if (error) return { error: error.message };\n    return { error: null };','''const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) return { error: 'Invalid email or password.' };
    // A valid Auth token alone does not imply authorization to this product.
    const { data: activeProfile, error: profileError } = await supabase.from('profiles')
      .select('id,is_active').eq('id', data.user.id).maybeSingle();
    if (profileError || !activeProfile || !activeProfile.is_active) {
      await supabase.auth.signOut();
      return { error: 'This account is not active. Contact your organization administrator.' };
    }
    return { error: null };''')
s=s.replace('''  const refreshProfile = async () => {
    if (session?.user) {
      await loadProfile(session.user.id, authRevisionRef.current);
    }
  };''','''  const refreshProfile = async () => {
    if (session?.user) await loadProfile(session.user.id, authRevisionRef.current);
  };

  useEffect(() => {
    // A removed user may still hold a valid JWT until it expires. Database RLS
    // blocks it immediately; the UI also checks periodically and on focus.
    const checkActiveSession = () => {
      if (identityRef.current) void loadProfile(identityRef.current, authRevisionRef.current);
    };
    const interval = window.setInterval(checkActiveSession, 60_000);
    window.addEventListener('focus', checkActiveSession);
    return () => { window.clearInterval(interval); window.removeEventListener('focus', checkActiveSession); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);''')
s=s.replace('session, profile, loading, signIn, signInWithPhone, signOut, refreshProfile','session, profile, loading, signIn, signOut, refreshProfile')
p.write_text(s)
p=root/'src/pages/LoginPage.tsx';s=p.read_text()
s=s.replace('Mail, MapPin, ShieldCheck, Smartphone','Mail, MapPin, ShieldCheck')
s=s.replace('const { signIn, signInWithPhone } = useAuth();','const { signIn } = useAuth();')
s=s.replace("  const [mode, setMode] = useState<'email' | 'phone'>('email');\n",'')
s=s.replace("  const [phone, setPhone] = useState('');\n",'')
s=s.replace('''      if (mode === 'email') {
        const { error } = await signIn(email, password);
        if (error) setError(error);
      } else {
        const { error } = await signInWithPhone(phone, password);
        if (error) setError(error);
      }''','''      const { error } = await signIn(email, password);
      if (error) setError(error);''')
start=s.index('          <div className="signin-mode"')
end=s.index('          <form onSubmit={handleSubmit}',start)
s=s[:start]+s[end:]
start=s.index("            {mode === 'email' ? (")
end=s.index('''            <label className="signin-field">\n              <span>Password</span>''',start)
s=s[:start]+'''            <label className="signin-field">
              <span>Work email</span>
              <div className="signin-input-wrap"><Mail size={17} /><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="username" placeholder="you@company.com" autoFocus /></div>
            </label>

'''+s[end:]
p.write_text(s)
p=root/'src/App.tsx';s=p.read_text().replace('if (!session || !profile) {','if (!session || !profile || !profile.is_active) {').replace('if (!profile) return <Navigate to="/login" replace />;','if (!profile || !profile.is_active) return <Navigate to="/login" replace />;').replace('  if (profile?.role === \'surveyor\') return <SurveyorPage />;',"  if (!profile?.is_active) return <Navigate to=\"/login\" replace />;\n  if (profile?.role === 'surveyor') return <SurveyorPage />;")
for route in ['/survey-review','/installation-review','/field-map']:
    # guards identical sidebar (isAdmin=owner/admin/demo?) inspect 'isAdmin' after
    page={'/survey-review':'SurveyReviewPage','/installation-review':'InstallationReviewPage','/field-map':'FieldMapPage'}[route]
    s=s.replace(f'<Route path="{route}" element={{<{page} />}} />',f'<Route path="{route}" element={{<ProtectedRoute allowedRoles={{[\'agency_owner\',\'admin\',\'demo\']}}><{page} /></ProtectedRoute>}} />')
p.write_text(s)
