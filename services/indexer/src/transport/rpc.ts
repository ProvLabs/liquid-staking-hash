// Transports the shared @nvhash/chain-client (grpc-gateway REST only) lacks,
// pinned by the fixture corpus (packages/fixtures/manifest.json):
//
//  - `block_results` — EndBlocker events live in `finalize_block_events`;
//    payout/refund and the `EventSetNetAssetValue` NAV marker appear ONLY here,
//    never in tx-search. (Tendermint RPC, dev network `http://dev-node:26657`.)
//  - `tx_search` / `block_search` — height-range event lookup; `block_search`
//    indexes EndBlocker events on this build (kv indexer).
//  - height-pinned smart query — because the contract retains only the LATEST
//    epoch snapshot (spec §13, contract §9.10), historical backfill queries the
//    contract AT a past crank height via the `x-cosmos-block-height` header.
//
// Zero runtime dependencies (SECURITY.md supply chain), fetch-based with an
// injectable impl and a request deadline, mirroring chain-client's LcdClient.
// Config/compose wiring (RPC_URL, LCD base) lands with the first worker that
// constructs these (PR 2.1); here they take an explicit base URL like
// LcdClient does, so the classes are unit-testable in isolation.

import type { RawEvent } from "../decode/attributes.ts";

export class RpcError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    readonly body: string,
  ) {
    super(`RPC ${status} on ${path}: ${body.slice(0, 300)}`);
    this.name = "RpcError";
  }
}

/** Minimal fetch surface (adds optional headers over chain-client's FetchLike). */
export type RpcFetch = (
  url: string,
  init: { signal: AbortSignal; headers?: Record<string, string> },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export interface TransportOptions {
  /** injectable for tests and non-global fetch environments */
  fetchImpl?: RpcFetch;
  /** request deadline; a hung node must surface as an error, not a hang */
  timeoutMs?: number;
}

/** One transaction's decoded events, plus its hash/height (tx-search result). */
export interface TxResult {
  readonly hash: string;
  readonly height: bigint;
  readonly events: readonly RawEvent[];
}

export interface TxSearchPage {
  readonly totalCount: number;
  readonly txs: readonly TxResult[];
}

/** A block's EndBlocker + per-tx events (block_results result). */
export interface BlockResults {
  readonly height: bigint;
  /** each tx's events, in block order */
  readonly txsResults: readonly { readonly events: readonly RawEvent[] }[];
  /** EndBlocker/BeginBlocker events (payout, refund, NAV marker) */
  readonly finalizeBlockEvents: readonly RawEvent[];
}

async function fetchJson(
  base: string,
  path: string,
  params: Record<string, string | number | bigint | undefined>,
  fetchImpl: RpcFetch,
  timeoutMs: number,
  headers?: Record<string, string>,
): Promise<unknown> {
  let url = `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) q.set(k, String(v));
  }
  const qs = q.toString();
  if (qs) url += `?${qs}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(
      url,
      headers === undefined ? { signal: controller.signal } : { signal: controller.signal, headers },
    );
    const text = await res.text();
    if (!res.ok) throw new RpcError(res.status, path, text);
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new RpcError(res.status, path, `non-JSON body: ${text.slice(0, 120)}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

function asRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RpcError(0, path, `expected object, got ${JSON.stringify(value)?.slice(0, 120)}`);
  }
  return value as Record<string, unknown>;
}

/** Unwrap the JSON-RPC `{ jsonrpc, id, result }` envelope. */
function resultOf(body: unknown, path: string): Record<string, unknown> {
  return asRecord(asRecord(body, path)["result"], `${path}.result`);
}

function toEvents(value: unknown): RawEvent[] {
  if (!Array.isArray(value)) return [];
  return value.map((e) => {
    const o = e as Record<string, unknown>;
    const attributes = Array.isArray(o["attributes"])
      ? (o["attributes"] as Record<string, unknown>[]).map((a) => ({
          key: String(a["key"] ?? ""),
          value: String(a["value"] ?? ""),
          ...(a["index"] === undefined ? {} : { index: Boolean(a["index"]) }),
        }))
      : [];
    return { type: String(o["type"] ?? ""), attributes };
  });
}

function toBigint(value: unknown, path: string): bigint {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new RpcError(0, path, `expected string-encoded height, got ${JSON.stringify(value)}`);
  }
  return BigInt(value);
}

/** Tendermint RPC reads (block_results, tx_search, block_search, status). */
export class RpcClient {
  private readonly base: string;
  private readonly fetchImpl: RpcFetch;
  private readonly timeoutMs: number;

  constructor(baseUrl: string, options: TransportOptions = {}) {
    this.base = baseUrl.replace(/\/+$/, "");
    this.fetchImpl = options.fetchImpl ?? (fetch as unknown as RpcFetch);
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  /** Current chain head height (RPC `/status` → sync_info.latest_block_height). */
  async latestHeight(): Promise<bigint> {
    const result = resultOf(await this.get("status", {}), "status");
    const sync = asRecord(result["sync_info"], "status.result.sync_info");
    return toBigint(sync["latest_block_height"], "status.result.sync_info.latest_block_height");
  }

  /** Block EndBlocker + per-tx events at a height (`/block_results?height=`). */
  async blockResults(height: bigint | number): Promise<BlockResults> {
    const result = resultOf(await this.get("block_results", { height }), "block_results");
    const txs = Array.isArray(result["txs_results"]) ? result["txs_results"] : [];
    return {
      height: toBigint(result["height"], "block_results.result.height"),
      txsResults: txs.map((t) => ({ events: toEvents((t as Record<string, unknown>)["events"]) })),
      finalizeBlockEvents: toEvents(result["finalize_block_events"]),
    };
  }

  /** Paged tx-search by CometBFT query (e.g. `tx.height>=X AND tx.height<=Y`). */
  async txSearch(query: string, page = 1, perPage = 100): Promise<TxSearchPage> {
    const result = resultOf(
      await this.get("tx_search", { query: `"${query}"`, page, per_page: perPage }),
      "tx_search",
    );
    const txs = Array.isArray(result["txs"]) ? result["txs"] : [];
    return {
      totalCount: Number(result["total_count"] ?? txs.length),
      txs: txs.map((t) => {
        const o = t as Record<string, unknown>;
        const txResult = asRecord(o["tx_result"], "tx_search.result.txs[].tx_result");
        return {
          hash: String(o["hash"] ?? ""),
          height: toBigint(o["height"], "tx_search.result.txs[].height"),
          events: toEvents(txResult["events"]),
        };
      }),
    };
  }

  /** Paged block-search (EndBlocker event index) → matching block heights. */
  async blockSearch(query: string, page = 1, perPage = 100): Promise<{ totalCount: number; heights: bigint[] }> {
    const result = resultOf(
      await this.get("block_search", { query: `"${query}"`, page, per_page: perPage }),
      "block_search",
    );
    const blocks = Array.isArray(result["blocks"]) ? result["blocks"] : [];
    return {
      totalCount: Number(result["total_count"] ?? blocks.length),
      heights: blocks.map((b) => {
        const header = asRecord(
          asRecord((b as Record<string, unknown>)["block"], "block_search.result.blocks[].block")["header"],
          "block_search.result.blocks[].block.header",
        );
        return toBigint(header["height"], "block_search.result.blocks[].block.header.height");
      }),
    };
  }

  private get(path: string, params: Record<string, string | number | bigint | undefined>): Promise<unknown> {
    return fetchJson(this.base, path, params, this.fetchImpl, this.timeoutMs);
  }
}

/** Runtime-portable base64 (Node and browser; queries are ASCII JSON). */
function toBase64(s: string): string {
  if (typeof Buffer !== "undefined") return Buffer.from(s, "utf8").toString("base64");
  return btoa(s);
}

/**
 * LCD smart query pinned to a past block via `x-cosmos-block-height`. Returns
 * the LCD envelope's `data` payload (undecoded) — the caller passes it to the
 * matching chain-client decoder (e.g. `parseEpochSnapshot`). This is what makes
 * single-snapshot backfill (spec §9.3/§13) possible.
 *
 * Home decision deferred to PR 2.2: promote into @nvhash/chain-client (shared)
 * or keep App-local here. Kept App-local for now to keep the shared package
 * REST-only and dependency-minimal.
 */
export class PinnedLcdClient {
  private readonly base: string;
  private readonly fetchImpl: RpcFetch;
  private readonly timeoutMs: number;

  constructor(baseUrl: string, options: TransportOptions = {}) {
    this.base = baseUrl.replace(/\/+$/, "");
    this.fetchImpl = options.fetchImpl ?? (fetch as unknown as RpcFetch);
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  /** Smart query `contract` with `query` as it was AT `height`; returns `data`. */
  async smartAtHeight(contract: string, query: Record<string, unknown>, height: bigint | number): Promise<unknown> {
    const b64 = toBase64(JSON.stringify(query));
    const path = `cosmwasm/wasm/v1/contract/${contract}/smart/${encodeURIComponent(b64)}`;
    const body = await fetchJson(this.base, path, {}, this.fetchImpl, this.timeoutMs, {
      "x-cosmos-block-height": String(height),
    });
    return asRecord(body, path)["data"];
  }
}
