// Single source of truth for the Sentinel backend base URL + WebSocket URL.
//
// Why this exists: `PUBLIC_BACKEND_URL` / `PUBLIC_WS_URL` are *build-time*
// values (Astro/Vite inlines `import.meta.env.*` into the bundle). On Vercel
// they must be set as project env vars AND the site rebuilt. If they're missing
// — or a local `.env` value like `http://localhost:4000` leaks into a prod
// build — the deployed site ends up calling `localhost`, which fails with
// ERR_CONNECTION_REFUSED in the visitor's browser.
//
// To make the deployment resilient regardless of dashboard config, production
// builds fall back to the known deployed backend (see DEPLOY.md) and refuse to
// use a localhost URL. Development keeps using the local backend / Vite proxy.

/** Deployed backend (Oracle VM behind Caddy). Matches DEPLOY.md Step 2/8. */
export const PRODUCTION_BACKEND_URL = 'https://sentinel-backend.duckdns.org';

/** Deployed backend WebSocket endpoint (note the required `/ws` suffix). */
export const PRODUCTION_WS_URL = 'wss://sentinel-backend.duckdns.org/ws';

/** True when this bundle was produced by `astro build` (production). */
function isProdBuild(): boolean {
  return typeof import.meta !== 'undefined' && import.meta.env?.PROD === true;
}

/** Whether a URL points at the local machine — useless from a visitor's browser. */
export function isLocalhostUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  return /\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)(:|\/|$)/i.test(url);
}

function readEnv(key: 'PUBLIC_BACKEND_URL' | 'PUBLIC_WS_URL'): string | undefined {
  if (typeof import.meta === 'undefined') return undefined;
  const value = import.meta.env?.[key];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/**
 * Resolve the REST base URL (no trailing slash). The API clients append
 * `/api/...` to this.
 *
 * - Production build: use an explicit non-localhost `PUBLIC_BACKEND_URL`, else
 *   fall back to {@link PRODUCTION_BACKEND_URL}. A localhost value is ignored so
 *   the deployed site never tries to reach the developer's machine.
 * - Development: honour `PUBLIC_BACKEND_URL` (defaults to localhost via `.env`),
 *   else return `''` for same-origin requests through the Vite dev proxy.
 */
export function resolveBackendBaseUrl(): string {
  const env = readEnv('PUBLIC_BACKEND_URL');
  if (isProdBuild()) {
    if (env && !isLocalhostUrl(env)) return env.replace(/\/$/, '');
    return PRODUCTION_BACKEND_URL;
  }
  return (env ?? '').replace(/\/$/, '');
}

/**
 * Resolve the dashboard WebSocket URL.
 *
 * - Production build: use an explicit non-localhost `PUBLIC_WS_URL`, else fall
 *   back to {@link PRODUCTION_WS_URL}.
 * - Development: honour `PUBLIC_WS_URL`, else derive a same-origin `/ws` URL
 *   from the current page (works behind the Vite dev proxy).
 */
export function resolveWsUrl(): string {
  const env = readEnv('PUBLIC_WS_URL');
  if (isProdBuild()) {
    if (env && !isLocalhostUrl(env)) return env;
    return PRODUCTION_WS_URL;
  }
  if (env) return env;
  if (typeof window !== 'undefined' && window.location) {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${window.location.host}/ws`;
  }
  return 'ws://localhost:8080/ws';
}
