import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  resolve: { preserveSymlinks: true },
  build: {
    rollupOptions: {
      input: { study: 'index.html', widget: 'widget.html' },
      output: {
        manualChunks: { 'three-engine': ['three'] },
      },
    },
  },
});
