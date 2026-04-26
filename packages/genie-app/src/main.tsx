import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { cssVars } from '../lib/theme';
import { App } from './App';

// Apply Genie design tokens to :root so index.html's var(--genie-*) resolve.
const docRoot = document.documentElement;
for (const [name, value] of Object.entries(cssVars)) {
  docRoot.style.setProperty(name, value);
}

const root = document.getElementById('root');
if (!root) throw new Error('Root element not found');
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
