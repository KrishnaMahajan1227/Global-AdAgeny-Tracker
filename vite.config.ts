import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { fileURLToPath, URL } from 'node:url';

const buildId = `${Date.now()}`;

function deploymentVersionPlugin(): Plugin {
  return {
    name: 'adroute-deployment-version',
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'version.json',
        source: JSON.stringify({ buildId, builtAt: new Date().toISOString() }),
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
        // Never let the service worker intercept Supabase API/auth/storage/realtime calls —
        // those must always hit the network (or fail explicitly) so data stays consistent.
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.origin.includes('supabase.co') && url.pathname.includes('/storage/'),
            handler: 'NetworkFirst',
            options: {
              cacheName: 'supabase-storage-cache',
              networkTimeoutSeconds: 4,
              expiration: { maxEntries: 200, maxAgeSeconds: 60 * 60 * 24 },
              cacheableResponse: { statuses: [0, 200] },
            },
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
