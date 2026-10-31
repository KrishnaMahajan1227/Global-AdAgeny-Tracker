import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { fileURLToPath, URL } from 'node:url';
import { APP_RELEASE } from './src/lib/release';

const buildId = `${Date.now()}`;

function deploymentVersionPlugin(): Plugin {
  return {
    name: 'adroute-deployment-version',
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'version.json',
        source: JSON.stringify({ buildId, release: APP_RELEASE, builtAt: new Date().toISOString(), features: { directWorkOrders: true, campaignsModule: false } }),
      });
    },
  };
}

// https://vitejs.dev/config/
export default defineConfig({
  define: {
    'import.meta.env.VITE_APP_BUILD_ID': JSON.stringify(buildId),
  },
  plugins: [
    deploymentVersionPlugin(),
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'auto',
      includeAssets: ['favicon-16x16.png', 'favicon-32x32.png', 'apple-touch-icon.png'],
      manifest: {
        name: 'Darshan Ad Agency — Field Operations',
        short_name: 'Darshan Ops',
        description: 'Field survey, design, production, installation and billing platform for Darshan Ad Agency.',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        orientation: 'portrait-primary',
        background_color: '#0f172a',
        theme_color: '#2563eb',
        icons: [
          { src: '/pwa-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: '/pwa-512x512.png', sizes: '512x512', type: 'image/png' },
          { src: '/maskable-icon-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        skipWaiting: true,
        clientsClaim: true,
        cleanupOutdatedCaches: true,
        navigateFallbackDenylist: [/^\/api\//, /^\/version\.json/],
        // Precache the app shell (JS/CSS/HTML/icons) so the app opens even with no network.
        globPatterns: ['**/*.{js,css,html,ico,png,svg,webmanifest}'],
        // Default Workbox ceiling is 2 MiB; the main JS chunk now exceeds that
        // (Client Portal added several routes/pages to the same bundle) — raise
        // the ceiling so it still gets precached instead of silently dropped
        // from offline support. Doesn't change anything about what's cached,
        // just stops the build from erroring out / skipping this file.
        maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
        // Auth, API and realtime requests are not cached; storage proofs are
        // explicitly network-only to avoid leaving private evidence behind.
        runtimeCaching: [
          // Private survey, artwork and installation proofs MUST NOT be
          // retained by Workbox. On another login, a signed image URL might
          // still be in the browser cache. Field uploads use IndexedDB and
          // a separate retry queue; this rule does not affect that flow.
          {
            urlPattern: ({ url }) => url.origin.endsWith('.supabase.co') && url.pathname.includes('/storage/'),
            handler: 'NetworkOnly',
          },
          {
            urlPattern: ({ url }) => url.origin.includes('maps.googleapis.com'),
            handler: 'StaleWhileRevalidate',
            options: { cacheName: 'google-maps-cache', expiration: { maxEntries: 50, maxAgeSeconds: 60 * 60 * 24 } },
          },
        ],
      },
      devOptions: {
        // Do not register a SW in dev: stale dev caches are a common source of false update issues.
        enabled: false,
      }, 
    }),
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  optimizeDeps: {
    exclude: ['lucide-react'],
  },
});
