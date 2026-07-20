// Envelope contract harness (app plan §4 "API contract" layer; standing CI gate
// for services/api from PR 1.2 on). Registry-driven: it iterates the ACTUAL
// route table, so every route now and in the future is held to the same three
// contracts — envelope shape, read-only method gate, and zod query bounds — and
// the harness cannot silently skip a new route.

import { describe, expect, it } from "vitest";
import { API_BASE, routes } from "../src/index.ts";
import { startServer } from "./helpers.ts";

const WRITE_METHODS = ["POST", "PUT", "PATCH", "DELETE"] as const;

function isValidEnvelope(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return "body is not an object";
  const record = body as Record<string, unknown>;
  if (!("data" in record)) return "missing data";
  if (typeof record.meta !== "object" || record.meta === null) return "missing meta";
  const meta = record.meta as Record<string, unknown>;
  if (meta.source !== "live" && meta.source !== "indexed") return `bad source: ${String(meta.source)}`;
  for (const key of ["chain_height", "indexed_height"] as const) {
    const v = meta[key];
    if (v !== null && (typeof v !== "number" || !Number.isInteger(v))) return `bad ${key}: ${String(v)}`;
  }
  if (typeof meta.generated_at !== "string" || Number.isNaN(Date.parse(meta.generated_at))) {
    return `bad generated_at: ${String(meta.generated_at)}`;
  }
  return null;
}

describe("route registry invariants", () => {
  it("every registered route is a GET (no write endpoint can exist)", () => {
    const nonGet = routes.filter((r) => r.method !== "GET").map((r) => `${r.method} ${r.path}`);
    expect(nonGet, `non-GET routes are forbidden: ${nonGet.join(", ")}`).toEqual([]);
  });

  it("registers at least the scaffold routes under the versioned base", () => {
    expect(routes.length).toBeGreaterThanOrEqual(3);
    for (const route of routes) expect(route.path.startsWith(`${API_BASE}/`)).toBe(true);
  });
});

describe("envelope + method contract on every route", () => {
  it("enveloped routes return a valid freshness envelope; operational routes do not", async () => {
    const server = await startServer();
    try {
      for (const route of routes) {
        const res = await fetch(`${server.baseUrl}${route.path}`);
        expect(res.status, `${route.path} should 200`).toBe(200);
        expect(res.headers.get("content-type")).toMatch(/application\/json/);
        // Rate-limit headers are present on every response (defensive posture).
        expect(res.headers.get("ratelimit-limit")).not.toBeNull();
        const body = await res.json();
        if (route.enveloped) {
          expect(isValidEnvelope(body), `${route.path} envelope`).toBeNull();
        } else {
          expect(isValidEnvelope(body)).not.toBeNull(); // operational routes are intentionally un-enveloped
        }
      }
    } finally {
      await server.close();
    }
  });

  it("rejects every write verb on every route with 405 + Allow (read-only)", async () => {
    const server = await startServer();
    try {
      for (const route of routes) {
        for (const method of WRITE_METHODS) {
          const res = await fetch(`${server.baseUrl}${route.path}`, { method });
          expect(res.status, `${method} ${route.path}`).toBe(405);
          expect(res.headers.get("allow")).toContain("GET");
        }
      }
    } finally {
      await server.close();
    }
  });

  it("returns 404 (enveloped-free error) for an unknown route", async () => {
    const server = await startServer();
    try {
      const res = await fetch(`${server.baseUrl}${API_BASE}/does-not-exist`);
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error?: { code?: string } };
      expect(body.error?.code).toBe("not_found");
    } finally {
      await server.close();
    }
  });
});

describe("zod query bounds on the paginated route (/incidents)", () => {
  const path = `${API_BASE}/incidents`;

  it("accepts in-bounds pagination", async () => {
    const server = await startServer();
    try {
      for (const qs of ["", "?limit=1", "?limit=200", "?offset=0", "?limit=50&offset=1000"]) {
        const res = await fetch(`${server.baseUrl}${path}${qs}`);
        expect(res.status, `"${qs}" should be accepted`).toBe(200);
      }
    } finally {
      await server.close();
    }
  });

  it("rejects out-of-bounds / malformed pagination with 400", async () => {
    const server = await startServer();
    try {
      for (const qs of ["?limit=0", "?limit=201", "?limit=-1", "?limit=abc", "?limit=1.5", "?offset=-1", "?offset=99999999"]) {
        const res = await fetch(`${server.baseUrl}${path}${qs}`);
        expect(res.status, `"${qs}" should be rejected`).toBe(400);
        const body = (await res.json()) as { error?: { code?: string } };
        expect(body.error?.code).toBe("invalid_query");
      }
    } finally {
      await server.close();
    }
  });
});

describe("rate limiting", () => {
  it("returns 429 with Retry-After once the window ceiling is exceeded", async () => {
    const server = await startServer({ rateLimitMax: 3, rateLimitWindowMs: 60_000 });
    try {
      const url = `${server.baseUrl}${API_BASE}/status`;
      const statuses: number[] = [];
      for (let i = 0; i < 5; i += 1) statuses.push((await fetch(url)).status);
      expect(statuses.slice(0, 3)).toEqual([200, 200, 200]);
      const limited = await fetch(url);
      expect(limited.status).toBe(429);
      expect(limited.headers.get("retry-after")).not.toBeNull();
      const body = (await limited.json()) as { error?: { code?: string } };
      expect(body.error?.code).toBe("rate_limited");
    } finally {
      await server.close();
    }
  });
});
