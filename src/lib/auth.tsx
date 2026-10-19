import { createContext, useContext, useEffect, useRef, useState, ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Session } from '@supabase/supabase-js';
import { supabase } from './supabase';
import { Profile } from './types';

interface AuthContextValue {
  session: Session | null;
  profile: Profile | null;
  loading: boolean;
  signIn: (email: string, password: string) => Promise<{ error: string | null }>;
  signInWithPhone: (phone: string, password: string) => Promise<{ error: string | null }>;
  signOut: () => Promise<void>;
  refreshProfile: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const identityRef = useRef<string | null>(null);
  const authRevisionRef = useRef(0);
  const mountedRef = useRef(true);

  // Keep profile responses and React Query caches scoped to ONE signed-in user.
  // A stale profile request from account A must never overwrite account B's role.
  async function loadProfile(userId: string, revision: number) {
    try {
      const { data, error } = await supabase.from('profiles').select('*').eq('id', userId).maybeSingle();
      if (error) throw error;
      if (mountedRef.current && revision === authRevisionRef.current && identityRef.current === userId) {
        setProfile(data as Profile | null);
      }
    } catch (error) {
      console.error('Unable to load the active account profile:', error);
      if (mountedRef.current && revision === authRevisionRef.current) setProfile(null);
    } finally {
      if (mountedRef.current && revision === authRevisionRef.current) setLoading(false);
    }
  }

  function applySession(nextSession: Session | null) {
    if (!mountedRef.current) return;
    const nextUserId = nextSession?.user?.id ?? null;
    const identityChanged = identityRef.current !== nextUserId;
    if (identityChanged) {
      identityRef.current = nextUserId;
      authRevisionRef.current += 1;
      // Clear cached financial/client and field data immediately, before
      // the next account's routes become visible. Queries are keyed by org
      // on many screens but not every legacy hook; don't rely on those keys.
      void queryClient.cancelQueries();
      queryClient.clear();
      setProfile(null);
    }
    setSession(nextSession);
    if (!nextUserId) {
      setLoading(false);
      return;
    }
    if (identityChanged) {
      setLoading(true);
      void loadProfile(nextUserId, authRevisionRef.current);
    }
  }

  useEffect(() => {
    mountedRef.current = true;
    // Supabase emits INITIAL_SESSION; getSession is retained as a fallback.
    // A later getSession response cannot override a newer auth event.
    let observedAuthEvent = false;
    const { data: listener } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      observedAuthEvent = true;
      applySession(nextSession);
    });
    void supabase.auth.getSession().then(({ data: { session: initial } }) => {
      if (!observedAuthEvent) applySession(initial);
    }).catch(error => {
      console.error('Unable to restore sign-in state:', error);
      if (!observedAuthEvent && mountedRef.current) setLoading(false);
    });

    return () => {
      mountedRef.current = false;
      authRevisionRef.current += 1;
      listener.subscription.unsubscribe();
    };
    // The auth subscription is registered once per provider mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const signIn = async (email: string, password: string) => {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) return { error: error.message };
    return { error: null };
  };

  const signInWithPhone = async (phone: string, password: string) => {
    // Look up the email tied to this phone via a SECURITY DEFINER RPC —
    // the anon key alone cannot read auth.users or bypass RLS on profiles,
    // so this small server-side function does the lookup safely.
    const { data: email, error: lookupError } = await supabase.rpc('get_login_email_by_phone', {
      p_phone: phone,
    });

    if (lookupError || !email) {
      return { error: 'No account found with that phone number' };
    }

    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) return { error: error.message };
    return { error: null };
  };

  const signOut = async () => {
    const { error } = await supabase.auth.signOut();
    if (error) throw error;
    // Immediate isolation, even if auth event delivery is delayed.
    identityRef.current = null;
    authRevisionRef.current += 1;
    await queryClient.cancelQueries();
    queryClient.clear();
    setProfile(null);
    setSession(null);
    setLoading(false);
  };

  const refreshProfile = async () => {
    if (session?.user) {
      await loadProfile(session.user.id, authRevisionRef.current);
    }
  };

  return (
    <AuthContext.Provider value={{ session, profile, loading, signIn, signInWithPhone, signOut, refreshProfile }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
