// Client-side epoch ledger (spec §9.3). The contract retains only the most recent
// EpochSnapshot, so the console persists a per-origin history to IndexedDB to power
// trend charts. One DB per chain_id + contract_address (histories never mix). Best-effort;
// charts degrade to 0/1/N points. Falls back to in-memory if IndexedDB is unavailable.
import { config } from "@/config";
import type { LedgerRow } from "@/lib/types";

const DB_NAME = `nvhash.ledger.${config.chainId}.${config.contractAddress}`;
const STORE = "epochs";
let memFallback: Map<number, LedgerRow> | null = null;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") return reject(new Error("no indexeddb"));
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "epoch_index" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function ledgerAll(): Promise<LedgerRow[]> {
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).getAll();
      req.onsuccess = () => resolve((req.result as LedgerRow[]).sort((a, b) => a.epoch_index - b.epoch_index));
      req.onerror = () => reject(req.error);
    });
  } catch {
    return memFallback ? [...memFallback.values()].sort((a, b) => a.epoch_index - b.epoch_index) : [];
  }
}

/** Append a snapshot iff its epoch_index is not yet stored (immutable once written). */
export async function ledgerAppend(row: LedgerRow): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      const store = tx.objectStore(STORE);
      const get = store.get(row.epoch_index);
      get.onsuccess = () => {
        if (get.result === undefined) store.add(row);
        resolve();
      };
      get.onerror = () => reject(get.error);
    });
  } catch {
    if (!memFallback) memFallback = new Map();
    if (!memFallback.has(row.epoch_index)) memFallback.set(row.epoch_index, row);
  }
}

/** Seed the ledger (mock mode / demo) without overwriting real history. */
export async function ledgerSeed(rows: LedgerRow[]): Promise<void> {
  for (const r of rows) await ledgerAppend(r);
}
