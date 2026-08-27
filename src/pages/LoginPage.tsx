import { useState } from 'react';
import { useAuth } from '@/lib/auth';
import { Building2, Eye, EyeOff, Smartphone, Mail, Users2, Loader2 } from 'lucide-react';

// Single, unified sign-in screen for the whole platform — agency staff,
// field workers, and Client Organization users all sign in exactly the
// same way, right here, with the same email/phone + password form. There
// is no separate "I'm an Agency" / "I'm a Client" path to choose on this
// screen; which dashboard opens afterwards is decided entirely by the
// signed-in account's role, in App.tsx's homeRouteForRole() — a
// client_admin/client_viewer lands on /client (ClientPortalPage), a
// surveyor/installer lands on /mobile, and every office role lands on the
// agency console (AdminLayout). This page only ever needs to know how to
// authenticate someone, never which "side" they're on.
export default function LoginPage() {
  const { signIn, signInWithPhone } = useAuth();
  const [mode, setMode] = useState<'email' | 'phone'>('email');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [demoLoading, setDemoLoading] = useState<'agency' | 'client' | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      if (mode === 'email') {
        const { error } = await signIn(email, password);
        if (error) setError(error);
      } else {
        const { error } = await signInWithPhone(phone, password);
        if (error) setError(error);
      }
    } finally {
      setLoading(false);
    }
  }

  async function tryDemo(which: 'agency' | 'client') {
    setError(null);
    setDemoLoading(which);
    try {
      const { error } =
        which === 'agency'
          ? await signIn('demo@darshanadagency.com', 'Demo@2026')
          : await signIn('client-demo@darshanadagency.com', 'ClientDemo@2026');
      if (error) setError(error);
    } finally {
      setDemoLoading(null);
    }
  }

  const busy = loading || !!demoLoading;

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-slate-900 via-slate-800 to-blue-900 px-4 py-10">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-16 h-16 bg-blue-600 rounded-2xl mb-4 shadow-lg">
            <Building2 className="w-8 h-8 text-white" />
          </div>
          <h1 className="text-2xl font-bold text-white">Darshan Ad Agency</h1>
          <p className="text-slate-400 mt-1">One platform for agencies and their clients</p>
        </div>

        <div className="bg-white rounded-2xl shadow-xl p-8">
          <div className="flex gap-2 mb-6 bg-slate-100 p-1 rounded-lg">
            <button
              type="button"
              onClick={() => setMode('email')}
              className={`flex-1 flex items-center justify-center gap-2 py-2 px-4 rounded-md text-sm font-medium transition ${
                mode === 'email' ? 'bg-white shadow text-slate-900' : 'text-slate-500'
              }`}
            >
              <Mail className="w-4 h-4" /> Email
            </button>
            <button
              type="button"
              onClick={() => setMode('phone')}
              className={`flex-1 flex items-center justify-center gap-2 py-2 px-4 rounded-md text-sm font-medium transition ${
                mode === 'phone' ? 'bg-white shadow text-slate-900' : 'text-slate-500'
              }`}
            >
              <Smartphone className="w-4 h-4" /> Phone
            </button>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            {mode === 'email' ? (
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Email</label>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  autoComplete="username"
                  className="w-full px-4 py-2.5 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none transition"
                  placeholder="you@company.com"
                />
              </div>
            ) : (
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Phone Number</label>
                <input
                  type="tel"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  required
                  autoComplete="tel"
                  className="w-full px-4 py-2.5 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none transition"
                  placeholder="+91 90000 00001"
                />
              </div>
            )}

            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Password</label>
              <div className="relative">
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  autoComplete="current-password"
                  className="w-full px-4 py-2.5 pr-11 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none transition"
                  placeholder="Enter password"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
                  tabIndex={-1}
                >
                  {showPassword ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
                </button>
              </div>
            </div>

            {error && (
              <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg px-4 py-2.5">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={busy}
              className="w-full flex items-center justify-center gap-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white font-semibold py-2.5 rounded-lg transition"
            >
              {loading && <Loader2 className="w-4 h-4 animate-spin" />}
              {loading ? 'Signing in...' : 'Sign In'}
            </button>
          </form>

          <p className="text-xs text-slate-400 text-center mt-4">
            Agency team member or a linked client — sign in above with the account your agency set up for you.
          </p>

          <div className="mt-5 pt-5 border-t border-slate-200">
            <p className="text-xs font-medium text-slate-500 text-center mb-3">New here? Explore a live demo</p>
            <div className="grid grid-cols-2 gap-3">
              <button
                onClick={() => tryDemo('agency')}
                disabled={busy}
                className="flex items-center justify-center gap-1.5 bg-emerald-50 hover:bg-emerald-100 border border-emerald-200 text-emerald-700 font-medium py-2.5 rounded-lg transition disabled:opacity-50 text-sm"
              >
                {demoLoading === 'agency' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Building2 className="w-4 h-4" />}
                Agency Demo
              </button>
              <button
                onClick={() => tryDemo('client')}
                disabled={busy}
                className="flex items-center justify-center gap-1.5 bg-blue-50 hover:bg-blue-100 border border-blue-200 text-blue-700 font-medium py-2.5 rounded-lg transition disabled:opacity-50 text-sm"
              >
                {demoLoading === 'client' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Users2 className="w-4 h-4" />}
                Client Demo
              </button>
            </div>
            <p className="text-xs text-slate-400 text-center mt-2">
              Read-only demo workspaces — see the full survey-to-billing pipeline as an agency, or a campaign's live progress as a client.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
