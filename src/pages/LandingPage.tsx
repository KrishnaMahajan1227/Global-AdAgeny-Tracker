import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Building2, MapPin, Camera, ShieldCheck, Palette, Printer, Wrench,
  IndianRupee, FileCheck, Users2, Route as RouteIcon, BarChart3,
  Smartphone, Lock, CheckCircle2, ArrowRight, Menu, X, ChevronDown,
  Radar, ClipboardList, Building, UserCircle2, Truck,
} from 'lucide-react';

// ---------------------------------------------------------------------------
// Public marketing page — the only route in this app that renders with no
// session at all. Deliberately kept visually distinct from the in-app
// console (slate/blue) with its own night-survey navy + hazard-amber brand.
// this page's job is to sell the product to someone who has never logged
// in, so it borrows its visual language from the physical world this
// platform runs on — city maps, GPS pins, site-survey measurement — rather
// than generic dashboard chrome. App.tsx renders this at "/" only when
// there is no active session; a signed-in visitor is redirected straight
// to their own home route and never sees this page.
//
// IMPORTANT — deliberately self-contained: every brand color below is
// written as a Tailwind arbitrary value (e.g. `bg-[#0B1220]`) instead of a
// custom tailwind.config.js token, and the display/body fonts are loaded
// and applied from inside this component rather than from index.html.
// That's on purpose — this file needs to render correctly on its own even
// if a deploy pipeline only picks up changes under src/ and skips root
// config files like tailwind.config.js or index.html.
// ---------------------------------------------------------------------------

const FONT_LINK_ID = 'darshan-landing-fonts';
const ANTON: React.CSSProperties = { fontFamily: "'Anton', 'Arial Narrow', sans-serif" };

function useLandingFonts() {
  useEffect(() => {
    if (document.getElementById(FONT_LINK_ID)) return;
    const link = document.createElement('link');
    link.id = FONT_LINK_ID;
    link.rel = 'stylesheet';
    link.href = 'https://fonts.googleapis.com/css2?family=Anton&family=Inter:wght@400;500;600;700;800&family=IBM+Plex+Mono:wght@400;500;600&display=swap';
    document.head.appendChild(link);
  }, []);
}

function useReveal<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { threshold: 0.15 }
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return { ref, visible };
}

function Reveal({ children, delay = 0, className = '' }: { children: React.ReactNode; delay?: number; className?: string }) {
  const { ref, visible } = useReveal<HTMLDivElement>();
  return (
    <div
      ref={ref}
      className={`transition-all duration-700 ease-out ${visible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-6'} ${className}`}
      style={{ transitionDelay: `${delay}ms` }}
    >
      {children}
    </div>
  );
}

const WORKFLOW = [
  {
    stage: 'Survey',
    role: 'Surveyor',
    icon: MapPin,
    detail: 'Field team measures the site on their phone, drops a GPS pin and photographs the board — offline-first, so a dead zone never blocks a survey.',
    gate: 'Admin/Owner approves, rejects or asks for a correction before anything moves forward.',
  },
  {
    stage: 'Design',
    role: 'Designer',
    icon: Palette,
    detail: 'Approved surveys land in the design queue with the exact board dimensions attached — no measuring twice, no back-and-forth on WhatsApp.',
    gate: 'A design only reaches Production after Admin/Owner marks it approved.',
  },
  {
    stage: 'Production',
    role: 'Printing',
    icon: Printer,
    detail: 'Approved designs become production orders with quantity tracked per board, so re-prints and part-orders never double-count.',
    gate: 'Marked complete by the production team, then confirmed by Admin/Owner.',
  },
  {
    stage: 'Installation',
    role: 'Installer',
    icon: Wrench,
    detail: 'Installer submits front + side photos with GPS-plausibility and duplicate-photo checks running automatically in the background.',
    gate: 'Only an approved installation flips a site to "Installed" — anywhere in the app.',
  },
  {
    stage: 'Billing',
    role: 'Accounts',
    icon: IndianRupee,
    detail: 'Only sites that have actually cleared installation review become eligible for an invoice — billing can never run ahead of ground reality.',
    gate: 'Every stage above is enforced by a database trigger, not a UI convention.',
  },
];

const AGENCY_FEATURES = [
  { icon: Radar, title: 'Live Field Map', text: 'Every surveyor and installer shows up on one map in real time — plan routes around where your teams already are, not where you guess they are.' },
  { icon: ClipboardList, title: 'Client Requests Inbox', text: 'When a client-side organisation raises a PO on the platform, it lands here to accept or reject — never silently auto-assigned to your crew.' },
  { icon: Users2, title: 'Role-Scoped Access', text: 'Surveyors see surveys, designers see the design queue, accounts see money — Owner Console controls exactly who sees what, down to a single client.' },
  { icon: RouteIcon, title: 'Route Planning', text: 'Turn today\u2019s open jobs into an actual driving route, so a field day is planned in minutes instead of guessed at over a phone call.' },
  { icon: BarChart3, title: 'Reports & Exports', text: 'Campaign performance, photo compliance and burndown charts — exportable to Excel and PDF for the client meeting you didn\u2019t have time to prep for.' },
  { icon: Truck, title: 'Supply-Only Orders', text: 'Not every job needs a full install — track material-only dispatches through their own destinations table, separate from the site pipeline.' },
];

const CLIENT_FEATURES = [
  { icon: Building, title: 'Multi-Agency View', text: 'Working with three agencies across five cities? See every campaign, from every agency, in one dashboard — ranked by who\u2019s actually delivering.' },
  { icon: MapPin, title: 'Live Map Feed', text: 'Every site your campaigns touch, pinned and colour-coded by stage, with before/after photos one tap away — no more asking "is it up yet?"' },
  { icon: Camera, title: 'Marked Survey Photos', text: 'See the exact board outline the surveyor measured, not just a raw photo — the same marking data your agency\u2019s design team works from.' },
  { icon: Lock, title: 'Zero Billing Leakage', text: 'The client portal is built to never surface agency-side cost, margin or vendor rate data — by design, not by a setting someone can toggle off.' },
];

const PERSONAS = [
  { icon: Building2, role: 'Agency Owner', text: 'One console for every job in flight, every crew on the map, and every rupee waiting to be billed.' },
  { icon: UserCircle2, role: 'Surveyor & Installer', text: 'A phone-first app that works with patchy signal and never asks the same question twice.' },
  { icon: Palette, role: 'Designer & Production', text: 'A queue with exact board specs attached — no scrolling through a chat thread to find the brief.' },
  { icon: ShieldCheck, role: 'Client Admin', text: 'Full visibility into your own campaigns, across every agency you work with, with no pricing noise.' },
];

const FAQS = [
  {
    q: 'Do agencies and their clients use separate logins?',
    a: 'One sign-in screen for everyone — the account\u2019s role decides which dashboard opens next. Agency staff and field crews land on the operations console; a Client Organisation account lands on its own portal automatically.',
  },
  {
    q: 'What happens without a signal at a survey site?',
    a: 'The mobile survey and installation flows are PWA-based and offline-first. A surveyor can measure, photograph and save a site with zero bars, and it syncs the moment a connection is back.',
  },
  {
    q: 'Can a client see agency pricing or margins?',
    a: 'No. The Client Organisation portal is built to never carry cost, margin or vendor-rate data — clients see status, photos, timelines and their own invoices, nothing an agency wouldn\u2019t want shared.',
  },
  {
    q: 'Can one client work with more than one agency?',
    a: 'Yes — a Client Organisation can link to several agencies at once and see every one of them ranked side by side on its own dashboard, without any agency seeing another agency\u2019s work.',
  },
  {
    q: 'Is the five-stage approval actually enforced, or just a UI flow?',
    a: 'Enforced in the database. Survey \u2192 Design \u2192 Production \u2192 Installation \u2192 Billing gates are backed by triggers, so a stage can\u2019t be skipped by a direct API call or the wrong role \u2014 not just hidden behind a disabled button.',
  },
  {
    q: 'How long does onboarding take?',
    a: 'Most agencies are running their first live survey within a day \u2014 request a walkthrough below and we\u2019ll set up your organisation, roles and first client together.',
  },
];

export default function LandingPage() {
  const [navOpen, setNavOpen] = useState(false);
  const [openFaq, setOpenFaq] = useState<number | null>(0);
  const currentYear = new Date().getFullYear();

  useLandingFonts();

  useEffect(() => {
    document.title = 'Darshan Ops — OOH Advertising Operations Platform | Survey to Billing, One System';
  }, []);

  const navLinks = [
    { href: '#workflow', label: 'How it works' },
    { href: '#agencies', label: 'For agencies' },
    { href: '#clients', label: 'For clients' },
    { href: '#pricing', label: 'Pricing' },
    { href: '#faq', label: 'FAQ' },
  ];

  return (
    <div
      className="min-h-screen bg-[#070B14] text-slate-200 antialiased"
      style={{ fontFamily: "'Inter', system-ui, -apple-system, sans-serif" }}
    >
      {/* ---------------------------------------------------------------- */}
      {/* Nav                                                               */}
      {/* ---------------------------------------------------------------- */}
      <header className="fixed top-0 inset-x-0 z-50 bg-[#070B14]/85 backdrop-blur border-b border-white/10">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
          <a href="#top" className="flex items-center gap-2.5 shrink-0">
            <span className="w-9 h-9 rounded-lg bg-[#F2A93B] flex items-center justify-center">
              <Building2 className="w-5 h-5 text-[#070B14]" strokeWidth={2.5} />
            </span>
            <span style={ANTON} className="tracking-wide text-lg text-white leading-none pt-0.5">DARSHAN OPS</span>
          </a>

          <nav className="hidden lg:flex items-center gap-8">
            {navLinks.map((l) => (
              <a key={l.href} href={l.href} className="text-sm font-medium text-slate-300 hover:text-white transition-colors">
                {l.label}
              </a>
            ))}
          </nav>

          <div className="hidden lg:flex items-center gap-3">
            <Link to="/login" className="text-sm font-semibold text-slate-200 hover:text-white px-3 py-2 transition-colors">
              Sign in
            </Link>
            <Link
              to="/login"
              className="inline-flex items-center gap-1.5 text-sm font-semibold bg-[#F2A93B] hover:bg-[#FFC15C] text-[#070B14] px-4 py-2.5 rounded-lg transition-colors"
            >
              Book a demo <ArrowRight className="w-4 h-4" />
            </Link>
          </div>

          <button onClick={() => setNavOpen((v) => !v)} className="lg:hidden text-slate-200 p-2 -mr-2" aria-label="Toggle menu">
            {navOpen ? <X className="w-6 h-6" /> : <Menu className="w-6 h-6" />}
          </button>
        </div>

        {navOpen && (
          <div className="lg:hidden border-t border-white/10 bg-[#070B14] px-4 py-4 space-y-3">
            {navLinks.map((l) => (
              <a key={l.href} href={l.href} onClick={() => setNavOpen(false)} className="block text-sm font-medium text-slate-300 py-1.5">
                {l.label}
              </a>
            ))}
            <div className="pt-2 flex flex-col gap-2">
              <Link to="/login" className="text-center text-sm font-semibold border border-white/15 text-slate-200 px-4 py-2.5 rounded-lg">
                Sign in
              </Link>
              <Link to="/login" className="text-center text-sm font-semibold bg-[#F2A93B] text-[#070B14] px-4 py-2.5 rounded-lg">
                Book a demo
              </Link>
            </div>
          </div>
        )}
      </header>

      <main id="top">
        {/* -------------------------------------------------------------- */}
        {/* Hero                                                            */}
        {/* -------------------------------------------------------------- */}
        <section className="relative overflow-hidden pt-32 pb-20 sm:pt-40 sm:pb-28">
          <div
            className="absolute inset-0 bg-[radial-gradient(circle_at_1px_1px,rgba(255,255,255,0.06)_1px,transparent_0)] opacity-40 pointer-events-none"
            style={{ backgroundSize: '28px 28px' }}
            aria-hidden="true"
          />
          <div className="absolute -top-40 -right-20 w-[32rem] h-[32rem] bg-[#3E7BFA]/20 rounded-full blur-3xl pointer-events-none" aria-hidden="true" />
          <div className="absolute -bottom-32 -left-20 w-[28rem] h-[28rem] bg-[#F2A93B]/10 rounded-full blur-3xl pointer-events-none" aria-hidden="true" />

          <div className="relative max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 grid lg:grid-cols-2 gap-16 items-center">
            <div>
              <span className="inline-flex items-center gap-2 text-xs font-mono font-medium tracking-wide uppercase text-[#FFC15C] bg-[#F2A93B]/10 border border-[#F2A93B]/25 rounded-full px-3 py-1.5 mb-6">
                <span className="w-1.5 h-1.5 rounded-full bg-[#FFC15C]" /> Built for out-of-home, ground up
              </span>
              <h1 style={ANTON} className="uppercase leading-[0.95] text-5xl sm:text-6xl xl:text-7xl text-white tracking-tight">
                Every hoarding.
                <br />
                <span className="text-[#F2A93B]">One system</span>
                <br />
                site to invoice.
              </h1>
              <p className="mt-7 text-lg text-slate-400 max-w-xl leading-relaxed">
                Darshan Ops replaces the spreadsheet-plus-WhatsApp workflow most OOH agencies still run on
                — with one platform covering survey, design, production, installation and billing, and a
                live portal your clients actually enjoy checking.
              </p>
              <div className="mt-9 flex flex-col sm:flex-row gap-4">
                <Link
                  to="/login"
                  className="inline-flex items-center justify-center gap-2 bg-[#F2A93B] hover:bg-[#FFC15C] text-[#070B14] font-semibold px-6 py-3.5 rounded-lg transition-colors"
                >
                  Book a demo <ArrowRight className="w-4 h-4" />
                </Link>
                <Link
                  to="/login"
                  className="inline-flex items-center justify-center gap-2 border border-white/15 hover:border-white/30 text-white font-semibold px-6 py-3.5 rounded-lg transition-colors"
                >
                  Sign in to your workspace
                </Link>
              </div>
              <div className="mt-10 flex flex-wrap gap-x-8 gap-y-3 text-sm text-slate-500 font-mono">
                <span className="flex items-center gap-2"><CheckCircle2 className="w-4 h-4 text-[#F2A93B]" /> 5-stage approval, DB-enforced</span>
                <span className="flex items-center gap-2"><CheckCircle2 className="w-4 h-4 text-[#F2A93B]" /> Offline-first field PWA</span>
                <span className="flex items-center gap-2"><CheckCircle2 className="w-4 h-4 text-[#F2A93B]" /> GPS + photo verified installs</span>
              </div>
            </div>

            {/* Signature visual: a live-map style dashboard mock — this is
                the app's real Live Field Map feature, illustrated rather
                than screenshotted. Pure CSS/SVG, no external images. */}
            <Reveal>
              <div className="relative rounded-2xl border border-white/10 bg-[#0B1220] shadow-2xl shadow-black/40 p-5 sm:p-6">
                <div className="flex items-center justify-between mb-4">
                  <div className="flex items-center gap-2">
                    <span className="w-2.5 h-2.5 rounded-full bg-red-400/70" />
                    <span className="w-2.5 h-2.5 rounded-full bg-[#FFC15C]/70" />
                    <span className="w-2.5 h-2.5 rounded-full bg-emerald-400/70" />
                  </div>
                  <span className="text-xs font-mono text-slate-500">Live Field Map</span>
                </div>

                <div className="relative rounded-xl bg-[#121B2E] border border-white/10 h-64 sm:h-72 overflow-hidden">
                  <svg viewBox="0 0 400 260" className="w-full h-full opacity-70" aria-hidden="true">
                    {Array.from({ length: 9 }).map((_, i) => (
                      <line key={`v${i}`} x1={i * 44} y1="0" x2={i * 44} y2="260" stroke="#2A3B5C" strokeWidth="1" />
                    ))}
                    {Array.from({ length: 6 }).map((_, i) => (
                      <line key={`h${i}`} x1="0" y1={i * 44} x2="400" y2={i * 44} stroke="#2A3B5C" strokeWidth="1" />
                    ))}
                  </svg>
                  {[
                    { x: '20%', y: '30%', c: 'bg-emerald-400', d: '0s' },
                    { x: '48%', y: '58%', c: 'bg-[#FFC15C]', d: '0.3s' },
                    { x: '68%', y: '22%', c: 'bg-slate-400', d: '0.6s' },
                    { x: '78%', y: '68%', c: 'bg-emerald-400', d: '0.9s' },
                    { x: '35%', y: '78%', c: 'bg-[#3E7BFA]', d: '0.2s' },
                  ].map((p, i) => (
                    <span
                      key={i}
                      className="absolute -translate-x-1/2 -translate-y-1/2"
                      style={{ left: p.x, top: p.y }}
                    >
                      <span className={`block w-3 h-3 rounded-full ${p.c} ring-4 ring-white/10 animate-pulse`} style={{ animationDelay: p.d }} />
                    </span>
                  ))}
                  <div className="absolute bottom-3 left-3 right-3 bg-[#070B14]/90 border border-white/10 rounded-lg px-3 py-2.5 flex items-center justify-between">
                    <div>
                      <p className="text-xs font-mono text-slate-400">PO-2481 &middot; Andheri West</p>
                      <p className="text-sm font-semibold text-white">Installation review pending</p>
                    </div>
                    <span className="text-xs font-mono font-semibold text-[#FFC15C] bg-[#F2A93B]/10 px-2 py-1 rounded">92%</span>
                  </div>
                </div>

                <div className="grid grid-cols-3 gap-3 mt-4">
                  {[
                    { label: 'Surveyed', value: '128' },
                    { label: 'In production', value: '34' },
                    { label: 'Installed', value: '96' },
                  ].map((s) => (
                    <div key={s.label} className="rounded-lg bg-[#121B2E] border border-white/10 px-3 py-2.5 text-center">
                      <p className="font-mono text-xl font-semibold text-white">{s.value}</p>
                      <p className="text-[11px] text-slate-500 mt-0.5">{s.label}</p>
                    </div>
                  ))}
                </div>
              </div>
            </Reveal>
          </div>
        </section>

        {/* -------------------------------------------------------------- */}
        {/* Problem / solution                                              */}
        {/* -------------------------------------------------------------- */}
        <section className="bg-[#0B1220] border-y border-white/5 py-20">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 grid md:grid-cols-2 gap-10">
            <Reveal>
              <div className="rounded-2xl border border-white/10 bg-[#070B14]/60 p-8 h-full">
                <p className="text-xs font-mono uppercase tracking-widest text-slate-500 mb-3">The old way</p>
                <h3 className="text-2xl font-bold text-white mb-4">A campaign lives in six different apps</h3>
                <ul className="space-y-3 text-slate-400">
                  <li>Site measurements on paper, or lost in a WhatsApp thread.</li>
                  <li>No one can say for certain which board is actually installed.</li>
                  <li>An invoice goes out before installation is even confirmed.</li>
                  <li>The client calls to ask "is it up yet?" — because they have no other way to know.</li>
                </ul>
              </div>
            </Reveal>
            <Reveal delay={120}>
              <div className="rounded-2xl border border-[#F2A93B]/30 bg-[#F2A93B]/5 p-8 h-full">
                <p className="text-xs font-mono uppercase tracking-widest text-[#F2A93B] mb-3">With Darshan Ops</p>
                <h3 className="text-2xl font-bold text-white mb-4">One record, from measuring tape to invoice</h3>
                <ul className="space-y-3 text-slate-300">
                  <li className="flex gap-2"><CheckCircle2 className="w-5 h-5 text-[#F2A93B] shrink-0 mt-0.5" /> GPS-pinned, photo-verified surveys captured on-site, offline if needed.</li>
                  <li className="flex gap-2"><CheckCircle2 className="w-5 h-5 text-[#F2A93B] shrink-0 mt-0.5" /> Every stage change requires an explicit approval — enforced in the database.</li>
                  <li className="flex gap-2"><CheckCircle2 className="w-5 h-5 text-[#F2A93B] shrink-0 mt-0.5" /> Billing only unlocks once installation is actually approved.</li>
                  <li className="flex gap-2"><CheckCircle2 className="w-5 h-5 text-[#F2A93B] shrink-0 mt-0.5" /> Clients see live status themselves, on a map, with photos.</li>
                </ul>
              </div>
            </Reveal>
          </div>
        </section>

        {/* -------------------------------------------------------------- */}
        {/* Workflow                                                        */}
        {/* -------------------------------------------------------------- */}
        <section id="workflow" className="py-24">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
            <Reveal>
              <div className="max-w-2xl mb-16">
                <p className="text-xs font-mono uppercase tracking-widest text-[#F2A93B] mb-3">How it works</p>
                <h2 className="text-3xl sm:text-4xl font-bold text-white">Five checkpoints. Nobody skips one.</h2>
                <p className="mt-4 text-slate-400 leading-relaxed">
                  Every board moves through the same chain, no matter who's holding the phone. Each handoff needs
                  an explicit Admin/Owner approval — not a status a well-meaning teammate forgot to update.
                </p>
              </div>
            </Reveal>

            <div className="grid md:grid-cols-5 gap-5">
              {WORKFLOW.map((step, i) => (
                <Reveal key={step.stage} delay={i * 90}>
                  <div className="relative h-full rounded-xl border border-white/10 bg-[#0B1220] p-5 flex flex-col">
                    <div className="flex items-center justify-between mb-4">
                      <span className="w-10 h-10 rounded-lg bg-white/5 flex items-center justify-center">
                        <step.icon className="w-5 h-5 text-[#F2A93B]" />
                      </span>
                      <span className="font-mono text-xs text-slate-600">0{i + 1}</span>
                    </div>
                    <h3 className="text-white font-semibold">{step.stage}</h3>
                    <p className="text-xs font-mono text-[#3E7BFA] mt-0.5 mb-3">{step.role}</p>
                    <p className="text-sm text-slate-400 leading-relaxed flex-1">{step.detail}</p>
                    <p className="text-xs text-slate-500 mt-4 pt-4 border-t border-white/10 leading-relaxed">{step.gate}</p>
                  </div>
                </Reveal>
              ))}
            </div>
          </div>
        </section>

        {/* -------------------------------------------------------------- */}
        {/* Agency features                                                 */}
        {/* -------------------------------------------------------------- */}
        <section id="agencies" className="bg-[#0B1220] border-y border-white/5 py-24">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
            <Reveal>
              <div className="max-w-2xl mb-14">
                <p className="text-xs font-mono uppercase tracking-widest text-[#3E7BFA] mb-3">For agencies</p>
                <h2 className="text-3xl sm:text-4xl font-bold text-white">Run the whole floor from one console</h2>
                <p className="mt-4 text-slate-400 leading-relaxed">
                  Owners, admins, designers, production and accounts each get exactly the view their job needs —
                  nothing hidden, nothing they shouldn't see either.
                </p>
              </div>
            </Reveal>
            <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-6">
              {AGENCY_FEATURES.map((f, i) => (
                <Reveal key={f.title} delay={i * 70}>
                  <div className="rounded-xl border border-white/10 bg-[#070B14]/60 p-6 h-full hover:border-white/20 transition-colors">
                    <span className="inline-flex w-11 h-11 rounded-lg bg-[#3E7BFA]/10 items-center justify-center mb-4">
                      <f.icon className="w-5 h-5 text-[#3E7BFA]" />
                    </span>
                    <h3 className="text-white font-semibold mb-2">{f.title}</h3>
                    <p className="text-sm text-slate-400 leading-relaxed">{f.text}</p>
                  </div>
                </Reveal>
              ))}
            </div>
          </div>
        </section>

        {/* -------------------------------------------------------------- */}
        {/* Client portal features                                         */}
        {/* -------------------------------------------------------------- */}
        <section id="clients" className="py-24">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 grid lg:grid-cols-5 gap-14 items-start">
            <Reveal className="lg:col-span-2">
              <p className="text-xs font-mono uppercase tracking-widest text-[#F2A93B] mb-3">For clients</p>
              <h2 className="text-3xl sm:text-4xl font-bold text-white">A portal your clients will actually open</h2>
              <p className="mt-4 text-slate-400 leading-relaxed">
                Give every brand you work with its own login — real-time progress across all their campaigns,
                with every agency they use ranked side by side, and never a rupee of your internal costing exposed.
              </p>
              <Link to="/login" className="mt-7 inline-flex items-center gap-2 text-[#F2A93B] font-semibold hover:text-[#FFC15C] transition-colors">
                See the client portal <ArrowRight className="w-4 h-4" />
              </Link>
            </Reveal>
            <div className="lg:col-span-3 grid sm:grid-cols-2 gap-6">
              {CLIENT_FEATURES.map((f, i) => (
                <Reveal key={f.title} delay={i * 70}>
                  <div className="rounded-xl border border-white/10 bg-[#0B1220] p-6 h-full">
                    <span className="inline-flex w-11 h-11 rounded-lg bg-[#F2A93B]/10 items-center justify-center mb-4">
                      <f.icon className="w-5 h-5 text-[#F2A93B]" />
                    </span>
                    <h3 className="text-white font-semibold mb-2">{f.title}</h3>
                    <p className="text-sm text-slate-400 leading-relaxed">{f.text}</p>
                  </div>
                </Reveal>
              ))}
            </div>
          </div>
        </section>

        {/* -------------------------------------------------------------- */}
        {/* Personas                                                        */}
        {/* -------------------------------------------------------------- */}
        <section className="bg-[#0B1220] border-y border-white/5 py-24">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
            <Reveal>
              <div className="text-center max-w-2xl mx-auto mb-14">
                <p className="text-xs font-mono uppercase tracking-widest text-[#3E7BFA] mb-3">Every seat at the table</p>
                <h2 className="text-3xl sm:text-4xl font-bold text-white">Built for the whole crew, not just the office</h2>
              </div>
            </Reveal>
            <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-6">
              {PERSONAS.map((p, i) => (
                <Reveal key={p.role} delay={i * 80}>
                  <div className="rounded-xl border border-white/10 bg-[#070B14]/60 p-6 text-center h-full">
                    <span className="inline-flex w-12 h-12 rounded-full bg-white/5 items-center justify-center mb-4">
                      <p.icon className="w-6 h-6 text-[#F2A93B]" />
                    </span>
                    <h3 className="text-white font-semibold mb-2">{p.role}</h3>
                    <p className="text-sm text-slate-400 leading-relaxed">{p.text}</p>
                  </div>
                </Reveal>
              ))}
            </div>
          </div>
        </section>

        {/* -------------------------------------------------------------- */}
        {/* Security / trust                                                */}
        {/* -------------------------------------------------------------- */}
        <section className="py-24">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 grid md:grid-cols-3 gap-6">
            <Reveal>
              <div className="flex gap-4">
                <Lock className="w-8 h-8 text-[#F2A93B] shrink-0" />
                <div>
                  <h3 className="text-white font-semibold mb-1.5">Row-level security by default</h3>
                  <p className="text-sm text-slate-400 leading-relaxed">Every table is access-scoped at the database layer — an org, a role or a client can only ever query what it's actually entitled to see.</p>
                </div>
              </div>
            </Reveal>
            <Reveal delay={90}>
              <div className="flex gap-4">
                <Smartphone className="w-8 h-8 text-[#F2A93B] shrink-0" />
                <div>
                  <h3 className="text-white font-semibold mb-1.5">Installable field app</h3>
                  <p className="text-sm text-slate-400 leading-relaxed">Surveyors and installers get a PWA that installs like a native app and keeps working when the signal doesn't.</p>
                </div>
              </div>
            </Reveal>
            <Reveal delay={180}>
              <div className="flex gap-4">
                <FileCheck className="w-8 h-8 text-[#F2A93B] shrink-0" />
                <div>
                  <h3 className="text-white font-semibold mb-1.5">An audit trail that holds up</h3>
                  <p className="text-sm text-slate-400 leading-relaxed">Approvals, rejections and corrections are all timestamped records — useful the day a client asks "who approved this?"</p>
                </div>
              </div>
            </Reveal>
          </div>
        </section>

        {/* -------------------------------------------------------------- */}
        {/* Pricing                                                         */}
        {/* -------------------------------------------------------------- */}
        <section id="pricing" className="bg-[#0B1220] border-y border-white/5 py-24">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
            <Reveal>
              <div className="text-center max-w-2xl mx-auto mb-14">
                <p className="text-xs font-mono uppercase tracking-widest text-[#F2A93B] mb-3">Pricing</p>
                <h2 className="text-3xl sm:text-4xl font-bold text-white">Plans built around your site count</h2>
                <p className="mt-4 text-slate-400 leading-relaxed">Every plan includes the full Survey \u2192 Design \u2192 Production \u2192 Installation \u2192 Billing chain. Talk to us for a quote sized to your team and site volume.</p>
              </div>
            </Reveal>
            <div className="grid md:grid-cols-3 gap-6">
              {[
                { name: 'Starter', blurb: 'Single-city agencies getting off spreadsheets.', features: ['Up to 3 office seats', 'Unlimited field users', 'Survey \u2192 Billing workflow', 'Email support'] },
                { name: 'Growth', blurb: 'Multi-city agencies managing several clients at once.', features: ['Unlimited office seats', 'Client Organisation portal', 'Live Field Map + Route Planning', 'Priority support'], popular: true },
                { name: 'Enterprise', blurb: 'Networks running high site volume across regions.', features: ['Everything in Growth', 'Custom RLS & data residency', 'Dedicated onboarding', 'SLA-backed support'] },
              ].map((tier) => (
                <div
                  key={tier.name}
                  className={`rounded-2xl p-8 flex flex-col ${tier.popular ? 'bg-[#F2A93B] text-[#070B14] border border-[#FFC15C]' : 'bg-[#070B14]/60 border border-white/10 text-slate-200'}`}
                >
                  {tier.popular && (
                    <span className="self-start text-[11px] font-mono font-bold uppercase tracking-wide bg-[#070B14] text-[#FFC15C] px-2.5 py-1 rounded-full mb-4">Most popular</span>
                  )}
                  <h3 className={`text-xl font-bold mb-1 ${tier.popular ? 'text-[#070B14]' : 'text-white'}`}>{tier.name}</h3>
                  <p className={`text-sm mb-6 ${tier.popular ? 'text-[#0B1220]' : 'text-slate-400'}`}>{tier.blurb}</p>
                  <ul className="space-y-2.5 mb-8 flex-1">
                    {tier.features.map((f) => (
                      <li key={f} className="flex items-start gap-2 text-sm">
                        <CheckCircle2 className={`w-4 h-4 shrink-0 mt-0.5 ${tier.popular ? 'text-[#070B14]' : 'text-[#F2A93B]'}`} />
                        {f}
                      </li>
                    ))}
                  </ul>
                  <Link
                    to="/login"
                    className={`text-center font-semibold px-5 py-3 rounded-lg transition-colors ${
                      tier.popular ? 'bg-[#070B14] text-white hover:bg-[#121B2E]' : 'border border-white/15 text-white hover:border-white/30'
                    }`}
                  >
                    Talk to sales
                  </Link>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* -------------------------------------------------------------- */}
        {/* FAQ                                                             */}
        {/* -------------------------------------------------------------- */}
        <section id="faq" className="py-24">
          <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8">
            <Reveal>
              <div className="text-center mb-14">
                <p className="text-xs font-mono uppercase tracking-widest text-[#3E7BFA] mb-3">FAQ</p>
                <h2 className="text-3xl sm:text-4xl font-bold text-white">Questions agencies actually ask</h2>
              </div>
            </Reveal>
            <div className="space-y-3">
              {FAQS.map((f, i) => {
                const isOpen = openFaq === i;
                return (
                  <Reveal key={f.q} delay={i * 40}>
                    <div className="rounded-xl border border-white/10 bg-[#0B1220] overflow-hidden">
                      <button
                        onClick={() => setOpenFaq(isOpen ? null : i)}
                        className="w-full flex items-center justify-between gap-4 text-left px-5 py-4"
                        aria-expanded={isOpen}
                      >
                        <span className="font-semibold text-white text-sm sm:text-base">{f.q}</span>
                        <ChevronDown className={`w-5 h-5 text-slate-500 shrink-0 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
                      </button>
                      {isOpen && <p className="px-5 pb-5 text-sm text-slate-400 leading-relaxed">{f.a}</p>}
                    </div>
                  </Reveal>
                );
              })}
            </div>
          </div>
        </section>

        {/* -------------------------------------------------------------- */}
        {/* Final CTA                                                       */}
        {/* -------------------------------------------------------------- */}
        <section className="py-24">
          <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8">
            <Reveal>
              <div className="relative overflow-hidden rounded-3xl bg-gradient-to-br from-[#F2A93B] to-[#DA8B1A] px-8 py-16 sm:px-16 text-center">
                <div className="absolute inset-0 bg-[radial-gradient(circle_at_1px_1px,rgba(255,255,255,0.06)_1px,transparent_0)] opacity-10" style={{ backgroundSize: '22px 22px' }} aria-hidden="true" />
                <h2 style={ANTON} className="relative uppercase text-4xl sm:text-5xl text-[#070B14] tracking-tight">
                  Get your first survey live today
                </h2>
                <p className="relative mt-4 text-[#0B1220] max-w-xl mx-auto">
                  Bring one campaign onto Darshan Ops and see it move from a GPS pin to a signed-off invoice —
                  no migration required to try it.
                </p>
                <div className="relative mt-8 flex flex-col sm:flex-row gap-4 justify-center">
                  <Link to="/login" className="inline-flex items-center justify-center gap-2 bg-[#070B14] text-white font-semibold px-7 py-3.5 rounded-lg hover:bg-[#121B2E] transition-colors">
                    Book a demo <ArrowRight className="w-4 h-4" />
                  </Link>
                  <Link to="/login" className="inline-flex items-center justify-center gap-2 bg-white/20 text-[#070B14] font-semibold px-7 py-3.5 rounded-lg hover:bg-white/30 transition-colors">
                    Sign in
                  </Link>
                </div>
              </div>
            </Reveal>
          </div>
        </section>
      </main>

      {/* ---------------------------------------------------------------- */}
      {/* Footer                                                            */}
      {/* ---------------------------------------------------------------- */}
      <footer className="border-t border-white/10 bg-[#070B14]">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-14 grid sm:grid-cols-2 lg:grid-cols-4 gap-10">
          <div className="lg:col-span-1">
            <div className="flex items-center gap-2.5 mb-4">
              <span className="w-8 h-8 rounded-lg bg-[#F2A93B] flex items-center justify-center">
                <Building2 className="w-4 h-4 text-[#070B14]" strokeWidth={2.5} />
              </span>
              <span style={ANTON} className="tracking-wide text-white">DARSHAN OPS</span>
            </div>
            <p className="text-sm text-slate-500 leading-relaxed">
              The field-to-billing operating system for out-of-home advertising agencies and their clients.
            </p>
          </div>
          <div>
            <p className="text-xs font-mono uppercase tracking-widest text-slate-600 mb-4">Product</p>
            <ul className="space-y-2.5 text-sm text-slate-400">
              <li><a href="#workflow" className="hover:text-white transition-colors">How it works</a></li>
              <li><a href="#agencies" className="hover:text-white transition-colors">For agencies</a></li>
              <li><a href="#clients" className="hover:text-white transition-colors">For clients</a></li>
              <li><a href="#pricing" className="hover:text-white transition-colors">Pricing</a></li>
            </ul>
          </div>
          <div>
            <p className="text-xs font-mono uppercase tracking-widest text-slate-600 mb-4">Company</p>
            <ul className="space-y-2.5 text-sm text-slate-400">
              <li><a href="#faq" className="hover:text-white transition-colors">FAQ</a></li>
              <li><Link to="/login" className="hover:text-white transition-colors">Sign in</Link></li>
              <li><a href="mailto:hello@darshanadagency.com" className="hover:text-white transition-colors">Contact sales</a></li>
            </ul>
          </div>
          <div>
            <p className="text-xs font-mono uppercase tracking-widest text-slate-600 mb-4">Get in touch</p>
            <p className="text-sm text-slate-400 mb-2">hello@darshanadagency.com</p>
            <p className="text-sm text-slate-400">Mumbai, India</p>
          </div>
        </div>
        <div className="border-t border-white/10 py-6">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 flex flex-col sm:flex-row justify-between items-center gap-3 text-xs text-slate-600">
            <p>&copy; {currentYear} Darshan Ad Agency. All rights reserved.</p>
            <p className="font-mono">Survey &middot; Design &middot; Production &middot; Installation &middot; Billing</p>
          </div>
        </div>
      </footer>
    </div>
  );
}
