import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { fileURLToPath, URL } from 'node:url';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
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
        // Precache the app shell (JS/CSS/HTML/icons) so the app opens even with no network.
        globPatterns: ['**/*.{js,css,html,ico,png,svg,webmanifest}'],
        // Default Workbox ceiling is 2 MiB; the main JS chunk now exceeds that
        // (Client Portal added several routes/pages to the same bundle) — raise
        // the ceiling so it still gets precached instead of silently dropped
        // from offline support. Doesn't change anything about what's cached,
        // just stops the build from erroring out / skipping this file.
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
        // Never let the service worker intercept Supabase API/auth/storage/realtime calls —
        // those must always hit the network (or fail explicitly) so data stays consistent.
        navigateFallbackDenylist: [/^\/api\//],
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.origin.includes('supabase.co') && url.pathname.includes('/storage/'),
            handler: 'CacheFirst',
            options: {
              cacheName: 'supabase-storage-cache',
              expiration: { maxEntries: 200, maxAgeSeconds: 60 * 60 * 24 * 30 },
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
        // Enable the service worker during `npm run dev` too, so offline survey mode
        // can be tested locally without a production build.
        enabled: true,
        type: 'module',
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
