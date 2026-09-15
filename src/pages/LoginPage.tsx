import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '@/lib/auth';
import { ArrowLeft, ArrowRight, Check, Eye, EyeOff, Loader2, Mail, MapPin, ShieldCheck, Smartphone } from 'lucide-react';
import './login.css';

function AdRouteMark() {
  return (
    <span className="signin-brand-mark" aria-label="AdRoute">
      <span className="signin-brand-symbol" aria-hidden="true"><i /><i /><i /></span>
      <strong>AdRoute</strong>
    </span>
  );
}

export default function LoginPage() {
  const { signIn, signInWithPhone } = useAuth();
  const [mode, setMode] = useState<'email' | 'phone'>('email');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const oldTitle = document.title;
    document.title = 'Sign in | AdRoute';
    return () => { document.title = oldTitle; };
  }, []);

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

  return (
    <main className="signin-page">
      <section className="signin-visual" aria-label="AdRoute connected operations">
        <img src="/landing/cinematic/10_AdRoute_Connected_Operations_Final_CTA.png" alt="" className="signin-visual-image" />
        <div className="signin-visual-vignette" />
        <div className="signin-visual-grain" />

        <Link to="/" className="signin-logo"><AdRouteMark /></Link>

        <div className="signin-story">
          <p className="signin-eyebrow"><span /> FIELD OPERATIONS · CONNECTED END TO END</p>
          <h1>One operation.<br /><em>Every site connected.</em></h1>
          <p className="signin-story-copy">From field survey to verified installation, client visibility and billing readiness — your entire outdoor branding operation stays connected.</p>

          <div className="signin-flow" aria-label="AdRoute workflow">
            <span>Survey</span><i />
            <span>Produce</span><i />
            <span>Install</span><i />
            <span>Verify</span>
          </div>
        </div>

        <div className="signin-proof-card signin-proof-card--field">
          <span className="signin-proof-icon"><MapPin size={14} /></span>
          <span><small>FIELD SITE</small><b>Proof captured</b></span>
          <Check size={14} />
        </div>
        <div className="signin-proof-card signin-proof-card--ops">
          <span className="signin-proof-icon"><ShieldCheck size={14} /></span>
          <span><small>AGENCY OPS</small><b>Installation verified</b></span>
          <Check size={14} />
        </div>

        <p className="signin-visual-foot">Survey → Creative → Production → Installation → Proof → Client</p>
      </section>

      <section className="signin-panel">
        <div className="signin-panel-inner">
          <div className="signin-mobile-head">
            <Link to="/" aria-label="Back to AdRoute"><AdRouteMark /></Link>
          </div>

          <Link to="/" className="signin-back"><ArrowLeft size={15} /> Back to AdRoute</Link>

          <div className="signin-heading">
            <p className="signin-kicker">SECURE WORKSPACE ACCESS</p>
            <h2>Welcome back.</h2>
            <p>Sign in to continue to your AdRoute workspace. Your role automatically opens the right experience.</p>
          </div>

          <div className="signin-mode" role="tablist" aria-label="Sign in method">
            <button type="button" role="tab" aria-selected={mode === 'email'} className={mode === 'email' ? 'active' : ''} onClick={() => { setMode('email'); setError(null); }}>
              <Mail size={16} /> Email
            </button>
            <button type="button" role="tab" aria-selected={mode === 'phone'} className={mode === 'phone' ? 'active' : ''} onClick={() => { setMode('phone'); setError(null); }}>
              <Smartphone size={16} /> Phone
            </button>
          </div>

          <form onSubmit={handleSubmit} className="signin-form">
            {mode === 'email' ? (
              <label className="signin-field">
                <span>Work email</span>
                <div className="signin-input-wrap"><Mail size={17} /><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="username" placeholder="you@company.com" autoFocus /></div>
              </label>
            ) : (
              <label className="signin-field">
                <span>Phone number</span>
                <div className="signin-input-wrap"><Smartphone size={17} /><input type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} required autoComplete="tel" placeholder="+91 90000 00001" autoFocus /></div>
              </label>
            )}

            <label className="signin-field">
              <span>Password</span>
              <div className="signin-input-wrap signin-password">
                <ShieldCheck size={17} />
                <input type={showPassword ? 'text' : 'password'} value={password} onChange={(e) => setPassword(e.target.value)} required autoComplete="current-password" placeholder="Enter your password" />
                <button type="button" onClick={() => setShowPassword((value) => !value)} aria-label={showPassword ? 'Hide password' : 'Show password'}>
                  {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                </button>
              </div>
            </label>

            {error && <div className="signin-error" role="alert">{error}</div>}

            <button type="submit" disabled={loading} className="signin-submit">
              <span>{loading ? 'Signing in…' : 'Sign in to AdRoute'}</span>
              {loading ? <Loader2 size={18} className="signin-spin" /> : <ArrowRight size={18} />}
            </button>
          </form>

          <div className="signin-trust"><ShieldCheck size={15} /><span>Secure role-based access</span><i /><span>Agency & client workspaces</span></div>
          <p className="signin-help">Need access? Contact the AdRoute administrator at your organization.</p>
        </div>
        <footer className="signin-panel-foot"><span>© {new Date().getFullYear()} AdRoute</span><span>Connected field operations</span></footer>
      </section>
    </main>
  );
}
