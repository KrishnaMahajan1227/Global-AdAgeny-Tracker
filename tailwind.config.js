/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        // Landing-page brand palette — kept separate from the in-app
        // slate/blue console theme on purpose (see LandingPage.tsx header
        // comment). "site" = deep night-survey navy, "signal" = the
        // amber/hazard tone used on real hoarding + site-safety signage,
        // "route" = the live-map "in progress" blue already used across
        // the app's status chips.
        site: {
          950: '#070B14',
          900: '#0B1220',
          800: '#121B2E',
          700: '#1B2740',
          600: '#2A3B5C',
        },
        signal: {
          400: '#FFC15C',
          500: '#F2A93B',
          600: '#DA8B1A',
        },
        route: {
          500: '#3E7BFA',
        },
      },
      fontFamily: {
        display: ['"Anton"', 'sans-serif'],
        sans: ['"Inter"', 'system-ui', 'sans-serif'],
        mono: ['"IBM Plex Mono"', 'ui-monospace', 'monospace'],
      },
      backgroundImage: {
        'grid-fade': 'radial-gradient(circle at 1px 1px, rgba(255,255,255,0.06) 1px, transparent 0)',
      },
    },
  },
  plugins: [],
};
