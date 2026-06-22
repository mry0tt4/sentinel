import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// Component test runner for the React islands. Standalone Vite + React config
// (independent of the Astro build pipeline) renders components with Testing
// Library inside a jsdom environment.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./vitest.setup.ts'],
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
  },
});
