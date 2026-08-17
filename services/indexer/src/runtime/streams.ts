// Canonical worker-stream names and the per-(chain_id, contract) isolation
// boot check (app-spec §9.3): program history is keyed to the chain/contract it
// was captured from, exactly as the console keys its ledger. Devnet redeploys
// reset the database with the chain — so if the persisted identity ever
// disagrees with the configured one, we FAIL LOUDLY rather than silently mixing
// two histories into one set of `indexed` tables.
//
// The identity marker is stored as a reserved row in `indexer_checkpoints` (a
// `meta:` stream, never a worker cursor) so no schema change is needed — the
// model already carries a nullable `cursorPage` string. Lag accounting
// excludes `meta:`-prefixed rows from the per-stream height exposure.

import type { PrismaClient } from "../prisma.ts";

/** Stream names → durable checkpoint keys, one per worker (app-spec §9.2). */
export const STREAMS = {
  chainEvents: "chain-events",
  epochHistory: "epoch-history",
  validatorSampler: "validator-sampler",
  marketSampler: "market-sampler",
  governance: "governance",
  reconciler: "reconciler",
} as const;

export type StreamName = (typeof STREAMS)[keyof typeof STREAMS];

/** Reserved checkpoint row holding the chain/contract identity marker. */
export const PROVENANCE_MARKER_STREAM = "meta:provenance";

export class ChainIsolationError extends Error {
  constructor(
    readonly persisted: string,
    readonly configured: string,
  ) {
    super(
      `chain/contract mismatch: database was captured under "${persisted}" but config is "${configured}" — ` +
        `reset the indexed database when the chain/contract changes (app-spec §9.3)`,
    );
    this.name = "ChainIsolationError";
  }
}

export interface ChainIdentity {
  readonly chainId: string;
  readonly contractAddress: string;
}

function markerValue(id: ChainIdentity): string {
  return `${id.chainId}|${id.contractAddress}`;
}

/**
 * On boot: record the chain/contract identity on first run; on every later run
 * assert it is unchanged. A mismatch throws `ChainIsolationError` so the
 * process fails closed instead of appending a foreign history.
 */
export async function assertChainIsolation(prisma: PrismaClient, id: ChainIdentity): Promise<void> {
  const value = markerValue(id);

  // Atomic create-if-absent: `upsert` compiles to INSERT ... ON CONFLICT DO
  // UPDATE, so two processes booting concurrently (a Compose restart where the
  // old container has not fully exited) cannot both create the marker and
  // collide on the unique `stream` key — one inserts, the other no-ops. The
  // empty `update` deliberately leaves any EXISTING row untouched, so a foreign
  // identity is preserved for the mismatch check below rather than overwritten.
  await prisma.indexerCheckpoint.upsert({
    where: { stream: PROVENANCE_MARKER_STREAM },
    create: { stream: PROVENANCE_MARKER_STREAM, cursorHeight: 0n, cursorPage: value },
    update: {},
  });

  // Read back and assert identity. On first boot this is the row we just wrote;
  // on a later boot (or a concurrent one) it is whatever is persisted — a
  // mismatch means the DB holds a foreign chain/contract's history.
  const marker = await prisma.indexerCheckpoint.findUnique({
    where: { stream: PROVENANCE_MARKER_STREAM },
  });
  if (marker?.cursorPage !== value) {
    throw new ChainIsolationError(marker?.cursorPage ?? "(unset)", value);
  }
}
