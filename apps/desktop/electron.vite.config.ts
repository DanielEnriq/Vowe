import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';

/**
 * The presence preview is a development page, so it is a development input.
 *
 * Built only when this is not a production build: it exists to look at the real
 * component across every state and size, and it has no business in a shipped
 * application where its controls would be controls over nothing.
 */
export default defineConfig(({ mode }) => {
  const rendererInputs: Record<string, string> = {
    index: 'src/renderer/index.html',
  };
  if (mode !== 'production') {
    rendererInputs['presencePreview'] = 'src/renderer/presence-preview.html';
  }

  return {
    main: {
      plugins: [externalizeDepsPlugin()],
      build: { rollupOptions: { input: { index: 'src/main/index.ts' } } },
    },
    preload: {
      plugins: [externalizeDepsPlugin()],
      build: { rollupOptions: { input: { index: 'src/preload/index.ts' } } },
    },
    renderer: {
      root: 'src/renderer',
      plugins: [react()],
      build: { rollupOptions: { input: rendererInputs } },
    },
  };
});
