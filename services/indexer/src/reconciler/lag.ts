// Lag accounting (app-spec §9.2 / §9.4): each worker stream's committed cursor
// vs the chain head. The max lag drives the footer freshness line and the DATA
// DEGRADED banner (indexer_lag incident). `meta:` marker rows (the isolation
// marker, the running-NAV marker) are NOT worker streams and are excluded.

import type { Tolerances } from "./tolerances.ts";

export interface StreamLag {
  stream: string;
  indexedHeight: bigint;
  chainHeight: bigint;
  lag: bigint;
}

export interface LagResult {
  perStream: StreamLag[];
  maxLag: bigint;
  /** the freshest-defensible indexed height (the most-lagging stream). */
  indexedHeight: bigint;
  over: boolean;
}

export function computeLag(
  checkpoints: readonly { stream: string; cursorHeight: bigint }[],
  head: bigint,
  tol: Tolerances,
): LagResult {
  const streams = checkpoints.filter((c) => !c.stream.startsWith("meta:"));
  const perStream: StreamLag[] = streams.map((c) => ({
    stream: c.stream,
    indexedHeight: c.cursorHeight,
    chainHeight: head,
    lag: head - c.cursorHeight,
  }));
  const maxLag = perStream.reduce((m, s) => (s.lag > m ? s.lag : m), 0n);
  // Freshness is bounded by the most-lagging stream (the smallest cursor).
  const indexedHeight = perStream.reduce((min, s) => (s.indexedHeight < min ? s.indexedHeight : min), head);
  return { perStream, maxLag, indexedHeight, over: maxLag > tol.lagHeights };
}
