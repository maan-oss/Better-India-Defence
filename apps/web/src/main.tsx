import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
// Fonts are bundled (no CDN): installations run air-gapped.
import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import './styles/app.css';
import './styles/operations.css';
import './state/ui';
import { App } from './App';
import { TooltipProvider } from './components/ui';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <TooltipProvider>
      <App />
    </TooltipProvider>
  </StrictMode>,
);
