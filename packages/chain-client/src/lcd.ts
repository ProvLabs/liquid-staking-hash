// Minimal fetch-based LCD (grpc-gateway REST) client. Zero dependencies by
// design: the dependency surface of everything touching chain data stays
// minimal (SECURITY.md, supply chain).

export class LcdError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    readonly body: string,
  ) {
    super(`LCD ${status} on ${path}: ${body.slice(0, 300)}`);
    this.name = "LcdError";
  }
}

/**
 * Thrown for queries the chain cannot serve over a given transport. The one
 * known case is vault `estimate_swap_in`: grpc-gateway rejects Coin/math.Int
 * query parameters, so it is gRPC/CLI-only (fixture corpus pinned fact,
 * app-spec §14.2 stage 1).
 */
export class UnsupportedTransportError extends Error {
  constructor(what: string, why: string) {
    super(`${what} is not available over LCD REST: ${why}`);
    this.name = "UnsupportedTransportError";
  }
}

export type FetchLike = (url: string, init: { signal: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

export interface LcdClientOptions {
  /** injectable for tests and non-global fetch environments */
  fetchImpl?: FetchLike;
  /** request deadline; a hung node must surface as an error, not a hang */
  timeoutMs?: number;
}

export type QueryParams = Record<string, string | number | bigint | undefined>;

export class LcdClient {
  private readonly base: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;

  constructor(baseUrl: string, options: LcdClientOptions = {}) {
    this.base = baseUrl.replace(/\/+$/, "");
    this.fetchImpl = options.fetchImpl ?? (fetch as unknown as FetchLike);
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  /** GET path (already URL-safe) with optional query params; returns parsed JSON. */
  async get(path: string, params?: QueryParams): Promise<unknown> {
    let url = `${this.base}/${path.replace(/^\/+/, "")}`;
    if (params) {
      const q = new URLSearchParams();
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined) q.set(k, String(v));
      }
      const qs = q.toString();
      if (qs) url += `?${qs}`;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(url, { signal: controller.signal });
      const text = await res.text();
      if (!res.ok) throw new LcdError(res.status, path, text);
      try {
        return JSON.parse(text) as unknown;
      } catch {
        throw new LcdError(res.status, path, `non-JSON body: ${text.slice(0, 120)}`);
      }
    } finally {
      clearTimeout(timer);
    }
  }
}
