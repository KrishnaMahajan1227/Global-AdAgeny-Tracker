import { useEffect } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { ArrowLeft, ArrowRight, Check, ShieldCheck } from 'lucide-react';
import './public-info.css';

const A = '/landing/cinematic';
type PageData = {
  eyebrow: string;
  title: string;
  lead: string;
  titleTag: string;
  description: string;
  image: string;
  imageAlt: string;
  sections: { title: string; body: string; points: string[] }[];
};

const pages: Record<string, PageData> = {
  '/for-agencies': {
    eyebrow: 'ADROUTE FOR AGENCIES',
    title: 'Control every site without turning your operation into a follow-up chain.',
    lead: 'Connect survey, creative context, production, installation, proof and campaign progress while preserving site-level accountability between field and office teams.',
    titleTag: 'AdRoute for Outdoor Advertising & Signage Agencies',
    description: 'Manage outdoor advertising and signage operations from site survey through production, installation proof, client reporting and billing readiness with AdRoute.',
    image: `${A}/07_AdRoute_Agency_Live_Operations.png`,
    imageAlt: 'AdRoute agency operations team reviewing live multi-site campaign activity',
    sections: [
      { title: 'Control the handoffs', body: 'Keep each site attached to the information required by the next team instead of rebuilding context at every stage.', points: ['Site-linked survey records', 'Design and production context', 'Installation progress', 'Verified photo proof'] },
      { title: 'See the operation, not just tasks', body: 'Give owners and operations teams a campaign-level view while preserving the detail needed at each physical location.', points: ['Site status and ownership', 'Field activity visibility', 'Production and dispatch context', 'Completion verification'] },
      { title: 'Move verified work toward reporting', body: 'Turn completed field execution into a reliable operational record that can support client review and billing readiness.', points: ['Proof tied to the correct site', 'Clear completion trail', 'Client-ready campaign visibility', 'Reporting-ready records'] },
    ],
  },
  '/for-clients': {
    eyebrow: 'ADROUTE FOR CLIENTS',
    title: 'Campaign visibility without the repeated status call.',
    lead: 'See verified progress across locations, review completed-site proof and understand campaign status through a client-facing view grounded in real field activity.',
    titleTag: 'AdRoute Client Visibility for Outdoor Branding Campaigns',
    description: 'Give clients clear visibility into outdoor branding campaign progress, completed sites, verified installation photos and reporting with AdRoute.',
    image: `${A}/09_AdRoute_Client_Campaign_Review.png`,
    imageAlt: 'Client team reviewing verified outdoor branding campaign progress in AdRoute',
    sections: [
      { title: 'Know what is complete', body: 'Review progress across campaign locations without depending on manually assembled update messages.', points: ['Campaign overview', 'Completed-site status', 'Verified installations', 'Progress visibility'] },
      { title: 'See proof in context', body: 'Installation photographs stay attached to the site and campaign record so the evidence is easier to review and trust.', points: ['Site-linked proof', 'Installation photos', 'Verification context', 'Location continuity'] },
      { title: 'Review a cleaner campaign record', body: 'Move from scattered images and spreadsheets toward a consistent view of completed work and reporting.', points: ['Proof gallery', 'Campaign review', 'Reports', 'Commercial readiness'] },
    ],
  },
  '/how-it-works': {
    eyebrow: 'HOW ADROUTE WORKS',
    title: 'One operational thread from the first site visit to the final client record.',
    lead: 'AdRoute follows the real sequence of outdoor branding work, connecting the physical site, the agency teams executing the job and the client reviewing the outcome.',
    titleTag: 'How AdRoute Works | Outdoor Branding Operations Workflow',
    description: 'See how AdRoute connects field survey, design, signage production, installation, proof verification, live operations, client visibility and reporting.',
    image: `${A}/10_AdRoute_Connected_Operations_Final_CTA.png`,
    imageAlt: 'Connected AdRoute city showing field site, agency operations and client visibility',
    sections: [
      { title: '01 — Field survey', body: 'Capture measurements, photos, location context and installation requirements at the physical site.', points: ['Measurements', 'Site photos', 'Location context', 'Installation area'] },
      { title: '02 — Agency execution', body: 'Move site context into design, production, materials, quality control, dispatch and field coordination.', points: ['Design and prepress', 'Production and fabrication', 'QC and dispatch', 'Installation coordination'] },
      { title: '03 — Proof to client visibility', body: 'Capture completed work, verify the site and make campaign progress available for operations and client review.', points: ['Photo proof', 'Verification', 'Live operations', 'Client reporting'] },
    ],
  },
};

export default function PublicInfoPage() {
  const { pathname } = useLocation();
  const d = pages[pathname] || pages['/how-it-works'];

  useEffect(() => {
    document.title = `${d.titleTag} | AdRoute`;
    let m = document.querySelector<HTMLMetaElement>('meta[name="description"]');
    if (!m) { m = document.createElement('meta'); m.name = 'description'; document.head.appendChild(m); }
    m.content = d.description;
    const setOg = (property: string, content: string) => {
      let tag = document.head.querySelector<HTMLMetaElement>(`meta[property="${property}"]`);
      if (!tag) { tag = document.createElement('meta'); tag.setAttribute('property', property); document.head.appendChild(tag); }
      tag.content = content;
    };
    setOg('og:title', `${d.titleTag} | AdRoute`);
    setOg('og:description', d.description);
    setOg('og:type', 'website');
    window.scrollTo(0, 0);
  }, [d]);

  return (
    <main className="public-info">
      <header>
        <Link to="/" className="pi-brand"><span className="pi-brand-mark"><i/><i/><i/></span>AdRoute</Link>
        <nav>
          <Link to="/how-it-works">How it works</Link>
          <Link to="/for-agencies">For agencies</Link>
          <Link to="/for-clients">For clients</Link>
          <Link to="/login" className="pi-signin">Sign in</Link>
        </nav>
      </header>

      <section className="pi-hero">
        <div className="pi-hero-copy">
          <Link to="/" className="pi-back"><ArrowLeft size={14}/> Back to experience</Link>
          <p>{d.eyebrow}</p>
          <h1>{d.title}</h1>
          <span>{d.lead}</span>
          <div className="pi-actions">
            <Link className="pi-cta" to="/#contact">Book a demo <ArrowRight size={15}/></Link>
            <Link className="pi-text-link" to="/how-it-works">Explore the workflow <ArrowRight size={14}/></Link>
          </div>
        </div>
        <figure className="pi-hero-visual">
          <img src={d.image} alt={d.imageAlt}/>
          <figcaption><ShieldCheck size={14}/><span>FIELD ACTIVITY</span><i/><b>CONNECTED TO THE JOB RECORD</b></figcaption>
        </figure>
      </section>

      <section className="pi-proofbar" aria-label="AdRoute workflow">
        {['Survey', 'Design', 'Production', 'Installation', 'Proof', 'Verification', 'Client visibility'].map((x, i) => <span key={x}><b>{String(i + 1).padStart(2, '0')}</b>{x}</span>)}
      </section>

      <section className="pi-sections">
        {d.sections.map((s, i) => (
          <article key={s.title}>
            <b>0{i + 1}</b>
            <div><h2>{s.title}</h2><p>{s.body}</p></div>
            <ul>{s.points.map((x) => <li key={x}><Check size={13}/>{x}</li>)}</ul>
          </article>
        ))}
      </section>

      <section className="pi-next">
        <p>KEEP EXPLORING</p>
        <div>
          {pathname !== '/for-agencies' && <Link to="/for-agencies"><small>FOR AGENCIES</small><strong>See the agency operating layer.</strong><ArrowRight size={18}/></Link>}
          {pathname !== '/for-clients' && <Link to="/for-clients"><small>FOR CLIENTS</small><strong>See the client visibility layer.</strong><ArrowRight size={18}/></Link>}
          {pathname !== '/how-it-works' && <Link to="/how-it-works"><small>THE WORKFLOW</small><strong>See the complete connected journey.</strong><ArrowRight size={18}/></Link>}
        </div>
      </section>

      <footer>
        <strong>AdRoute</strong>
        <span>Field operations · connected end to end</span>
        <Link to="/">Explore the cinematic workflow <ArrowRight size={14}/></Link>
      </footer>
    </main>
  );
}
