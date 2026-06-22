import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Node environment for backend service code.
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Property-based tests (fast-check) can run many iterations; give them room.
    testTimeout: 20_000,
    globals: false,
  },
});
