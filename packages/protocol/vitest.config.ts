import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The end-to-end flow sends a few dozen transactions to the local node.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
