import { defineConfig } from 'vite';
import { nodeExternals, srcAlias } from './vite.shared';

export default defineConfig({
  build: { rollupOptions: { external: nodeExternals }, sourcemap: true, target: 'node24' },
  resolve: { alias: srcAlias },
});
