// Must stay first: installs the React Refresh preamble from a module, since
// CSP (script-src 'self') blocks the inline one Vite would inject in dev.
// Resolves to an empty module in production builds.
import '@vitejs/plugin-react/preamble';
import './lib/zod-jitless.ts';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { App } from './App.tsx';
import { createQueryClient } from './lib/queries.ts';
import './styles.css';

const container = document.getElementById('root');
if (!container) throw new Error('#root not found');

createRoot(container).render(
  <StrictMode>
    <QueryClientProvider client={createQueryClient()}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
