// Web Push subscription persistence — the models layer (plan 6.3 §2.1). The
// `session.server.ts` / `alerts.server.ts` port split: one contract, two
// implementations (test/push-subscription.test.ts runs the in-memory one; the
// Prisma one runs in production over the `app` schema as `app_writer`).
//
// The row is the ONE accepted SECURITY.md exception (opaque, revocable push
// tokens). The mechanisms this store enforces:
//   * created ONLY on explicit opt-in (the route calls upsertForSession only
//     behind requireSession — plan §2.1);
//   * replace-by-session, never accumulate — a new endpoint for a session
//     replaces its older ones (`endpoint` @unique + the delete in upsert);
//   * a per-address cap (oldest evicted) so a hostile client cannot grow the
//     table through repeated re-subscription (plan §7 Q4);
//   * revocability: deleteForSession (opt-out + the session-removal deletion
//     chain, Commit B) and deleteForEndpoint (404/410 pruning, Commit B).
//
// endpoint/p256dh/auth are opaque and NEVER logged (an endpoint URL can
// fingerprint the browser vendor — treated as secrets-adjacent). Schema
// content is gated by test/app-schema-allowlist.test.ts.

/** Cap on active subscriptions per address; the oldest is evicted past it
 *  (plan §7 Q4 — cheap, bounded, and blunts re-subscription table growth). */
export const PUSH_SUBSCRIPTIONS_PER_ADDRESS_CAP = 5;

/** The W3C `PushSubscription.toJSON()` triple (already zod-bounded at the route). */
export interface PushSubscriptionInput {
  endpoint: string;
  p256dh: string;
  auth: string;
}

/** A stored subscription as the fan-out needs it (Commit B); opaque material. */
export interface PushSubscriptionRecord {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface PushStore {
  /**
   * Opt-in upsert, scoped to a session: store `sub` for (address, sessionId),
   * replacing any OTHER endpoint the session held (replace-by-session), and
   * evicting the address's oldest rows past the cap. Idempotent on `endpoint`
   * (a re-subscription with the same endpoint under a new session re-homes it,
   * never duplicating).
   */
  upsertForSession(address: string, sessionId: string, sub: PushSubscriptionInput): Promise<void>;
  /** Delete every subscription for a session (opt-out + session removal). Count. */
  deleteForSession(sessionId: string): Promise<number>;
  /** The address's subscriptions — the notifier fan-out target (Commit B). */
  listForAddress(address: string): Promise<PushSubscriptionRecord[]>;
  /** Prune one dead endpoint (a 404/410 at send time — Commit B). Count. */
  deleteForEndpoint(endpoint: string): Promise<number>;
  /** Active subscription count for an address (cap tests / diagnostics). */
  countForAddress(address: string): Promise<number>;
}

// ── In-memory implementation ─────────────────────────────────────────────

interface PushRow {
  id: bigint;
  address: string;
  sessionId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

export class InMemoryPushStore implements PushStore {
  private readonly rows: PushRow[] = [];
  private nextId = 1n;

  async upsertForSession(address: string, sessionId: string, sub: PushSubscriptionInput): Promise<void> {
    // Idempotent on endpoint: re-home an existing endpoint rather than duplicate.
    const existing = this.rows.find((r) => r.endpoint === sub.endpoint);
    if (existing !== undefined) {
      existing.address = address;
      existing.sessionId = sessionId;
      existing.p256dh = sub.p256dh;
      existing.auth = sub.auth;
    } else {
      this.rows.push({ id: this.nextId++, address, sessionId, endpoint: sub.endpoint, p256dh: sub.p256dh, auth: sub.auth });
    }
    // Replace-by-session: the session keeps only this endpoint.
    for (let i = this.rows.length - 1; i >= 0; i--) {
      const r = this.rows[i]!;
      if (r.sessionId === sessionId && r.endpoint !== sub.endpoint) this.rows.splice(i, 1);
    }
    this.evict(address);
  }

  async deleteForSession(sessionId: string): Promise<number> {
    let count = 0;
    for (let i = this.rows.length - 1; i >= 0; i--) {
      if (this.rows[i]!.sessionId === sessionId) {
        this.rows.splice(i, 1);
        count += 1;
      }
    }
    return count;
  }

  async listForAddress(address: string): Promise<PushSubscriptionRecord[]> {
    return this.listForAddressSync(address);
  }

  async deleteForEndpoint(endpoint: string): Promise<number> {
    const idx = this.rows.findIndex((r) => r.endpoint === endpoint);
    if (idx < 0) return 0;
    this.rows.splice(idx, 1);
    return 1;
  }

  async countForAddress(address: string): Promise<number> {
    return this.rows.filter((r) => r.address === address).length;
  }

  /** Test seam: the address's endpoints (synchronous mirror of listForAddress). */
  listForAddressSync(address: string): PushSubscriptionRecord[] {
    return this.rows
      .filter((r) => r.address === address)
      .map((r) => ({ endpoint: r.endpoint, p256dh: r.p256dh, auth: r.auth }));
  }

  private evict(address: string): void {
    const owned = this.rows.filter((r) => r.address === address).sort((a, b) => (a.id < b.id ? 1 : -1)); // newest first
    for (const victim of owned.slice(PUSH_SUBSCRIPTIONS_PER_ADDRESS_CAP)) {
      const idx = this.rows.indexOf(victim);
      if (idx >= 0) this.rows.splice(idx, 1);
    }
  }
}

// ── Prisma implementation (lazy import: generated code the unit suites skip) ──

// Structural view of exactly the generated delegate methods this store touches
// (the session.server.ts precedent) — a type-only shape so the unit suite never
// loads the generated client.
interface PushPrismaLike {
  pushSubscription: {
    upsert(args: unknown): Promise<unknown>;
    deleteMany(args: unknown): Promise<{ count: number }>;
    findMany(args: unknown): Promise<Array<{ id?: bigint; endpoint?: string; p256dh?: string; auth?: string }>>;
    count(args: unknown): Promise<number>;
  };
  $transaction<T>(fn: (tx: PushPrismaLike) => Promise<T>): Promise<T>;
}

export class PrismaPushStore implements PushStore {
  private readonly prisma: PushPrismaLike;

  // Explicit field assignment (not a parameter property): the deletion chain
  // reaches this store from server code; keep it strip-only-TS friendly, the
  // alerts.server.ts precedent.
  constructor(prisma: PushPrismaLike) {
    this.prisma = prisma;
  }

  async upsertForSession(address: string, sessionId: string, sub: PushSubscriptionInput): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      // Idempotent on endpoint (re-home a re-subscribed endpoint, never duplicate).
      await tx.pushSubscription.upsert({
        where: { endpoint: sub.endpoint },
        create: { address, sessionId, endpoint: sub.endpoint, p256dh: sub.p256dh, auth: sub.auth },
        update: { address, sessionId, p256dh: sub.p256dh, auth: sub.auth },
      });
      // Replace-by-session: drop this session's other endpoints.
      await tx.pushSubscription.deleteMany({ where: { sessionId, endpoint: { not: sub.endpoint } } });
      // Per-address cap: keep the newest CAP, evict the rest (oldest first).
      const owned = await tx.pushSubscription.findMany({
        where: { address },
        orderBy: { id: "desc" },
        select: { id: true },
      });
      if (owned.length > PUSH_SUBSCRIPTIONS_PER_ADDRESS_CAP) {
        const evict = owned.slice(PUSH_SUBSCRIPTIONS_PER_ADDRESS_CAP).map((r) => r.id);
        await tx.pushSubscription.deleteMany({ where: { id: { in: evict } } });
      }
    });
  }

  async deleteForSession(sessionId: string): Promise<number> {
    const result = await this.prisma.pushSubscription.deleteMany({ where: { sessionId } });
    return result.count;
  }

  async listForAddress(address: string): Promise<PushSubscriptionRecord[]> {
    const rows = await this.prisma.pushSubscription.findMany({
      where: { address },
      select: { endpoint: true, p256dh: true, auth: true },
    });
    return rows.map((r) => ({ endpoint: r.endpoint!, p256dh: r.p256dh!, auth: r.auth! }));
  }

  async deleteForEndpoint(endpoint: string): Promise<number> {
    const result = await this.prisma.pushSubscription.deleteMany({ where: { endpoint } });
    return result.count;
  }

  async countForAddress(address: string): Promise<number> {
    return this.prisma.pushSubscription.count({ where: { address } });
  }
}

// The PROMISE is the singleton, not the store (the alerts.server.ts rationale):
// `await import("@prisma/client")` yields the event loop, so caching the
// resolved store would let two concurrent first callers construct two clients.
let storePromise: Promise<PushStore> | undefined;

async function createPushStore(config: {
  databaseUrl?: string | undefined;
  appEnv: string;
}): Promise<PushStore> {
  if (config.databaseUrl !== undefined) {
    const { PrismaClient } = await import("@prisma/client");
    return new PrismaPushStore(
      new PrismaClient({ datasources: { db: { url: config.databaseUrl } } }) as unknown as PushPrismaLike,
    );
  }
  if (config.appEnv !== "development") {
    console.warn(
      "[nvhash-web] DATABASE_URL is not configured — push subscriptions are in-memory " +
        "and will not survive a restart. Production profiles must set it.",
    );
  }
  return new InMemoryPushStore();
}

/**
 * Process-wide push store: Prisma when DATABASE_URL is configured, else the
 * non-durable in-memory store (dev/mock posture; the session/alert precedent).
 */
export function getPushStore(config: {
  databaseUrl?: string | undefined;
  appEnv: string;
}): Promise<PushStore> {
  if (storePromise === undefined) {
    const promise = createPushStore(config);
    promise.catch(() => {
      if (storePromise === promise) storePromise = undefined;
    });
    storePromise = promise;
  }
  return storePromise;
}

/** Test seam: reset the process-wide store singleton. */
export function resetPushStoreForTests(): void {
  storePromise = undefined;
}
