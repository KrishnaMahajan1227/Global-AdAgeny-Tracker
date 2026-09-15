# Darshan Ops — Landing Revamp

This build changes only the public marketing landing experience and its SEO/PWA presentation. Authenticated role routes, dashboards, Supabase flows, APIs, and business logic remain in place.

## Landing implementation
- `/` now renders the public landing page for signed-out visitors; signed-in users still redirect to their existing role home.
- Cinematic “The Descent” flow: city/cloud hero → dealer shop → human site survey → shop-to-agency data flow → agency exterior → production → printing → operations dashboard → agency-to-client flow → client exterior → conference review → connected-city recap.
- GSAP + ScrollTrigger with scrub smoothing; no wheel hijacking.
- Clickable checkpoint rail and persistent progress indicator.
- SVG data-flow arcs and interactive final-city hotspots.
- Real HTML/CSS HUD cards and crawlable recap/value sections.
- Reduced-motion and mobile-specific fallbacks.
- Landing images converted to compact WebP; chroma-key cloud source composited into a lightweight MP4 hero loop.

## QA note
LandingPage.tsx and App.tsx pass TypeScript syntax transpilation checks. A full `npm ci` / Vite build could not be completed in the sandbox because npm registry requests returned temporary DNS `EAI_AGAIN` errors. No dependencies were added; the project keeps its original package.json/package-lock.json. Run `npm ci && npm run typecheck && npm run build` in a normal networked development environment before deployment.
