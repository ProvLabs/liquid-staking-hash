// Alert persistence — the models layer (plan 6.2 §2.5: the ONLY new Prisma
// import site; the session.server.ts port split, so routes/tests run
// storeless). The `AlertStore` port has two implementations behind one
// contract (test/alerts-models.test.ts runs BOTH):
//
//   * Prisma over the `app` schema as `app_writer` (ADR-001 Decision 1 — no
//     grants on `indexed`), constructed only when DATABASE_URL is configured.
//   * In-memory (unit suites + the notifier's pure-core tests), non-durable.
//
// The exactly-once mechanism lives HERE as `commitTick`: the insert batch
// (`skipDuplicates` = ON CONFLICT DO NOTHING over `@@unique([address, kind,
// dedupeKey])`) AND the per-stream cursor advance happen in ONE transaction —
// crash before commit → cursor unmoved → re-fetch → duplicates skipped; crash
// after → nothing lost (plan §2.4). Schema content is gated by
// test/app-schema-allowlist.test.ts.

import type { AlertKind, Candidate } from "~/lib/services/alerts.server";

/** One persisted notification (store-level; ids are bigint, dates are Date). */
export interface NotificationRecord {
  id: bigint;
  address: string;
  kind: AlertKind;
  dedupeKey: string;
  payload: unknown;
  deliveredAt: Date;
  readAt: Date | null;
}

/** mark-read selector: explicit ids or the whole unread set (§2.6). */
export type MarkReadSelector = { ids: bigint[] } | { all: true };

export interface ListPage {
  limit: number;
  offset: number;
}

export interface AlertStore {
  // ── Rules (settings surface, Commit C) ──
  /** The address's override rows as a kind → enabled map (absence = default). */
  listOverrides(address: string): Promise<Map<AlertKind, boolean>>;
  /** Upsert one explicit override (an opt-out or opt-in). createdAt/updatedAt
   * are DB-managed, so no clock is threaded here. */
  upsertRule(address: string, kind: AlertKind, enabled: boolean): Promise<void>;

  // ── Notifications (bell surface, Commit C) ──
  /** The address's notifications, newest first, bounded page. */
  listNotifications(address: string, page: ListPage): Promise<NotificationRecord[]>;
  /** Unread count for the address (bell badge). */
  countUnread(address: string): Promise<number>;
  /**
   * Mark the address's notifications read at `now`. ALWAYS address-scoped:
   * ids that belong to another address are never touched (§2.6). Returns the
   * number newly marked.
   */
  markRead(address: string, selector: MarkReadSelector, now: Date): Promise<number>;

  // ── Notifier evaluation reads (Commit B) ──
  /** Which of `addresses` have app presence (address_activity rows). */
  filterPresent(addresses: readonly string[]): Promise<Set<string>>;
  /** Of `addresses`, which explicitly opted OUT of `kind` (default-on suppression). */
  optedOutAddresses(kind: AlertKind, addresses: readonly string[]): Promise<Set<string>>;
  /** Every address that explicitly opted IN to `kind` (default-off fan-out). */
  optInAddresses(kind: AlertKind): Promise<Set<string>>;

  // ── Notifier commit + checkpoint (Commit B) ──
  /** The stream's cursor string, or null before its first tick. */
  getCheckpoint(stream: string): Promise<string | null>;
  /**
   * Insert the candidates (skipDuplicates) AND advance the cursor in ONE
   * transaction. Returns the number actually inserted (duplicates skipped).
   */
  commitTick(stream: string, cursor: string, candidates: readonly Candidate[]): Promise<number>;

  // ── Retention (rides the tick, Commit B) ──
  /**
   * Delete notifications read before `readCutoff`, or delivered before
   * `absoluteCutoff`, in one bounded batch (≤ `batchLimit`). Returns deleted.
   */
  sweep(readCutoff: Date, absoluteCutoff: Date, batchLimit: number): Promise<number>;
}

function dedupeId(address: string, kind: AlertKind, dedupeKey: string): string {
  return `${address}\u0000${kind}\u0000${dedupeKey}`;
}

// ── In-memory implementation ─────────────────────────────────────────────

export class InMemoryAlertStore implements AlertStore {
  private readonly rules = new Map<string, boolean>(); // `${address}\0${kind}` → enabled
  private readonly notifications: NotificationRecord[] = [];
  private readonly seen = new Set<string>(); // dedupeId set (the unique constraint)
  private readonly presence = new Set<string>();
  private readonly checkpoints = new Map<string, string>();
  private nextId = 1n;
  private readonly now: () => Date;

  /** Injectable clock for `deliveredAt` (production defaults to wall clock).
   * NB: explicit field assignment, not a parameter property — this file is
   * loaded by the notifier via `node` (strip-only TS), which rejects those. */
  constructor(now: () => Date = () => new Date()) {
    this.now = now;
  }

  /** Test seam: seed app presence (production reads address_activity). */
  setPresent(...addresses: string[]): void {
    for (const a of addresses) this.presence.add(a);
  }

  /** Test seam: seed a notification directly (e.g. an aged row for sweep). */
  seed(record: Omit<NotificationRecord, "id">): void {
    this.notifications.push({ id: this.nextId++, ...record });
    this.seen.add(dedupeId(record.address, record.kind, record.dedupeKey));
  }

  private ruleKey(address: string, kind: AlertKind): string {
    return `${address}\u0000${kind}`;
  }

  async listOverrides(address: string): Promise<Map<AlertKind, boolean>> {
    const map = new Map<AlertKind, boolean>();
    for (const [key, enabled] of this.rules) {
      const [addr, kind] = key.split("\u0000");
      if (addr === address) map.set(kind as AlertKind, enabled);
    }
    return map;
  }

  async upsertRule(address: string, kind: AlertKind, enabled: boolean): Promise<void> {
    this.rules.set(this.ruleKey(address, kind), enabled);
  }

  async listNotifications(address: string, page: ListPage): Promise<NotificationRecord[]> {
    return this.notifications
      .filter((n) => n.address === address)
      .sort((a, b) => (a.id === b.id ? 0 : a.id < b.id ? 1 : -1)) // newest (highest id) first
      .slice(page.offset, page.offset + page.limit)
      .map((n) => ({ ...n }));
  }

  async countUnread(address: string): Promise<number> {
    return this.notifications.filter((n) => n.address === address && n.readAt === null).length;
  }

  async markRead(address: string, selector: MarkReadSelector, now: Date): Promise<number> {
    let count = 0;
    for (const n of this.notifications) {
      if (n.address !== address || n.readAt !== null) continue;
      if ("ids" in selector && !selector.ids.includes(n.id)) continue;
      n.readAt = now;
      count += 1;
    }
    return count;
  }

  async filterPresent(addresses: readonly string[]): Promise<Set<string>> {
    return new Set(addresses.filter((a) => this.presence.has(a)));
  }

  async optedOutAddresses(kind: AlertKind, addresses: readonly string[]): Promise<Set<string>> {
    return new Set(addresses.filter((a) => this.rules.get(this.ruleKey(a, kind)) === false));
  }

  async optInAddresses(kind: AlertKind): Promise<Set<string>> {
    const out = new Set<string>();
    for (const [key, enabled] of this.rules) {
      const [addr, k] = key.split("\u0000");
      if (k === kind && enabled) out.add(addr!);
    }
    return out;
  }

  async getCheckpoint(stream: string): Promise<string | null> {
    return this.checkpoints.get(stream) ?? null;
  }

  async commitTick(stream: string, cursor: string, candidates: readonly Candidate[]): Promise<number> {
    let inserted = 0;
    for (const c of candidates) {
      const id = dedupeId(c.address, c.kind, c.dedupeKey);
      if (this.seen.has(id)) continue; // ON CONFLICT DO NOTHING
      this.seen.add(id);
      this.notifications.push({
        id: this.nextId++,
        address: c.address,
        kind: c.kind,
        dedupeKey: c.dedupeKey,
        payload: c.payload,
        deliveredAt: this.now(),
        readAt: null,
      });
      inserted += 1;
    }
    this.checkpoints.set(stream, cursor); // same "transaction"
    return inserted;
  }

  async sweep(readCutoff: Date, absoluteCutoff: Date, batchLimit: number): Promise<number> {
    const victims = this.notifications
      .filter(
        (n) =>
          (n.readAt !== null && n.readAt.getTime() < readCutoff.getTime()) ||
          n.deliveredAt.getTime() < absoluteCutoff.getTime(),
      )
      .slice(0, batchLimit);
    for (const v of victims) {
      const idx = this.notifications.indexOf(v);
      if (idx >= 0) this.notifications.splice(idx, 1);
      this.seen.delete(dedupeId(v.address, v.kind, v.dedupeKey));
    }
    return victims.length;
  }
}

// ── Prisma implementation (lazy import: generated code the unit suites skip) ──

// Structural view of exactly the generated methods this store touches. Kept
// structural (the session.server.ts precedent) so the unit suite never loads
// the generated client, and a type-only import cannot drag runtime code in.
interface AlertPrismaLike {
  alertRule: {
    findMany(args: unknown): Promise<Array<{ address: string; kind: string; enabled: boolean }>>;
    upsert(args: unknown): Promise<unknown>;
  };
  notification: {
    findMany(args: unknown): Promise<
      Array<{ id: bigint; address: string; kind: string; dedupeKey: string; payload: unknown; deliveredAt: Date; readAt: Date | null }>
    >;
    count(args: unknown): Promise<number>;
    updateMany(args: unknown): Promise<{ count: number }>;
    createMany(args: unknown): Promise<{ count: number }>;
    deleteMany(args: unknown): Promise<{ count: number }>;
  };
  addressActivity: {
    findMany(args: unknown): Promise<Array<{ address: string }>>;
  };
  notifierCheckpoint: {
    findUnique(args: unknown): Promise<{ cursor: string } | null>;
    upsert(args: unknown): Promise<unknown>;
  };
  $transaction<T>(fn: (tx: AlertPrismaLike) => Promise<T>): Promise<T>;
}

export class PrismaAlertStore implements AlertStore {
  private readonly prisma: AlertPrismaLike;

  // Explicit field assignment (not a parameter property): the notifier loads
  // this module via `node`'s strip-only TS, which rejects parameter properties.
  constructor(prisma: AlertPrismaLike) {
    this.prisma = prisma;
  }

  async listOverrides(address: string): Promise<Map<AlertKind, boolean>> {
    const rows = await this.prisma.alertRule.findMany({ where: { address }, select: { kind: true, enabled: true } });
    return new Map(rows.map((r) => [r.kind as AlertKind, r.enabled]));
  }

  async upsertRule(address: string, kind: AlertKind, enabled: boolean): Promise<void> {
    await this.prisma.alertRule.upsert({
      where: { address_kind: { address, kind } },
      create: { address, kind, enabled },
      update: { enabled },
    });
  }

  async listNotifications(address: string, page: ListPage): Promise<NotificationRecord[]> {
    const rows = await this.prisma.notification.findMany({
      where: { address },
      orderBy: { id: "desc" },
      skip: page.offset,
      take: page.limit,
    });
    return rows.map((r) => ({
      id: r.id,
      address: r.address,
      kind: r.kind as AlertKind,
      dedupeKey: r.dedupeKey,
      payload: r.payload,
      deliveredAt: r.deliveredAt,
      readAt: r.readAt,
    }));
  }

  async countUnread(address: string): Promise<number> {
    return this.prisma.notification.count({ where: { address, readAt: null } });
  }

  async markRead(address: string, selector: MarkReadSelector, now: Date): Promise<number> {
    // ALWAYS address-scoped: an id belonging to another address can never be
    // touched, because `address` is part of the WHERE (§2.6).
    const where =
      "all" in selector
        ? { address, readAt: null }
        : { address, readAt: null, id: { in: selector.ids } };
    const result = await this.prisma.notification.updateMany({ where, data: { readAt: now } });
    return result.count;
  }

  async filterPresent(addresses: readonly string[]): Promise<Set<string>> {
    if (addresses.length === 0) return new Set();
    const rows = await this.prisma.addressActivity.findMany({
      where: { address: { in: [...addresses] } },
      select: { address: true },
    });
    return new Set(rows.map((r) => r.address));
  }

  async optedOutAddresses(kind: AlertKind, addresses: readonly string[]): Promise<Set<string>> {
    if (addresses.length === 0) return new Set();
    const rows = await this.prisma.alertRule.findMany({
      where: { kind, enabled: false, address: { in: [...addresses] } },
      select: { address: true },
    });
    return new Set(rows.map((r) => r.address));
  }

  async optInAddresses(kind: AlertKind): Promise<Set<string>> {
    const rows = await this.prisma.alertRule.findMany({
      where: { kind, enabled: true },
      select: { address: true },
    });
    return new Set(rows.map((r) => r.address));
  }

  async getCheckpoint(stream: string): Promise<string | null> {
    const row = await this.prisma.notifierCheckpoint.findUnique({ where: { stream }, select: { cursor: true } });
    return row?.cursor ?? null;
  }

  async commitTick(stream: string, cursor: string, candidates: readonly Candidate[]): Promise<number> {
    return this.prisma.$transaction(async (tx) => {
      let inserted = 0;
      if (candidates.length > 0) {
        const result = await tx.notification.createMany({
          data: candidates.map((c) => ({
            address: c.address,
            kind: c.kind,
            dedupeKey: c.dedupeKey,
            payload: c.payload,
          })),
          skipDuplicates: true,
        });
        inserted = result.count;
      }
      // Same transaction as the insert (plan §2.4): cursor advances iff the
      // batch committed.
      await tx.notifierCheckpoint.upsert({
        where: { stream },
        create: { stream, cursor },
        update: { cursor },
      });
      return inserted;
    });
  }

  async sweep(readCutoff: Date, absoluteCutoff: Date, batchLimit: number): Promise<number> {
    // Bounded: select ≤ batchLimit ids, then delete them (deleteMany has no
    // LIMIT). `readAt: { lt }` excludes nulls, so unread rows survive until the
    // 180-day absolute bound.
    const rows = await this.prisma.notification.findMany({
      where: { OR: [{ readAt: { lt: readCutoff } }, { deliveredAt: { lt: absoluteCutoff } }] },
      select: { id: true },
      take: batchLimit,
    });
    if (rows.length === 0) return 0;
    const result = await this.prisma.notification.deleteMany({
      where: { id: { in: rows.map((r) => r.id) } },
    });
    return result.count;
  }
}

// The PROMISE is the singleton, not the store: `await import("@prisma/client")`
// yields the event loop, so caching the resolved store would let two
// concurrent first requests both pass the guard and construct two
// PrismaClients (one silently orphaned with its pool). Callers race on the
// same promise instead.
let storePromise: Promise<AlertStore> | undefined;

async function createAlertStore(config: {
  databaseUrl?: string | undefined;
  appEnv: string;
}): Promise<AlertStore> {
  if (config.databaseUrl !== undefined) {
    const { PrismaClient } = await import("@prisma/client");
    return new PrismaAlertStore(
      new PrismaClient({ datasources: { db: { url: config.databaseUrl } } }) as unknown as AlertPrismaLike,
    );
  }
  if (config.appEnv !== "development") {
    console.warn(
      "[nvhash-web] DATABASE_URL is not configured — alerts are in-memory and " +
        "will not survive a restart. Production profiles must set it.",
    );
  }
  return new InMemoryAlertStore();
}

/**
 * Process-wide alert store: Prisma when DATABASE_URL is configured, else the
 * non-durable in-memory store (dev/mock posture; the session-store precedent).
 */
export function getAlertStore(config: {
  databaseUrl?: string | undefined;
  appEnv: string;
}): Promise<AlertStore> {
  if (storePromise === undefined) {
    const promise = createAlertStore(config);
    // A failed init (e.g. the client import) must not stick as the singleton;
    // the caller still sees the rejection from its own returned promise.
    promise.catch(() => {
      if (storePromise === promise) storePromise = undefined;
    });
    storePromise = promise;
  }
  return storePromise;
}

/** Test seam: reset the process-wide store singleton. */
export function resetAlertStoreForTests(): void {
  storePromise = undefined;
}
