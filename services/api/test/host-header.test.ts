// Regression: the client-controlled `Host` header must not
// influence routing. Before the fix the adapter built the request URL as
// `http://${host}${req.url}`, so a `Host` value carrying a path component
// injected a prefix into `url.pathname` — misrouting a legitimate path to a 404
// and letting a short request-target reach a route it should not. We drive the
// exact bytes over a raw socket because `fetch` forbids setting `Host`.

import net from "node:net";
import { describe, expect, it } from "vitest";
import { API_BASE } from "../src/index.ts";
import { startServer } from "./helpers.ts";

/** Send one raw HTTP/1.1 GET with an arbitrary Host header; resolve the status. */
function rawGet(
  baseUrl: string,
  target: string,
  hostHeader: string,
): Promise<{ status: number; body: string }> {
  const { hostname, port } = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const socket = net.connect(Number(port), hostname, () => {
      socket.write(`GET ${target} HTTP/1.1\r\nHost: ${hostHeader}\r\nConnection: close\r\n\r\n`);
    });
    let data = "";
    socket.on("data", (chunk) => (data += chunk.toString()));
    socket.on("end", () => {
      const status = Number(/^HTTP\/1\.1 (\d+)/.exec(data)?.[1] ?? 0);
      const body = data.slice(data.indexOf("\r\n\r\n") + 4);
      resolve({ status, body });
    });
    socket.on("error", reject);
  });
}

describe("Host header cannot influence routing (defensive, SECURITY.md)", () => {
  it("routes by the request-target even when Host carries a path prefix", async () => {
    const server = await startServer();
    try {
      const res = await rawGet(server.baseUrl, `${API_BASE}/status`, "attacker.example/api/v1");
      expect(res.status).toBe(200);
      const parsed = JSON.parse(res.body) as { data?: { service?: string } };
      expect(parsed.data?.service).toBe("nvhash-api");
    } finally {
      await server.close();
    }
  });

  it("does not let a Host-injected prefix dispatch a short target to a real route", async () => {
    const server = await startServer();
    try {
      // Pre-fix, `GET /status` with `Host: x/api/v1` resolved to
      // /api/v1/status and returned 200; it must now 404.
      const res = await rawGet(server.baseUrl, "/status", "x/api/v1");
      expect(res.status).toBe(404);
    } finally {
      await server.close();
    }
  });
});
