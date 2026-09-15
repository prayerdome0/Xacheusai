import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app';
import { Landing } from './views/Landing';
import './styles.css';
import './landing.css';

/**
 * One build, two surfaces:
 *
 *   /          → the public landing page
 *   /console   → the Control Center (auth-gated)
 *
 * The backend and the Vercel rewrites both serve index.html for every
 * non-API path, so a plain client-side path check is all the routing the
 * app needs — no extra dependencies, works behind any host.
 */
const path = window.location.pathname.replace(/\/+$/, '') || '/';
const inConsole = path !== '/';

const container = document.getElementById('root');
if (!container) throw new Error('#root is missing from index.html');

createRoot(container).render(
  <StrictMode>
    {inConsole ? <App /> : <Landing />}
  </StrictMode>,
);
