import { defineConfig } from 'vite';
import { builtinModules } from 'node:module';

const nodeExternals = [
  'electron',
  ...builtinModules,
  ...builtinModules.map((m) => `node:${m}`),
];

export default defineConfig({
  build: {
    outDir: '.vite/build',
    emptyOutDir: false,
    rollupOptions: {
      input: 'src/preload/index.ts',
      external: nodeExternals,
      output: {
        entryFileNames: 'preload.js',
        format: 'cjs',
      },
    },
    minify: false,
    sourcemap: false,
  },
});
