import { defineConfig } from 'vite';
import { srcAlias } from './vite.shared';

export default defineConfig({
  build: { sourcemap: true },
  resolve: { alias: srcAlias },
});
