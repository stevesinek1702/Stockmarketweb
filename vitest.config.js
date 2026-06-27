import { defineConfig } from 'vitest/config';

// Lightweight test config for the frontend.
// Pure logic (e.g. the OHLCV adapter) needs no DOM, so we use the node
// environment to keep the harness fast. Tests live under js/__tests__/.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['js/__tests__/**/*.test.js'],
    // `vitest run` (the "test" script) executes once and exits — no watch mode.
    watch: false
  }
});
