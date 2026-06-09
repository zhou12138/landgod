import { defineConfig } from 'vite';
import { builtinModules } from 'node:module';

const nodeExternals = [
  'electron',
  ...builtinModules,
  ...builtinModules.map((m) => `node:${m}`),
  'bufferutil',
  'utf-8-validate',
  'express',  // Externalize to avoid CJS bundling issues (iconv-lite/raw-body)
];

export default defineConfig(({ command }) => ({
  build: {
    outDir: '.vite/build',
    emptyOutDir: false,
    lib: {
      entry: 'src/main/index.ts',
      formats: ['cjs'],
      fileName: () => 'index.js',
    },
    rollupOptions: {
      external: nodeExternals,
    },
    minify: false,
    sourcemap: false,
  },
  // During electron-forge start (command='serve'), forge injects the real renderer dev
  // server URL into MAIN_WINDOW_VITE_DEV_SERVER_URL — don't override it.
  // For standalone/production builds (command='build'), hardcode undefined so the main
  // process loads the renderer from file instead.
  define: {
    ...(command === 'build' ? { MAIN_WINDOW_VITE_DEV_SERVER_URL: 'undefined' } : {}),
    MAIN_WINDOW_VITE_NAME: '"main_window"',
  },
  resolve: {
    conditions: ['node'],
  },
}));
