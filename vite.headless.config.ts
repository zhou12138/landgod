import { defineConfig } from 'vite';
import { builtinModules } from 'node:module';

const nodeExternals = [
  'electron',
  ...builtinModules,
  ...builtinModules.map((m) => `node:${m}`),
  'bufferutil',
  'utf-8-validate',
  'express',
];

export default defineConfig({
  build: {
    outDir: '.vite/build',
    emptyOutDir: false,
    lib: {
      entry: 'src/main/headless-entry.ts',
      formats: ['cjs'],
      fileName: () => 'headless-entry.js',
    },
    rollupOptions: {
      external: nodeExternals,
    },
    minify: false,
    sourcemap: false,
  },
  resolve: {
    conditions: ['node'],
  },
});
