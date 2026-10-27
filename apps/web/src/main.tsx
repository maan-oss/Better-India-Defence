import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { MotionConfig } from 'motion/react';
import { setNonce } from 'get-nonce';
// Fonts are bundled (no CDN): installations run air-gapped.
import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import './styles/tw.css';
import './styles/defs.css';
import './styles/arc-theme.css';
import './styles/app.css';
import './styles/lists.css';
import './styles/operations.css';
import './brand/brand.css';
import './state/ui';
import { enableLensing, trackGlassLight } from './lib/liquidGlass';
import { App } from './App';
import { TooltipProvider } from './components/ui';
// Last: the glass layer wins over the surface rules of the component stylesheets it follows.
import './styles/glass.css';
import './styles/interaction.css';
import './styles/chrome.css';
import './styles/chrome-surfaces.css';

enableLensing();
trackGlassLight();
// The server sends a nonce with the shell; the animation library uses it for the style elements it writes. The
// placeholder is still there when the page is served by the development server, which has no policy to satisfy.
const cspNonce = document.querySelector<HTMLMetaElement>('meta[name="csp-nonce"]')?.content;
const nonce = cspNonce && cspNonce !== '__CSP_NONCE__' ? cspNonce : undefined;
// Some component libraries write a style element of their own (the scroll-lock of a modal layer); they take the nonce
// from here, so that element is admitted by the policy too.
if (nonce) setNonce(nonce);
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <MotionConfig nonce={nonce}>
      <TooltipProvider>
        <App />
      </TooltipProvider>
    </MotionConfig>
  </StrictMode>,
);
