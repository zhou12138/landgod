import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    outDir: '.vite/renderer/main_window',
  },
  optimizeDeps: {
    include: ['react', 'react-dom', 'react-dom/client'],
  },
  css: {
    postcss: path.resolve(__dirname, 'postcss.config.js'),
  },
  resolve: {
    alias: {
      '@renderer': path.resolve(__dirname, 'src/renderer'),
    },
  },
});
