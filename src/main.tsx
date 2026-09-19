import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import './index.css';
import { startAppVersionWatcher } from './lib/appVersion';

// Production clients automatically detect a newly deployed build and move to it.
// Development intentionally has no service-worker/version watcher to avoid stale local bundles.
startAppVersionWatcher();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
