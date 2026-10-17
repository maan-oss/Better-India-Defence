import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
// Fonts are bundled (no CDN): installations run air-gapped.
import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import './styles/tw.css';
import './styles/arc-theme.css';
import './styles/app.css';
import './styles/operations.css';
import './brand/brand.css';
import './state/ui';
import { App } from './App';
import { TooltipProvider } from './components/ui';
// Last: the glass layer wins over the surface rules of the component stylesheets it follows.
import './styles/glass.css';
import './styles/interaction.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <TooltipProvider>
      <App />
    </TooltipProvider>
  </StrictMode>,
);
