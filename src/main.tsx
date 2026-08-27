import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';
import App from './App.tsx';
import './index.css';

// Register the service worker. autoUpdate silently activates new versions
// on the next load, and onOfflineReady lets us know the app shell is fully
// cached so field workers can open it with zero signal.
registerSW({
  immediate: true,
  onOfflineReady() {
    console.log('App ready to work offline');
  },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
