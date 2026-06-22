// @ts-check
import { defineConfig } from 'astro/config';
import react from '@astrojs/react';
import vercel from '@astrojs/vercel';

// Sentinel frontend — Astro + TypeScript dApp.
// React islands are used for interactive surfaces (wallet connection via Sui
// dApp Kit, charts, dashboard widgets). Static Astro pages compose the islands.
//
// During development the backend runs on :4000. We proxy `/api` (REST) and
// `/ws` (WebSocket) to it so the browser makes same-origin requests — no CORS,
// and the dashboard data client / risk socket work with their default base URL.
// In production the browser calls the backend directly via PUBLIC_BACKEND_URL /
// PUBLIC_WS_URL (the backend enables CORS), so this proxy is dev-only.
const BACKEND_URL = process.env.PUBLIC_BACKEND_URL || 'http://localhost:4000';
const WS_TARGET = BACKEND_URL.replace(/^http/, 'ws');

export default defineConfig({
  integrations: [react()],
  // Deployed on Vercel: static pages are prerendered to the CDN and the dynamic
  // incident/market routes (prerender = false) run as Vercel serverless
  // functions. (Swap to `@astrojs/node` if self-hosting the frontend instead.)
  adapter: vercel(),
  vite: {
    server: {
      proxy: {
        '/api': { target: BACKEND_URL, changeOrigin: true },
        '/ws': { target: WS_TARGET, ws: true, changeOrigin: true },
      },
    },
    build: {
      rollupOptions: {
        // Silence rollup's "A comment ... annotation that Rollup cannot
        // interpret" notices emitted from third-party deps (e.g. @noble/curves'
        // ed25519.js). They're cosmetic and originate in node_modules, not our
        // code, so they only add noise to an otherwise clean build.
        onwarn(warning, defaultHandler) {
          if (
            warning.code === 'INVALID_ANNOTATION' &&
            (warning.id?.includes('node_modules') || warning.message.includes('node_modules'))
          ) {
            return;
          }
          defaultHandler(warning);
        },
        output: {
          // Split the large, self-contained vendor libraries into their own
          // chunks so no single bundle exceeds the 500 kB warning and the
          // browser can cache them independently. React/react-dom intentionally
          // stay with the app shell to avoid circular vendor chunks.
          manualChunks(id) {
            if (!id.includes('node_modules')) return undefined;
            if (id.includes('@mysten') || id.includes('@noble') || id.includes('@scure')) {
              return 'vendor-sui';
            }
            if (id.includes('recharts') || id.includes('d3-') || id.includes('victory')) {
              return 'vendor-charts';
            }
            if (id.includes('@tanstack')) return 'vendor-query';
            return undefined;
          },
        },
      },
    },
  },
});
