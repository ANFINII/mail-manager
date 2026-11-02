import { defineConfig } from 'vitest/config';
import { srcAlias } from './vite.shared';

export default defineConfig({
  resolve: { alias: srcAlias },
  test: {
    include: ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    environment: 'node',
    pool: 'forks',
  },
});
