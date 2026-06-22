import express, {
  type Express,
  type NextFunction,
  type Request,
  type Response,
  type Router,
} from 'express';

import { createActionRouter, type ActionRouteServices } from './api/actionRoutes.js';
import { createReadRouter } from './api/readRoutes.js';
import type { AppConfig } from './config/env.js';
import { createRepositories, type Repositories } from './db/repositories/index.js';
import type { IncidentSummarizer } from './incident/incidentSummary.js';
import type { ProtocolReserveReader } from './protocol/protocolReserve.js';

/** Optional dependencies for {@link createApp}; injectable for tests. */
export interface CreateAppDeps {
  /**
   * Repository bundle the REST routes read from. Defaults to the
   * Postgres-backed repositories, constructed lazily on the first `/api`
   * request so health-only callers never open a connection. Tests inject
   * in-memory fakes.
   */
  repositories?: Repositories;

  /**
   * Service ports the action endpoints (task 13.2) delegate to (risk engine,
   * action executor, evidence service, simulator). Injected as narrow ports so
   * tests use fakes — no live RPC/DB/Walrus. A missing port causes its endpoint
   * to respond 503; validation and rate limiting still apply. (Req 15.2)
   */
  actionServices?: ActionRouteServices;

  /** Optional AI incident summarizer surfaced on incident read endpoints. */
  incidentSummarizer?: IncidentSummarizer;

  /**
   * Optional reader for a real Sui lending protocol's live reserves. When
   * present, the risk endpoint anchors its impact figures to genuine on-chain
   * capital. Injected as a narrow port so tests use a fake (no network).
   */
  protocolReserve?: ProtocolReserveReader;
}

/**
 * Build the Express application.
 *
 * Wires JSON parsing, a health endpoint, and the REST read routes (Req 15.1).
 * The read routes live in their own router (`./api/readRoutes`) and are mounted
 * under `/api`; the action routes (task 13.2) mount a second router on the same
 * app without colliding with this one.
 */
export function createApp(config: AppConfig, deps: CreateAppDeps = {}): Express {
  const app = express();

  app.use(express.json());

  // CORS: the dashboard frontend (Astro dev server on a different port, or a
  // static deployment on another origin) calls this API from the browser. The
  // API is public read + wallet-signed writes with no cookies, so reflecting
  // the request origin is safe for the demo. Preflight requests short-circuit.
  app.use((req: Request, res: Response, next: NextFunction) => {
    const origin = req.header('origin');
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Content-Type, x-wallet-address',
    );
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  // Mount the read router under `/api`. The router (and its repositories) is
  // built lazily on first use: when fakes are injected they are used directly;
  // otherwise the Postgres-backed bundle is created on demand so health-only
  // callers don't trigger a database connection.
  let readRouter: Router | undefined;
  app.use('/api', (req: Request, res: Response, next: NextFunction) => {
    if (readRouter === undefined) {
      const repositories = deps.repositories ?? createRepositories();
      readRouter = createReadRouter({
        repositories,
        incidentSummarizer: deps.incidentSummarizer,
        protocolReserve: deps.protocolReserve,
      });
    }
    readRouter(req, res, next);
  });

  // Mount the action router (task 13.2) as a SECOND router on `/api`, AFTER the
  // read router. Matched read routes (GET) respond and never reach this router;
  // unmatched requests fall through here, so the configurable rate limiter and
  // action validation apply to the action endpoints (Req 15.2, 15.4, 15.5, 4.9)
  // without rate-limiting the read endpoints.
  let actionRouter: Router | undefined;
  app.use('/api', (req: Request, res: Response, next: NextFunction) => {
    if (actionRouter === undefined) {
      actionRouter = createActionRouter({
        rateLimit: { max: config.rateLimitMax, windowMs: config.rateLimitWindowMs },
        services: deps.actionServices,
      });
    }
    actionRouter(req, res, next);
  });

  // Liveness/readiness probe. Reports the active network mode so operators can
  // confirm Sentinel is bound to Sui Testnet. (Requirement 1)
  app.get('/health', (_req: Request, res: Response) => {
    res.json({
      status: 'ok',
      service: 'sentinel-backend',
      network: 'sui:testnet',
      nodeEnv: config.nodeEnv,
    });
  });

  return app;
}
