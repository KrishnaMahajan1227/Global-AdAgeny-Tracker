# Marketing Landing Page

This folder contains the public marketing/landing page for Darshan Ad Agency
(`index.html`) — completely separate from the app (`src/`), which stays a
login-gated internal platform.

## Why it lives here
Vite copies everything inside `public/` into `dist/` untouched at build time.
No config changes, no routing changes to `App.tsx` needed — it just works
alongside your existing app.

## How to view it
- **Dev server:** run `npm run dev`, then open
  `http://localhost:5173/landing/index.html`
- **Production build:** run `npm run build`, then deploy `dist/` as usual —
  the page will be live at `https://yourdomain.com/landing/index.html`

## Making it the homepage (optional)
If you want visitors hitting `https://yourdomain.com/` to see this page
instead of the app's login screen:
1. Move this file to `public/index.html` is **not** safe — it will collide
   with the root `index.html` that boots your React app. Don't do that.
2. Instead, either:
   - Serve the marketing site from a separate subdomain (e.g.
     `www.yourdomain.com`) pointing at this file, and keep the app on
     `app.yourdomain.com`, **or**
   - Ask your developer to add a reverse-proxy / hosting rule so `/`
     serves `public/landing/index.html` and the app moves to `/app`.

## Before going live — replace these placeholders inside `index.html`
- Email: `hello@darshanadagency.com`
- Phone: `+91 00000 00000`
- Registered office address (footer)
- Testimonial quotes (currently illustrative, marked as such)
- Pricing figures (currently indicative)
- `og-cover.jpg` — add a real Open Graph share image and update the URL
  in the `<meta property="og:image">` tag
- `canonical` URL and all `og:url` references — set to your real domain
