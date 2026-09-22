import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { PresencePreview } from './PresencePreview.js';
import '../styles.css';
import './preview.css';

// StrictMode on purpose: it mounts, unmounts and remounts every presence on the
// page, which is the cheapest possible test that the renderer survives it.
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <PresencePreview />
  </StrictMode>,
);
