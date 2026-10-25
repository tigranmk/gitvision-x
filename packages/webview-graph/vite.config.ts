import { svelte } from '@sveltejs/vite-plugin-svelte';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// One ES module + one stylesheet; the host writes the HTML (with its CSP nonce) around them.
export default defineConfig(({ mode }) => ({
  root: fileURLToPath(new URL('.', import.meta.url)),
  // Relative asset URLs: webviews load the bundle from the extension's resource URI, not a server root.
  base: './',
  plugins: [svelte()],
  define: { __DEV__: JSON.stringify(mode !== 'production') },
  build: {
    outDir: fileURLToPath(new URL('../../dist/webviews/graph', import.meta.url)),
    emptyOutDir: true,
    sourcemap: mode !== 'production',
    minify: mode === 'production',
    target: 'es2022',
    cssCodeSplit: false,
    modulePreload: false,
    rollupOptions: {
      input: fileURLToPath(new URL('src/main.ts', import.meta.url)),
      output: { entryFileNames: 'graph.js', assetFileNames: 'graph.[ext]', format: 'es' },
    },
  },
}));
