/**
 * Configurable in-memory rate limiter (Req 15.5).
 *
 * A small, dependency-free fixed-window limiter: each client key gets at most
 * `max` requests per `windowMs`; the window resets `windowMs` after the first
 * request in that window. Excess requests are rejected with HTTP 429 and a
 * descriptive body. State is held in-process so tests can drive it
 * deterministically by sending requests with a small `max` (and, optionally, an
 * injected `now` clock). (Req 15.5)
 *
 * The limiter is intentionally injectable/configurable: {@link createRateLimiter}
 * takes the bound (`max` / `windowMs`) from app config, an optional clock, and
 * an optional client-key extractor, so the same middleware works in production
 * (keyed by wallet/IP, real clock) and in tests (deterministic clock/key).
 */

import type { NextFunction, Request, RequestHandler, Response } from 'express';

/** Header used to identify the calling wallet (mirrors the read routes). */
export const WALLET_ADDRESS_HEADER = 'x-wallet-address';

/** Options controlling a {@link createRateLimiter} instance. */
export interface RateLimiterOptions {
  /** Maximum requests allowed per window (from config `rateLimitMax`). */
  max: number;
  /** Window length in milliseconds (from config `rateLimitWindowMs`). */
  windowMs: number;
  /** Clock injection point; defaults to {@link Date.now}. */
  now?: () => number;
  /**
   * Derive the throttling key from a request. Defaults to the wallet header,
   * then the request IP, then a constant fallback so absent identity still
   * shares one bucket rather than bypassing the limit.
   */
  keyOf?: (req: Request) => string;
}

interface WindowState {
  count: number;
  resetAt: number;
}

/** Default client-key extractor: wallet header → request IP → 'anonymous'. */
export function defaultRateLimitKey(req: Request): string {
  const wallet = req.header(WALLET_ADDRESS_HEADER);
  if (wallet !== undefined && wallet.trim() !== '') {
    return `wallet:${wallet.trim()}`;
  }
  const ip = req.ip ?? req.socket?.remoteAddress;
  return ip !== undefined && ip !== '' ? `ip:${ip}` : 'anonymous';
}

/**
 * Build a configurable fixed-window rate-limiting middleware. When `max <= 0`
 * the limiter is effectively disabled (every request passes) so an operator can
 * turn it off via config without removing the middleware.
 */
export function createRateLimiter(options: RateLimiterOptions): RequestHandler {
  const now = options.now ?? Date.now;
  const keyOf = options.keyOf ?? defaultRateLimitKey;
  const { max, windowMs } = options;
  const buckets = new Map<string, WindowState>();

  return (req: Request, res: Response, next: NextFunction): void => {
    if (max <= 0) {
      next();
      return;
    }

    const key = keyOf(req);
    const ts = now();
    const existing = buckets.get(key);

    if (existing === undefined || ts >= existing.resetAt) {
      buckets.set(key, { count: 1, resetAt: ts + windowMs });
      next();
      return;
    }

    if (existing.count >= max) {
      const retryAfterMs = Math.max(0, existing.resetAt - ts);
      res.setHeader('Retry-After', Math.ceil(retryAfterMs / 1000).toString());
      res.status(429).json({
        error: 'rate_limited',
        message: `Rate limit of ${max} requests per ${windowMs}ms exceeded; retry in ${retryAfterMs}ms`,
        limit: max,
        windowMs,
        retryAfterMs,
      });
      return;
    }

    existing.count += 1;
    next();
  };
}
