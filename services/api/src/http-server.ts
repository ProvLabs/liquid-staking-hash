// node:http adapter over the pure `handle(Request)` core. It converts an
// IncomingMessage to a Web `Request`, derives the rate-limit client key, and
// writes the Web `Response` back. Being read-only, it never reads a request
// body — there is nothing a client can POST here.

import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { ApiConfig } from "./config.ts";
import { createHandler, type RequestMeta } from "./handler.ts";
import { RateLimiter } from "./rate-limit.ts";

/**
 * Derive an opaque client key for rate limiting. `x-forwarded-for` is trusted
 * ONLY when `trustProxy` is set (behind a proxy that overwrites it) — otherwise
 * a client could spoof its key by sending the header. Never linked to a wallet
 * address or persisted (SECURITY.md data minimization applies to rate limiting).
 */
export function clientKey(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = req.headers["x-forwarded-for"];
    const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded;
    const first = raw?.split(",")[0]?.trim();
    if (first) return first;
  }
  return req.socket.remoteAddress ?? "unknown";
}

/** A running-server handle with its shared limiter (for sweeping/testing). */
export interface ApiServer {
  readonly server: Server;
  readonly limiter: RateLimiter;
}

/** Build (but do not start) the node:http server for the given config. */
export function createApiServer(config: ApiConfig, now?: () => Date): ApiServer {
  const limiter = new RateLimiter({ max: config.rateLimitMax, windowMs: config.rateLimitWindowMs, ...(now ? { now: () => now().getTime() } : {}) });
  const handle = createHandler({ limiter, appEnv: config.appEnv, ...(now ? { now } : {}) });

  const server = createHttpServer((req: IncomingMessage, res: ServerResponse) => {
    void serve(req, res);
  });

  async function serve(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const host = req.headers.host ?? "localhost";
      const request = new Request(`http://${host}${req.url ?? "/"}`, { method: req.method ?? "GET" });
      const meta: RequestMeta = { clientKey: clientKey(req, config.trustProxy) };
      const response = await handle(request, meta);

      res.statusCode = response.status;
      response.headers.forEach((value, key) => res.setHeader(key, value));
      const body = await response.text();
      res.end(body.length > 0 ? body : undefined);
    } catch {
      // Never leak internals; a handler fault is a 500 with an opaque body.
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader("content-type", "application/json; charset=utf-8");
      }
      res.end(JSON.stringify({ error: { code: "internal", message: "Internal error." } }));
    }
  }

  return { server, limiter };
}
