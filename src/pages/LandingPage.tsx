import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowDown,
  ArrowRight,
  Check,
  ChevronRight,
  FileCheck2,
  Menu,
  Navigation,
  PackageCheck,
  Ruler,
  ShieldCheck,
  UsersRound,
  WifiOff,
  X,
} from 'lucide-react';
import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { ScrollToPlugin } from 'gsap/ScrollToPlugin';
import './landing.css';

gsap.registerPlugin(ScrollTrigger, ScrollToPlugin);

const A = '/landing/cinematic';

const images = {
  city: `${A}/01_AdRoute_Master_City_Hero.png`,
  survey: `${A}/02_AdRoute_Shop_Field_Survey.png`,
  agency: `${A}/03_AdRoute_Agency_Exterior.png`,
  production: `${A}/04_AdRoute_Agency_Design_Production_Fabrication.png`,
  installation: `${A}/05_AdRoute_Active_Installation.png`,
  proof: `${A}/06_AdRoute_Nova_Living_Installation_Verified.png`,
  ops: `${A}/07_AdRoute_Agency_Live_Operations.png`,
  client: `${A}/08_AdRoute_Client_Office_Exterior.png`,
  reporting: `${A}/09_AdRoute_Client_Campaign_Review.png`,
  final: `${A}/10_AdRoute_Connected_Operations_Final_CTA.png`,
};

type Chapter = {
  id: string;
  no: string;
  eyebrow: string;
  title: string;
  body: string;
  image: string;
  position?: string;
  align?: 'left' | 'right';
  chips?: string[];
  audience?: string;
  outcome?: string;
};

const chapters: Chapter[] = [
  {
    id: 'survey', no: '01', eyebrow: 'SITE SURVEY',
    title: 'Every site starts with real field data.',
    body: 'Capture measurements, site conditions, photos and location context before work moves into design and production.',
    image: images.survey, position: 'center 46%', align: 'left',
    chips: ['Measurements', 'Site photos', 'Location', 'Installation area'],
    audience: 'FIELD TEAM', outcome: 'A complete site record enters the workflow.',
  },
  {
    id: 'agency', no: '02', eyebrow: 'FIELD → AGENCY',
    title: 'Field data arrives where the work gets built.',
    body: 'Site information becomes actionable work for design, production and operations teams without losing the original field context.',
    image: images.agency, position: 'center 50%', align: 'right',
    chips: ['Site-linked work', 'Creative context', 'Shared source of truth'],
    audience: 'AGENCY', outcome: 'Survey data becomes structured work—not a WhatsApp handoff.',
  },
  {
    id: 'production', no: '03', eyebrow: 'DESIGN → PRODUCTION',
    title: 'From approved creative to installation-ready output.',
    body: 'Keep design, materials, fabrication, quality checks and dispatch connected to the same site and job.',
    image: images.production, position: 'center 49%', align: 'left',
    chips: ['Design', 'Print', 'Fabricate', 'QC', 'Dispatch'],
    audience: 'AGENCY', outcome: 'Every output stays tied to the correct site, scope and quantity.',
  },
  {
    id: 'installation', no: '04', eyebrow: 'INSTALLATION',
    title: 'Execution stays connected to the job.',
    body: 'Field teams work from the same site context while operations can follow progress as installation happens.',
    image: images.installation, position: 'center 50%', align: 'right',
    chips: ['Site context', 'Field team', 'Progress'],
    audience: 'FIELD + AGENCY', outcome: 'Execution progress remains visible while work happens.',
  },
  {
    id: 'proof', no: '05', eyebrow: 'INSTALLATION VERIFIED',
    title: 'Proof is captured at the moment the work is completed.',
    body: 'The field team uploads installation proof directly from site, giving operations an immediate record of what was installed.',
    image: images.proof, position: 'center 50%', align: 'left',
    chips: ['Photo proof', 'Site identity', 'Location', 'Verified'],
    audience: 'FIELD → AGENCY', outcome: 'Completion becomes verifiable evidence, not a loose photo.',
  },
  {
    id: 'ops', no: '06', eyebrow: 'LIVE OPERATIONS',
    title: 'Every site moves into one operational view.',
    body: 'Operations teams review proof, verify completion and understand campaign progress without chasing field updates.',
    image: images.ops, position: 'center 51%', align: 'right',
    chips: ['Site status', 'Recent activity', 'Proof', 'Team'],
    audience: 'AGENCY OPERATIONS', outcome: 'Teams manage many sites from one live operational picture.',
  },
  {
    id: 'client', no: '07', eyebrow: 'CLIENT VISIBILITY',
    title: 'Clients see progress without chasing for updates.',
    body: 'Verified field activity, campaign status and completed-site proof stay available through a clear client-facing view.',
    image: images.client, position: 'center 48%', align: 'left',
    chips: ['Overview', 'Progress', 'Verified sites', 'Reports'],
    audience: 'CLIENT', outcome: 'Clients get visibility without repeatedly asking the agency for updates.',
  },
  {
    id: 'reporting', no: '08', eyebrow: 'REPORTING',
    title: 'From field proof to client-ready reporting.',
    body: 'Verified installation data becomes a reliable record for campaign reviews, reporting and the next commercial step.',
    image: images.reporting, position: 'center 50%', align: 'right',
    chips: ['Verified proof', 'Campaign review', 'Billing readiness'],
    audience: 'AGENCY + CLIENT', outcome: 'Verified execution becomes review-ready and commercially actionable.',
  },
];

const capabilityItems = [
  { icon: WifiOff, title: 'Offline-first field workflows', body: 'Keep survey and installation work moving where connectivity is unreliable.' },
  { icon: Navigation, title: 'Route & site planning', body: 'Coordinate teams around real locations and campaign priorities.' },
  { icon: PackageCheck, title: 'Material & PO tracking', body: 'Keep production scope, materials and quantities tied to the job.' },
  { icon: ShieldCheck, title: 'GPS + photo verification', body: 'Maintain a defensible record of completed field activity.' },
  { icon: UsersRound, title: 'Role-based operations', body: 'Give every team exactly the operating context they need.' },
  { icon: FileCheck2, title: 'Reports & analytics', body: 'Turn verified execution into clear campaign and client reporting.' },
];

const team = [
  ['Owner / Operations', 'Campaign control, approvals and progress'],
  ['Surveyor', 'Measurements, photos and site context'],
  ['Designer', 'Creative mapped to the real site'],
  ['Production', 'Fabrication, materials, QC and dispatch'],
  ['Installer', 'Execution and verified site proof'],
  ['Client', 'Progress, completed sites and reporting'],
];

const finalNodes = [
  {
    id: 'shop', label: 'FIELD SITE', x: 21.5, y: 66,
    body: 'Survey the location, capture measurements, execute installation and upload verified proof from the same site record.',
    tags: ['Survey', 'Installation', 'Proof'],
  },
  {
    id: 'agency', label: 'AGENCY OPERATIONS', x: 46, y: 34,
    body: 'Turn site information into design, production, field coordination and verified campaign progress.',
    tags: ['Design', 'Production', 'Live Ops', 'Verification'],
  },
  {
    id: 'client', label: 'CLIENT VISIBILITY', x: 82, y: 24,
    body: 'Give clients a clear view of campaign progress, completed sites, verified photos and reporting.',
    tags: ['Progress', 'Proof Gallery', 'Reports'],
  },
] as const;

const proofStages = [
  { id: 'field', no: '01', label: 'FIELD EVIDENCE', title: 'Proof is created where the work happens.', body: 'Installation teams capture completion at the physical site, keeping the evidence attached to the right location and job.', image: images.proof, meta: ['Site identity', 'Photo proof', 'Location context'] },
  { id: 'ops', no: '02', label: 'AGENCY VERIFICATION', title: 'Operations validates the completion record.', body: 'The agency reviews site-linked proof, confirms completion and keeps campaign status aligned with what actually happened on ground.', image: images.ops, meta: ['Verification', 'Live status', 'Operational review'] },
  { id: 'client', no: '03', label: 'CLIENT VISIBILITY', title: 'Verified execution becomes client-ready clarity.', body: 'Clients see completed work and campaign progress through a cleaner review layer grounded in verified field activity.', image: images.reporting, meta: ['Campaign review', 'Verified progress', 'Reporting'] },
] as const;

function AdRouteMark({ compact = false }: { compact?: boolean }) {
  return (
    <div className={`adroute-mark ${compact ? 'adroute-mark--compact' : ''}`} aria-label="AdRoute">
      <span className="adroute-mark__symbol"><span /><span /><span /></span>
      <strong>AdRoute</strong>
    </div>
  );
}

function ChapterCopy({ chapter }: { chapter: Chapter }) {
  return (
    <div className={`chapter-copy chapter-copy--${chapter.align ?? 'left'}`}>
      <div className="chapter-copy__eyebrow"><span>{chapter.no}</span>{chapter.eyebrow}</div>
      <h2>{chapter.title}</h2>
      <p>{chapter.body}</p>
      {chapter.chips && (
        <div className="chapter-copy__chips">
          {chapter.chips.map((chip) => <span key={chip}>{chip}</span>)}
        </div>
      )}
      {chapter.audience && chapter.outcome && (
        <div className="chapter-outcome">
          <small>{chapter.audience}</small>
          <span>{chapter.outcome}</span>
        </div>
      )}
    </div>
  );
}

function ProcessOverlay({ id }: { id: string }) {
  if (id === 'survey') {
    return (
      <div className="micro-ui micro-ui--survey" aria-hidden="true">
        <Ruler size={17} /><div><small>SITE MEASURE</small><strong>Captured on site</strong></div><Check size={15} />
      </div>
    );
  }
  if (id === 'production') {
    return (
      <div className="production-markers" aria-hidden="true">
        {['Design & Prepress', 'Wide-format Print', 'ACP Fabrication', 'Quality Control', 'Dispatch'].map((item, i) => (
          <span key={item} style={{ '--i': i } as CSSProperties}>{item}</span>
        ))}
      </div>
    );
  }
  if (id === 'proof') {
    return (
      <div className="proof-transfer" aria-hidden="true">
        <div className="proof-transfer__thumb"><img src={images.proof} alt="" /></div>
        <div><small>SITE 024 · PROOF</small><strong>Installation verified</strong><span><Check size={11} /> GPS + photo linked</span></div>
      </div>
    );
  }
  if (id === 'ops') {
    return (
      <div className="ops-panel" aria-hidden="true">
        <div className="ops-panel__top"><span>CAMPAIGN LIVE</span><b>Site 024</b></div>
        <div className="ops-panel__stats"><span><b>128</b> Surveyed</span><span><b>96</b> Installed</span><span><b>34</b> Production</span></div>
        <div className="ops-panel__proof"><img src={images.proof} alt="" /><span><Check size={12} /> NOVA LIVING · Verified</span></div>
      </div>
    );
  }
  return null;
}

function LandingPage() {
  const journeyRef = useRef<HTMLDivElement>(null);
  const pinRef = useRef<HTMLDivElement>(null);
  const [activeChapter, setActiveChapter] = useState('intro');
  const [mobileNav, setMobileNav] = useState(false);
  const [openNode, setOpenNode] = useState<string | null>(null);
  const [heroComplete, setHeroComplete] = useState(false);
  const [proofStage, setProofStage] = useState<(typeof proofStages)[number]['id']>('field');

  const sceneIds = useMemo(() => ['intro', 'city', ...chapters.map((c) => c.id), 'final'], []);

  useEffect(() => {
    document.title = 'AdRoute — Field Operations Platform for Outdoor Branding & Signage Agencies';
    const meta = document.querySelector('meta[name="description"]') || document.head.appendChild(document.createElement('meta'));
    meta.setAttribute('name', 'description');
    meta.setAttribute('content', 'AdRoute connects site surveys, design, signage production, installation proof, agency operations, client visibility, reporting and billing readiness in one outdoor-branding workflow.');

    const ensureMeta = (property: string, content: string) => {
      let tag = document.head.querySelector<HTMLMetaElement>(`meta[property="${property}"]`);
      if (!tag) { tag = document.createElement('meta'); tag.setAttribute('property', property); document.head.appendChild(tag); }
      tag.setAttribute('content', content);
    };
    ensureMeta('og:title', 'AdRoute — From Site to Invoice');
    ensureMeta('og:description', 'One connected operations platform for outdoor branding and signage agencies—from field survey and production to verified client reporting.');
    ensureMeta('og:type', 'website');

    let schema = document.getElementById('adroute-structured-data') as HTMLScriptElement | null;
    if (!schema) { schema = document.createElement('script'); schema.id = 'adroute-structured-data'; schema.type = 'application/ld+json'; document.head.appendChild(schema); }
    schema.textContent = JSON.stringify({ '@context': 'https://schema.org', '@graph': [
      { '@type': 'WebSite', name: 'AdRoute', description: 'Connected operations platform for outdoor branding, signage and field execution.' },
      { '@type': 'SoftwareApplication', name: 'AdRoute', applicationCategory: 'BusinessApplication', operatingSystem: 'Web', description: 'Operations platform for outdoor advertising, signage and field-branding agencies connecting survey, design, production, installation proof, live operations, client visibility, reporting and billing readiness.' },
      { '@type': 'FAQPage', mainEntity: [
        { '@type': 'Question', name: 'What is AdRoute?', acceptedAnswer: { '@type': 'Answer', text: 'AdRoute is an operations platform for outdoor advertising, signage and field-branding agencies. It connects site survey, design and production, installation, verified proof, live operations, client visibility, reporting and billing readiness.' } },
        { '@type': 'Question', name: 'Who uses AdRoute?', acceptedAnswer: { '@type': 'Answer', text: 'Agency owners, operations teams, surveyors, installers, designers, production teams and clients use role-specific parts of the same connected workflow.' } },
        { '@type': 'Question', name: 'How does AdRoute help clients?', acceptedAnswer: { '@type': 'Answer', text: 'Clients can review campaign progress, completed sites, verified installation photos and reporting without relying on repeated manual update requests.' } }
      ] }
    ] });
  }, []);

  useEffect(() => {
    Object.values(images).slice(0, 4).forEach((src) => {
      const img = new Image();
      img.src = src;
      img.decode?.().catch(() => undefined);
    });
  }, []);

  useLayoutEffect(() => {
    const root = journeyRef.current;
    const pin = pinRef.current;
    if (!root || !pin) return;

    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduceMotion) {
      root.classList.add('reduced-motion');
      return;
    }

    const ctx = gsap.context(() => {
      const scenes = gsap.utils.toArray<HTMLElement>('.journey-scene');
      const copies = gsap.utils.toArray<HTMLElement>('.chapter-copy');
      const intro = root.querySelector<HTMLElement>('.intro-content');
      const introCity = root.querySelector<HTMLElement>('.intro-city-bg');
      const cloudVideo = root.querySelector<HTMLElement>('.cloud-video--base');
      const cityScene = root.querySelector<HTMLElement>('[data-scene="city"]');
      const cityImage = root.querySelector<HTMLElement>('[data-scene="city"] .scene-image');
      const finalScene = root.querySelector<HTMLElement>('[data-scene="final"]');
      const finalUi = root.querySelector<HTMLElement>('.final-city__hint');
      const finalImage = finalScene?.querySelector<HTMLElement>('.scene-image');
      const progressFill = root.querySelector<HTMLElement>('.hero-progress__fill');

      if (!intro || !introCity || !cloudVideo || !cityScene || !cityImage || !finalScene || !finalUi || !finalImage) return;

      gsap.set(scenes, { autoAlpha: 0, pointerEvents: 'none' });
      gsap.set(scenes[0], { autoAlpha: 1, pointerEvents: 'auto' });
      gsap.set(copies, { y: 28, autoAlpha: 0 });
      gsap.set(intro, { autoAlpha: 1 });
      gsap.set(introCity, { scale: 1.015, filter: 'brightness(.48) saturate(.78)' });
      gsap.set(cloudVideo, { scale: 1.0, autoAlpha: 0.58 });
      gsap.set(cityScene, { autoAlpha: 0 });
      gsap.set(cityImage, { scale: 0.98, filter: 'brightness(.72) saturate(.9)' });

      const tl = gsap.timeline({
        defaults: { ease: 'none' },
        scrollTrigger: {
          trigger: root,
          start: 'top top',
          end: 'bottom bottom',
          scrub: 0.85,
          invalidateOnRefresh: true,
          onUpdate: (self) => {
            if (progressFill) gsap.set(progressFill, { scaleY: self.progress });
            const stageIndex = Math.min(sceneIds.length - 1, Math.floor(self.progress * sceneIds.length));
            setActiveChapter(sceneIds[stageIndex] ?? 'intro');
            setHeroComplete(self.progress > 0.965);
          },
        },
      });

      // Intro → one continuous cloud layer zooms through camera while the city brightens underneath.
      // No split masks: the video remains a single seamless looping atmosphere.
      tl.to(intro, { y: -24, autoAlpha: 0, duration: 0.72 }, 0.38)
        .to(introCity, { scale: 1.07, filter: 'brightness(.92) saturate(.98)', duration: 1.35 }, 0.26)
        .to(cloudVideo, { scale: 1.42, autoAlpha: 0, duration: 1.28 }, 0.30)
        .to('.intro-shade', { autoAlpha: 0.08, duration: 1.18 }, 0.34)
        .to(cityScene, { autoAlpha: 1, pointerEvents: 'auto', duration: 0.82 }, 0.68)
        .to(cityImage, { scale: 1.045, filter: 'brightness(.96) saturate(1)', duration: 1.18 }, 0.68)
        .to(scenes[0], { autoAlpha: 0, pointerEvents: 'none', duration: 0.3 }, 1.52)
        .to(cityImage, { scale: 1.105, yPercent: 2, duration: 0.75 }, 1.45);

      let cursor = 2.0;
      chapters.forEach((chapter, i) => {
        const scene = root.querySelector<HTMLElement>(`[data-scene="${chapter.id}"]`);
        const copy = scene?.querySelector<HTMLElement>('.chapter-copy');
        const img = scene?.querySelector<HTMLElement>('.scene-image');
        if (!scene || !copy || !img) return;

        const prev = i === 0 ? cityScene : root.querySelector<HTMLElement>(`[data-scene="${chapters[i - 1].id}"]`);

        if (!prev) return;

        tl.to(scene, { autoAlpha: 1, pointerEvents: 'auto', duration: 0.52 }, cursor)
          .fromTo(img, { scale: 1.055, xPercent: i % 2 ? 1.3 : -1.3 }, { scale: 1.015, xPercent: 0, duration: 0.9 }, cursor)
          .to(copy, { y: 0, autoAlpha: 1, duration: 0.52, ease: 'power2.out' }, cursor + 0.18)
          .to(prev, { autoAlpha: 0, pointerEvents: 'none', duration: 0.5 }, cursor + 0.18);

        if (chapter.id === 'installation') {
          tl.to(img, { scale: 1.035, duration: 0.55 }, cursor + 0.82);
        }
        if (chapter.id === 'proof') {
          tl.fromTo('.proof-transfer', { x: 26, autoAlpha: 0 }, { x: 0, autoAlpha: 1, duration: 0.4, ease: 'power2.out' }, cursor + 0.42);
        }
        if (chapter.id === 'ops') {
          tl.fromTo('.ops-panel', { scale: 0.94, autoAlpha: 0 }, { scale: 1, autoAlpha: 1, duration: 0.45, ease: 'power2.out' }, cursor + 0.46);
        }

        tl.to(copy, { y: -18, autoAlpha: 0, duration: 0.42 }, cursor + 1.04)
          .to(img, { scale: 1.045, duration: 0.65 }, cursor + 0.85);
        cursor += 1.18;
      });

      const last = root.querySelector<HTMLElement>(`[data-scene="${chapters[chapters.length - 1]?.id}"]`);
      if (!last) return;
      tl.to(finalScene, { autoAlpha: 1, pointerEvents: 'auto', duration: 0.75 }, cursor)
        .fromTo(finalImage, { scale: 1.09 }, { scale: 1, duration: 1.05 }, cursor)
        .to(last, { autoAlpha: 0, pointerEvents: 'none', duration: 0.55 }, cursor + 0.18)
        .fromTo(finalUi, { y: 12, autoAlpha: 0 }, { y: 0, autoAlpha: 1, duration: 0.4, ease: 'power2.out' }, cursor + 0.7)
        .to(finalScene, { scale: 0.985, duration: 0.4 }, cursor + 1.25);

      // Initial content reveal is time-based but restrained.
      gsap.fromTo('.intro-reveal', { y: 24, autoAlpha: 0 }, {
        y: 0, autoAlpha: 1, duration: 0.9, stagger: 0.12, ease: 'power3.out', delay: 0.15,
      });

      ScrollTrigger.refresh();
    }, root);

    return () => ctx.revert();
  }, []);

  useLayoutEffect(() => {
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduceMotion) return;
    const ctx = gsap.context(() => {
      const groups = [
        '.value-heading-row', '.value-card', '.value-flow',
        '.proof-chain-copy', '.proof-stage-visual',
        '.section-heading', '.capability-grid article',
        '.team-intro', '.team-list > div',
        '.why-header', '.why-grid article', '.faq-layout > div',
        '.closing-inner > *'
      ];
      groups.forEach((selector) => {
        gsap.utils.toArray<HTMLElement>(selector).forEach((el, index) => {
          gsap.fromTo(el, { y: 28, autoAlpha: 0 }, {
            y: 0, autoAlpha: 1, duration: .82, delay: Math.min(index * .035, .18), ease: 'power3.out',
            scrollTrigger: { trigger: el, start: 'top 88%', once: true }
          });
        });
      });
    });
    return () => ctx.revert();
  }, []);

  const scrollToJourney = (id: string) => {
    setMobileNav(false);
    const index = sceneIds.indexOf(id);
    const ratio = index <= 0 ? 0 : index / Math.max(1, sceneIds.length - 1);
    const root = journeyRef.current;
    if (!root) return;
    const max = root.offsetHeight - window.innerHeight;
    gsap.to(window, { scrollTo: root.offsetTop + max * ratio, duration: 1.25, ease: 'power3.inOut' });
  };

  const tiltMove = (event: ReactPointerEvent<HTMLElement>) => {
    if (window.matchMedia('(pointer: coarse)').matches) return;
    const el = event.currentTarget;
    const r = el.getBoundingClientRect();
    const x = (event.clientX - r.left) / r.width - 0.5;
    const y = (event.clientY - r.top) / r.height - 0.5;
    el.style.setProperty('--tilt-x', `${(-y * 4).toFixed(2)}deg`);
    el.style.setProperty('--tilt-y', `${(x * 5).toFixed(2)}deg`);
    el.style.setProperty('--glow-x', `${((x + 0.5) * 100).toFixed(1)}%`);
    el.style.setProperty('--glow-y', `${((y + 0.5) * 100).toFixed(1)}%`);
  };

  const tiltLeave = (event: ReactPointerEvent<HTMLElement>) => {
    const el = event.currentTarget;
    el.style.setProperty('--tilt-x', '0deg');
    el.style.setProperty('--tilt-y', '0deg');
  };

  return (
    <main className="landing-page">
      <nav className={`landing-nav ${activeChapter === 'intro' ? 'landing-nav--sky' : ''}`} aria-label="Main navigation">
        <button className="nav-logo" onClick={() => scrollToJourney('intro')} aria-label="AdRoute home"><AdRouteMark /></button>
        <div className="landing-nav__links">
          <button onClick={() => scrollToJourney('survey')}>How it works</button>
          <button onClick={() => scrollToJourney('production')}>Inside AdRoute</button>
          <a href="#why-adroute">Why AdRoute</a>
          <a href="#team">For your team</a>
          <a href="#platform">Platform</a>
        </div>
        <div className="landing-nav__actions">
          <Link to="/login" className="nav-signin">Sign in</Link>
          <a href="#contact" className="nav-demo">Book a demo <ArrowRight size={14} /></a>
        </div>
        <button className="nav-menu" onClick={() => setMobileNav((v) => !v)} aria-label="Toggle navigation">{mobileNav ? <X /> : <Menu />}</button>
        {mobileNav && (
          <div className="mobile-nav-panel">
            <button onClick={() => scrollToJourney('survey')}>How it works</button>
            <button onClick={() => scrollToJourney('production')}>Inside AdRoute</button>
            <a href="#why-adroute" onClick={() => setMobileNav(false)}>Why AdRoute</a>
            <a href="#team" onClick={() => setMobileNav(false)}>For your team</a>
            <a href="#platform" onClick={() => setMobileNav(false)}>Platform</a>
            <Link to="/login">Sign in</Link>
            <a className="mobile-nav-panel__primary" href="#contact" onClick={() => setMobileNav(false)}>Book a demo</a>
          </div>
        )}
      </nav>

      <section className="cinematic-journey" ref={journeyRef} aria-label="AdRoute connected operations journey">
        <div className="cinematic-pin" ref={pinRef}>
          <div className="journey-scene journey-scene--intro" data-scene="intro">
            <img className="intro-city-bg" src={images.city} alt="" aria-hidden="true" />
            <div className="intro-city-depth" aria-hidden="true" />
            <video
              className="cloud-video cloud-video--base"
              autoPlay
              muted
              loop
              playsInline
              preload="auto"
              poster={images.city}
              aria-hidden="true"
              onEnded={(event) => {
                event.currentTarget.currentTime = 0;
                void event.currentTarget.play();
              }}
            >
              <source src={`${A}/clouds.mp4`} type="video/mp4" />
            </video>
            <div className="intro-shade" />
            <div className="intro-content">
              <p className="intro-eyebrow intro-reveal">OUTDOOR BRANDING OPERATIONS <i /> CONNECTED END TO END</p>
              <h1 className="intro-reveal">From site to invoice.<br /><em>One connected operation.</em></h1>
              <p className="intro-support intro-reveal">Connect survey, design, production, installation proof, live operations and client visibility in one workflow built for outdoor branding teams.</p>
              <div className="intro-actions intro-reveal">
                <button onClick={() => scrollToJourney('survey')}>Explore the operation <ArrowDown size={15} /></button>
                <a href="#contact">Book a demo <ArrowRight size={15} /></a>
              </div>
              <div className="intro-ecosystem intro-reveal" aria-label="AdRoute connects field sites, agency operations and clients">
                <span><b>01</b><strong>Field site</strong><small>Survey · Install · Proof</small></span>
                <i />
                <span><b>02</b><strong>Agency</strong><small>Design · Produce · Operate</small></span>
                <i />
                <span><b>03</b><strong>Client</strong><small>Progress · Proof · Reports</small></span>
              </div>
            </div>
            <div className="scroll-hint intro-reveal"><span>SCROLL TO EXPLORE</span><i /></div>
          </div>

          <div className="journey-scene journey-scene--city" data-scene="city">
            <img className="scene-image" src={images.city} alt="AdRoute connected city with field site, agency and client locations" />
            <div className="city-atmosphere" />
            <div className="city-context">
              <span>ONE CITY · THREE OPERATING WORLDS</span>
              <p>Field site, agency operations and client visibility—connected by the same job context.</p>
            </div>
          </div>

          {chapters.map((chapter) => (
            <article className={`journey-scene journey-scene--chapter journey-scene--${chapter.id}`} data-scene={chapter.id} key={chapter.id}>
              <img className="scene-image" src={chapter.image} alt={`${chapter.eyebrow}: ${chapter.title}`} style={{ objectPosition: chapter.position }} />
              <div className="scene-grade" />
              <ChapterCopy chapter={chapter} />
              <ProcessOverlay id={chapter.id} />
              {chapter.id === 'installation' && <div className="match-cut-label" aria-hidden="true">SAME SITE · WORK IN PROGRESS</div>}
              {chapter.id === 'proof' && <div className="match-cut-label match-cut-label--verified" aria-hidden="true"><Check size={13} /> SAME SITE · VERIFIED</div>}
            </article>
          ))}

          <section className="journey-scene final-city" data-scene="final" aria-label="Connected city summary">
            <img className="scene-image" src={images.final} alt="Connected AdRoute city flow from field site to agency operations to client" />
            <div className="final-city__ambient" />
            <svg className="flow-lines" viewBox="0 0 1000 562" preserveAspectRatio="none" aria-hidden="true">
              <path d="M215 371 C315 280, 390 230, 460 191" />
              <path d="M460 191 C600 126, 700 116, 820 135" />
            </svg>
            {finalNodes.map((node) => (
              <div key={node.id} className={`city-node city-node--${node.id}`} style={{ left: `${node.x}%`, top: `${node.y}%` }}>
                <button
                  aria-expanded={openNode === node.id}
                  aria-label={`Explore ${node.label}`}
                  onMouseEnter={() => setOpenNode(node.id)}
                  onMouseLeave={() => setOpenNode(null)}
                  onFocus={() => setOpenNode(node.id)}
                  onBlur={() => setOpenNode(null)}
                  onClick={() => setOpenNode((v) => v === node.id ? null : node.id)}
                  onKeyDown={(e) => { if (e.key === 'Escape') setOpenNode(null); }}
                ><i /><span /></button>
                <div className={`city-node__card ${openNode === node.id ? 'is-open' : ''}`}>
                  <small>{node.label}</small>
                  <p>{node.body}</p>
                  <div>{node.tags.map((tag) => <span key={tag}>{tag}</span>)}</div>
                </div>
              </div>
            ))}
            <div className="final-city__hint"><span>EXPLORE THE CONNECTED CITY</span><small>Hover or tap a location</small></div>
          </section>

          <div className="journey-rail" aria-label="Jump to a stage">
            {[{ id: 'intro', label: 'Start' }, ...chapters.map((c) => ({ id: c.id, label: c.eyebrow })), { id: 'final', label: 'Connected city' }].map((item) => (
              <button key={item.id} className={activeChapter === item.id ? 'is-active' : ''} onClick={() => scrollToJourney(item.id)} aria-label={`Go to ${item.label}`}>
                <i /><span>{item.label}</span>
              </button>
            ))}
          </div>
          <div className="hero-progress" aria-hidden="true"><span className="hero-progress__fill" /></div>
          <div className="chapter-indicator" aria-hidden="true">
            <span>{activeChapter === 'intro' ? '00' : activeChapter === 'city' ? '—' : chapters.find((c) => c.id === activeChapter)?.no ?? '09'}</span>
            <b>{activeChapter === 'intro' ? 'INTRO' : activeChapter === 'city' ? 'THE OPERATING WORLD' : activeChapter === 'final' ? 'CONNECTED CITY' : chapters.find((c) => c.id === activeChapter)?.eyebrow}</b>
          </div>
          <div className={`journey-complete ${heroComplete ? 'is-visible' : ''}`} aria-hidden="true"><ChevronRight size={13} /> Continue</div>
        </div>
      </section>

      <div className="post-hero-bridge" />

      <section className="value-section" id="why-adroute" aria-labelledby="value-heading">
        <div className="section-shell">
          <div className="value-kicker">WHY ADROUTE</div>
          <div className="value-heading-row">
            <h2 id="value-heading">One operational record.<br />Two sides of the same campaign.</h2>
            <p>AdRoute is not only a field app and not only a client portal. It is the shared operating layer between the agency doing the work and the client paying for the outcome.</p>
          </div>
          <div className="value-columns">
            <article className="value-card value-card--agency premium-tilt" onPointerMove={tiltMove} onPointerLeave={tiltLeave}>
              <span>FOR THE AGENCY</span>
              <h3>Run execution without losing control between teams.</h3>
              <p>Turn field inputs into design and production work, coordinate installation, verify proof and keep every site moving toward billing readiness.</p>
              <ul><li>Survey-to-production continuity</li><li>Site-level ownership and status</li><li>Materials, proof and verification in context</li><li>Live operational visibility across campaigns</li></ul>
              <button onClick={() => scrollToJourney('production')}>See agency operations <ArrowRight size={14} /></button>
            </article>
            <article className="value-card value-card--client premium-tilt" onPointerMove={tiltMove} onPointerLeave={tiltLeave}>
              <span>FOR THE CLIENT</span>
              <h3>See what is happening without chasing for updates.</h3>
              <p>Give clients a clear campaign view with verified progress, completed locations, installation photos and reporting grounded in real field activity.</p>
              <ul><li>Campaign progress at a glance</li><li>Verified completed-site proof</li><li>Clear review and reporting trail</li><li>More confidence in completion and billing</li></ul>
              <button onClick={() => scrollToJourney('client')}>See client visibility <ArrowRight size={14} /></button>
            </article>
          </div>
          <div className="value-flow" aria-label="AdRoute workflow summary">
            {['Survey','Design','Production','Installation','Proof','Verification','Client visibility','Billing readiness'].map((item, i) => <span key={item}><b>{String(i+1).padStart(2,'0')}</b>{item}</span>)}
          </div>
        </div>
      </section>

      <section className="proof-chain-section" aria-labelledby="proof-chain-heading">
        <div className="section-shell proof-chain-shell">
          <div className="proof-chain-copy">
            <p>THE VERIFICATION CHAIN</p>
            <h2 id="proof-chain-heading">From a field photo to evidence everyone can trust.</h2>
            <span>AdRoute keeps the same completion record intact as it moves from installer to operations to client review.</span>
            <div className="proof-stage-tabs" role="tablist" aria-label="Verification stages">
              {proofStages.map((stage) => (
                <button key={stage.id} role="tab" aria-selected={proofStage === stage.id} className={proofStage === stage.id ? 'is-active' : ''} onClick={() => setProofStage(stage.id)}>
                  <b>{stage.no}</b><span><small>{stage.label}</small>{stage.title}</span><ArrowRight size={15} />
                </button>
              ))}
            </div>
          </div>
          <div className="proof-stage-visual premium-tilt" onPointerMove={tiltMove} onPointerLeave={tiltLeave}>
            {proofStages.map((stage) => (
              <figure key={stage.id} className={proofStage === stage.id ? 'is-active' : ''}>
                <img src={stage.image} alt={`${stage.label}: ${stage.title}`} />
                <figcaption>
                  <small>{stage.label}</small>
                  <strong>{stage.title}</strong>
                  <p>{stage.body}</p>
                  <div>{stage.meta.map((m) => <span key={m}><Check size={11} />{m}</span>)}</div>
                </figcaption>
              </figure>
            ))}
            <div className="proof-stage-chrome" aria-hidden="true"><span>ADROUTE · VERIFIED WORKFLOW</span><i /></div>
          </div>
        </div>
      </section>

      <section className="platform-section" id="platform">
        <div className="section-shell">
          <div className="section-heading">
            <p>THE PLATFORM</p>
            <h2>Operational control without operational clutter.</h2>
            <span>AdRoute keeps the physical work and the digital record connected from the first site visit through reporting.</span>
          </div>
          <div className="capability-grid">
            {capabilityItems.map(({ icon: Icon, title, body }, i) => (
              <article key={title}>
                <div className="capability-grid__index">0{i + 1}</div>
                <Icon size={21} strokeWidth={1.6} />
                <h3>{title}</h3>
                <p>{body}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="team-section" id="team">
        <div className="section-shell team-layout">
          <div className="team-intro">
            <p>YOUR TEAM</p>
            <h2>One workflow. Clear context for every role.</h2>
            <span>The handoff changes. The job record does not.</span>
          </div>
          <div className="team-list">
            {team.map(([role, desc], i) => (
              <div key={role}><span>0{i + 1}</span><strong>{role}</strong><p>{desc}</p><ArrowRight size={16} /></div>
            ))}
          </div>
        </div>
      </section>

      <section className="why-section" aria-labelledby="why-heading">
        <div className="section-shell">
          <div className="why-header"><p>THE ADROUTE DIFFERENCE</p><h2 id="why-heading">Designed around the physical work—not around generic tasks.</h2><span>Outdoor branding is distributed, site-specific and proof-driven. AdRoute keeps the operational record attached to the real location from first measurement to client review.</span></div>
          <div className="why-grid">
            <article className="premium-tilt" onPointerMove={tiltMove} onPointerLeave={tiltLeave}><b>01</b><h3>One site record, not scattered handoffs.</h3><p>Measurements, creative context, production status, installation and proof remain tied to the same location.</p></article>
            <article className="premium-tilt" onPointerMove={tiltMove} onPointerLeave={tiltLeave}><b>02</b><h3>Proof has context.</h3><p>Completed-site photos stay connected to site identity, field activity and verification instead of becoming loose files in chat threads.</p></article>
            <article className="premium-tilt" onPointerMove={tiltMove} onPointerLeave={tiltLeave}><b>03</b><h3>Agency control and client clarity.</h3><p>Operations teams manage execution while clients see a cleaner view of verified progress and completed work.</p></article>
            <article className="premium-tilt" onPointerMove={tiltMove} onPointerLeave={tiltLeave}><b>04</b><h3>Designed for multi-site campaigns.</h3><p>The workflow is structured for many locations, roles and stages without losing visibility into what is blocked, active or complete.</p></article>
          </div>
          <div className="public-page-links" aria-label="Learn more about AdRoute">
            <Link to="/for-agencies">For agencies <ArrowRight size={14}/></Link>
            <Link to="/for-clients">For clients <ArrowRight size={14}/></Link>
            <Link to="/how-it-works">How AdRoute works <ArrowRight size={14}/></Link>
          </div>
        </div>
      </section>

      <section className="faq-section" aria-labelledby="faq-heading">
        <div className="section-shell faq-layout">
          <div><p>COMMON QUESTIONS</p><h2 id="faq-heading">Understand AdRoute before the demo.</h2></div>
          <div className="faq-list">
            <details><summary>What is AdRoute?</summary><p>AdRoute is an operations platform for outdoor advertising, signage and field-branding agencies. It connects site survey, design and production, installation, verified proof, live operations, client visibility, reporting and billing readiness.</p></details>
            <details><summary>Who uses AdRoute?</summary><p>Agency owners and operations teams use it to coordinate work; surveyors and installers use field workflows; designers and production teams work from site-linked context; clients receive visibility into verified campaign progress.</p></details>
            <details><summary>How does AdRoute help clients?</summary><p>Clients can review campaign progress, completed sites, verified installation photos and reporting without relying on repeated manual update requests.</p></details>
            <details><summary>Does AdRoute replace the agency?</summary><p>No. The agency remains the team executing the campaign. AdRoute is the connected operational system that helps the agency coordinate execution and give clients reliable visibility.</p></details>
          </div>
        </div>
      </section>

      <section className="closing-section" id="contact">
        <div className="closing-glow" />
        <div className="section-shell closing-inner">
          <AdRouteMark />
          <p>FROM SITE TO INVOICE</p>
          <h2>Run every site from<br />one connected system.</h2>
          <span>Bring field teams, production, operations and clients into one workflow built for outdoor branding.</span>
          <div className="closing-actions">
            <Link to="/login">Book a demo <ArrowRight size={16} /></Link>
            <Link to="/login">Sign in</Link>
          </div>
          <div className="closing-rule"><span>FIELD</span><i /><span>AGENCY</span><i /><span>CLIENT</span></div>
        </div>
      </section>
    </main>
  );
}

export default LandingPage;
