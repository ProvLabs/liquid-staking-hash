// Test harness: start the real node:http server on an ephemeral port and talk
// to it over HTTP (supertest-style — the full adapter, read-only guard, rate
// limiter, and router are exercised, not mocked).

import type { AddressInfo } from "node:net";
import type { ApiConfig } from "../src/config.ts";
import { createApiServer } from "../src/http-server.ts";
import type { IndexedReader } from "../src/reader.ts";

export interface RunningServer {
  readonly baseUrl: string;
  close(): Promise<void>;
}

const DEFAULT_CONFIG: ApiConfig = {
  appEnv: "development",
  port: 0,
  // High ceiling so functional assertions never trip the limiter; the
  // rate-limit test overrides this to a small value.
  rateLimitMax: 100_000,
  rateLimitWindowMs: 60_000,
  trustProxy: false,
};

/**
 * Start a server with optional config overrides; resolves once listening.
 * `reader` injects a populated in-memory fake (test/reader-fake.ts); absent,
 * the server runs on the honest empty reader — the dataless scaffold state.
 */
export async function startServer(overrides: Partial<ApiConfig> = {}, now?: () => Date, reader?: IndexedReader): Promise<RunningServer> {
  const config: ApiConfig = { ...DEFAULT_CONFIG, ...overrides };
  const { server } = createApiServer(config, now, reader);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}
