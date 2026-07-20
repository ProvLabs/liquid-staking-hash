// The freshness envelope — the nvHASH App's honesty contract in the API shape
// itself (app-spec §9.4, §12.1; SECURITY.md "never lie about state").
//
// Every response from services/api (and every app-state route in apps/web that
// serves chain-derived data) wraps its payload as `{ data, meta }`. The `meta`
// block is not decoration: `source` plus the two heights are how the UI renders
// staleness structurally (dim + badge) instead of blanking, and how the
// reconciler's degradation surfaces stay honest (§12.1). Keeping the type here,
// shared by producer (services/api) and consumer (apps/web), means the API
// cannot drift from what the UI renders — ADR-001 Decision 4.

/**
 * Which plane produced `data`. Per app-spec §9.4 there are exactly two:
 * - `live`    — a direct chain read (the canonical plane, §5.1): authoritative.
 * - `indexed` — derived from the indexer's store (durable history/aggregates).
 *
 * This union is deliberately closed. "No data plane wired yet" (a cold start,
 * or the scaffold before M2/M3 land the workers and readers) is expressed by
 * NULL HEIGHTS, not by a third source value — a null height is exactly the
 * structural "not certified fresh" signal §12.1 relies on.
 */
export type FreshnessSource = "live" | "indexed";

/**
 * Freshness metadata attached to every enveloped response.
 *
 * Heights are chain block heights (monotonic, small integers well within the
 * JS safe-integer range — NOT token amounts, which stay `BigInt`/`Decimal`).
 * They are `number | null`: `null` means the height is not yet known (cold
 * start, unwired plane, or a stream that has not reported), which the freshness
 * UI renders as "n/a" rather than presenting a fabricated number as current.
 */
export interface FreshnessMeta {
  /** Head height the value is reconciled against, or `null` if unknown. */
  chain_height: number | null;
  /** Indexer's committed height for this data, or `null` if unknown. */
  indexed_height: number | null;
  /** ISO-8601 timestamp the response was generated (server clock). */
  generated_at: string;
  /** Plane that produced `data` (§9.4). */
  source: FreshnessSource;
}

/** The universal response shape: a typed payload plus its freshness metadata. */
export interface Envelope<T> {
  data: T;
  meta: FreshnessMeta;
}

/** Inputs to {@link freshness}; `generatedAt` is injectable for deterministic tests. */
export interface FreshnessInput {
  source: FreshnessSource;
  chainHeight?: number | null;
  indexedHeight?: number | null;
  /** Defaults to the current time; pass a fixed `Date` in tests. */
  generatedAt?: Date;
}

function assertHeight(value: number | null, label: string): void {
  // Validate and bound at the boundary (SECURITY.md): a height is either null
  // or a non-negative safe integer. A malformed height must be an error, never
  // a best-effort continue that ships a nonsense freshness claim to the UI.
  if (value === null) return;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be null or a non-negative safe integer, got ${value}`);
  }
}

/** Build a validated {@link FreshnessMeta}. Heights default to `null` (unknown). */
export function freshness(input: FreshnessInput): FreshnessMeta {
  const chain_height = input.chainHeight ?? null;
  const indexed_height = input.indexedHeight ?? null;
  assertHeight(chain_height, "chain_height");
  assertHeight(indexed_height, "indexed_height");
  return {
    chain_height,
    indexed_height,
    generated_at: (input.generatedAt ?? new Date()).toISOString(),
    source: input.source,
  };
}

/** Wrap a payload and freshness inputs into an {@link Envelope}. */
export function envelope<T>(data: T, meta: FreshnessInput): Envelope<T> {
  return { data, meta: freshness(meta) };
}
