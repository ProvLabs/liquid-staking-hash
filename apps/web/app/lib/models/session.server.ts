// Session persistence — the models layer (app-spec §3 decision 2: the ONLY
// Prisma import; no business logic). The `SessionStore` port has two
// implementations, the services/api reader-port precedent:
//
//   * Prisma over the `app` schema as `app_writer` (production; ADR-001
//     Decision 1 — no grants on `indexed`, asserted by the grant-boundary
//     gate), constructed only when DATABASE_URL is configured.
//   * In-memory (dev/mock posture and the unit suites, which stay
//     Postgres-free) — non-durable, same contract.
//
// The replay gate lives HERE as an atomic consume: `consumeNonce` deletes the
// row and returns it in one operation; a second presentation finds nothing.
// Schema content is gated by test/app-schema-allowlist.test.ts (SECURITY.md
// data minimization: sessions, nonces, first/last-seen — nothing else, and
// deliberately no role column).

export interface SessionRow {
  id: string;
  address: string;
  createdAt: Date;
  expiresAt: Date;
  lastRefreshAt: Date;
}

export interface SessionStore {
  createNonce(nonce: string, address: string, expiresAt: Date): Promise<void>;
  /**
   * Atomically consume a nonce: delete-and-return. Null when absent (never
   * minted, already used, or swept) or expired at `now` — indistinguishable
   * to the caller (one undifferentiated 401, the auth.ts precedent).
   */
  consumeNonce(nonce: string, now: Date): Promise<{ address: string } | null>;
  createSession(row: SessionRow): Promise<void>;
  /** Null when unknown or past either expiry bound at `now`. */
  getSession(id: string, now: Date): Promise<SessionRow | null>;
  /** Update lastRefreshAt (sliding bound bookkeeping; roles re-check rides on it). */
  refreshSession(id: string, at: Date): Promise<void>;
  deleteSession(id: string): Promise<void>;
  /** SECURITY.md accepted exception: per-address first/last-seen timestamps. */
  touchAddressActivity(address: string, at: Date): Promise<void>;
}

/** Sliding inactivity bound (plan §7 Q6 proposal: 24 h unused → expired). */
export const SESSION_IDLE_SECONDS = 24 * 60 * 60;

function isLive(row: SessionRow, now: Date): boolean {
  if (row.expiresAt.getTime() <= now.getTime()) return false;
  if (row.lastRefreshAt.getTime() + SESSION_IDLE_SECONDS * 1000 <= now.getTime()) return false;
  return true;
}

// ── In-memory implementation ─────────────────────────────────────────────

export class InMemorySessionStore implements SessionStore {
  private readonly nonces = new Map<string, { address: string; expiresAt: Date }>();
  private readonly sessions = new Map<string, SessionRow>();
  private readonly activity = new Map<string, { firstSeenAt: Date; lastSeenAt: Date }>();

  async createNonce(nonce: string, address: string, expiresAt: Date): Promise<void> {
    this.nonces.set(nonce, { address, expiresAt });
  }

  async consumeNonce(nonce: string, now: Date): Promise<{ address: string } | null> {
    const row = this.nonces.get(nonce);
    if (row === undefined) return null;
    this.nonces.delete(nonce); // consume even when expired: single-use either way
    if (row.expiresAt.getTime() <= now.getTime()) return null;
    return { address: row.address };
  }

  async createSession(row: SessionRow): Promise<void> {
    this.sessions.set(row.id, { ...row });
  }

  async getSession(id: string, now: Date): Promise<SessionRow | null> {
    const row = this.sessions.get(id);
    if (row === undefined || !isLive(row, now)) return null;
    return { ...row };
  }

  async refreshSession(id: string, at: Date): Promise<void> {
    const row = this.sessions.get(id);
    if (row !== undefined) row.lastRefreshAt = at;
  }

  async deleteSession(id: string): Promise<void> {
    this.sessions.delete(id);
  }

  async touchAddressActivity(address: string, at: Date): Promise<void> {
    const existing = this.activity.get(address);
    if (existing === undefined) this.activity.set(address, { firstSeenAt: at, lastSeenAt: at });
    else existing.lastSeenAt = at;
  }
}

// ── Prisma implementation (lazy import: the client is generated code and the
//    unit suites never load it) ───────────────────────────────────────────

type PrismaClientLike = {
  session: {
    create(args: { data: SessionRow }): Promise<unknown>;
    findUnique(args: { where: { id: string } }): Promise<SessionRow | null>;
    update(args: { where: { id: string }; data: { lastRefreshAt: Date } }): Promise<unknown>;
    deleteMany(args: { where: { id: string } }): Promise<unknown>;
  };
  sessionNonce: {
    create(args: { data: { nonce: string; address: string; expiresAt: Date } }): Promise<unknown>;
    delete(args: {
      where: { nonce: string };
    }): Promise<{ nonce: string; address: string; expiresAt: Date }>;
  };
  addressActivity: {
    upsert(args: {
      where: { address: string };
      create: { address: string; firstSeenAt: Date; lastSeenAt: Date };
      update: { lastSeenAt: Date };
    }): Promise<unknown>;
  };
};

export class PrismaSessionStore implements SessionStore {
  constructor(private readonly prisma: PrismaClientLike) {}

  async createNonce(nonce: string, address: string, expiresAt: Date): Promise<void> {
    await this.prisma.sessionNonce.create({ data: { nonce, address, expiresAt } });
  }

  async consumeNonce(nonce: string, now: Date): Promise<{ address: string } | null> {
    let row: { address: string; expiresAt: Date };
    try {
      // Atomic delete-returning-row: the single replay gate. Prisma throws
      // P2025 when no row exists — absent and already-consumed are identical.
      row = await this.prisma.sessionNonce.delete({ where: { nonce } });
    } catch {
      return null;
    }
    if (row.expiresAt.getTime() <= now.getTime()) return null;
    return { address: row.address };
  }

  async createSession(row: SessionRow): Promise<void> {
    await this.prisma.session.create({ data: row });
  }

  async getSession(id: string, now: Date): Promise<SessionRow | null> {
    const row = await this.prisma.session.findUnique({ where: { id } });
    if (row === null || !isLive(row, now)) return null;
    return row;
  }

  async refreshSession(id: string, at: Date): Promise<void> {
    try {
      await this.prisma.session.update({ where: { id }, data: { lastRefreshAt: at } });
    } catch {
      // Row deleted concurrently (logout raced a refresh): nothing to update.
    }
  }

  async deleteSession(id: string): Promise<void> {
    await this.prisma.session.deleteMany({ where: { id } });
  }

  async touchAddressActivity(address: string, at: Date): Promise<void> {
    await this.prisma.addressActivity.upsert({
      where: { address },
      create: { address, firstSeenAt: at, lastSeenAt: at },
      update: { lastSeenAt: at },
    });
  }
}

let storeSingleton: SessionStore | undefined;

/**
 * Process-wide store: Prisma when DATABASE_URL is configured, else the
 * non-durable in-memory store (dev/mock posture — a warning makes the
 * non-durability loud outside development).
 */
export async function getSessionStore(config: {
  databaseUrl?: string | undefined;
  appEnv: string;
}): Promise<SessionStore> {
  if (storeSingleton !== undefined) return storeSingleton;
  if (config.databaseUrl !== undefined) {
    const { PrismaClient } = await import("@prisma/client");
    storeSingleton = new PrismaSessionStore(
      new PrismaClient({
        datasources: { db: { url: config.databaseUrl } },
      }) as unknown as PrismaClientLike,
    );
  } else {
    if (config.appEnv !== "development") {
      console.warn(
        "[nvhash-web] DATABASE_URL is not configured — sessions are in-memory and " +
          "will not survive a restart. Production profiles must set it.",
      );
    }
    storeSingleton = new InMemorySessionStore();
  }
  return storeSingleton;
}

/** Test seam: reset the process-wide store singleton. */
export function resetSessionStoreForTests(): void {
  storeSingleton = undefined;
}
