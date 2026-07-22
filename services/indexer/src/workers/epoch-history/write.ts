// Apply decoded epoch rows to the store. Pure over an abstract `EpochStore`
// (Postgres via store.ts; in-memory in the replay property test). Each row is an
// independent upsert keyed by `epochIndex`, so applying a set in any order, in
// one pass or across a resume, converges to the same `epoch_snapshots` — the
// idempotent-replay guarantee (app-spec §9.2 / SECURITY.md).

import type { EpochRow } from "./snapshot.ts";

export interface EpochStore {
  upsertEpoch(row: EpochRow): Promise<void>;
}

export async function applyEpochRows(store: EpochStore, rows: readonly EpochRow[]): Promise<void> {
  for (const row of rows) await store.upsertEpoch(row);
}
