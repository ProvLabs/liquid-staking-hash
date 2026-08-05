// Incident-acknowledgment persistence — the models layer (a Prisma import
// site; the AlertStore precedent). Two implementations behind one port, both
// exercised by test/incident-acks.test.ts.
//
// WHAT THIS WRITES AND WHAT IT NEVER WRITES. It writes `app.incident_acks` and
// nothing else. `indexed.incidents` is the indexer's, and `app_writer` holds no
// grants there at all, so "the web tier never writes incidents" is a GRANT, not
// a convention (ADR-001 Decision 1; the standing grant-boundary gate).
//
// CONCURRENCY IS THE DATABASE'S JOB. Two admins acknowledging the same incident
// at the same moment are separated by the partial unique index
// `incident_acks_live_ack_key` — never by an application-level "already acked?"
// read followed by a write, which is the shape of the bug that lost batched
// payments (plan §4b C3). `AckConflict` is what that constraint violation looks
// like to a caller, so the race has an explicit answer instead of
// last-write-wins.
//
// REVERSAL PRESERVES HISTORY: un-acknowledging stamps `unacknowledgedAt` rather
// than deleting the row. The trail survives, and the partial index frees the
// (incident, admin) pair for a fresh acknowledgment.

/** One acknowledgment record, live or reversed. */
export interface IncidentAckRecord {
  id: bigint;
  incidentId: number;
  /** bech32 address of the acknowledging admin — the SESSION address. */
  acknowledgedBy: string;
  acknowledgedAt: Date;
  /** Null while live; set on reversal. */
  unacknowledgedAt: Date | null;
  note: string | null;
}

/** Re-exported so this module's callers have one import site. The DECLARATION
 * is in `@nvhash/api-types/bounds.ts` — the admin UI's input needs it too, and
 * a client component must not import a `*.server.ts` module. */
export { MAX_ACK_NOTE_LENGTH } from "@nvhash/api-types";

/**
 * Thrown when the partial unique index refuses a second LIVE acknowledgment of
 * the same incident by the same admin. A real outcome, not an internal error:
 * the caller answers 409 and re-renders the existing ack.
 */
export class AckConflict extends Error {
  constructor() {
    super("This incident already has a live acknowledgment from this address.");
    this.name = "AckConflict";
  }
}

export interface IncidentAckStore {
  /**
   * Record a live acknowledgment. Throws {@link AckConflict} when one already
   * exists for `(incidentId, acknowledgedBy)`.
   *
   * `note` must already be bounded by the caller; over-length is a caller bug,
   * not a truncation this layer performs silently.
   */
  acknowledge(
    incidentId: number,
    acknowledgedBy: string,
    note: string | null,
    now: Date,
  ): Promise<IncidentAckRecord>;
  /**
   * Reverse the caller's OWN live acknowledgment of `incidentId`, stamping
   * `unacknowledgedAt`. Returns null when they have none — never touches
   * another admin's ack, because `acknowledgedBy` is part of the predicate.
   */
  unacknowledge(
    incidentId: number,
    acknowledgedBy: string,
    now: Date,
  ): Promise<IncidentAckRecord | null>;
  /**
   * The LIVE acknowledgment per incident for `incidentIds`, keyed by incident
   * id. Incidents with no live ack are absent from the map (never a fabricated
   * "unacknowledged" record).
   */
  liveAcksFor(incidentIds: readonly number[]): Promise<Map<number, IncidentAckRecord>>;
}

// ── In-memory implementation ─────────────────────────────────────────────

export class InMemoryIncidentAckStore implements IncidentAckStore {
  private readonly rows: IncidentAckRecord[] = [];
  private nextId = 1n;

  /** Test seam: seed a row directly (e.g. another admin's existing ack). */
  seed(record: Omit<IncidentAckRecord, "id">): void {
    this.rows.push({ id: this.nextId++, ...record });
  }

  private live(incidentId: number, by: string): IncidentAckRecord | undefined {
    return this.rows.find(
      (r) => r.incidentId === incidentId && r.acknowledgedBy === by && r.unacknowledgedAt === null,
    );
  }

  async acknowledge(
    incidentId: number,
    acknowledgedBy: string,
    note: string | null,
    now: Date,
  ): Promise<IncidentAckRecord> {
    // Stands in for the partial unique index, so both stores answer a duplicate
    // the same way and the contract test can run against either.
    if (this.live(incidentId, acknowledgedBy) !== undefined) throw new AckConflict();
    const record: IncidentAckRecord = {
      id: this.nextId++,
      incidentId,
      acknowledgedBy,
      acknowledgedAt: now,
      unacknowledgedAt: null,
      note,
    };
    this.rows.push(record);
    return { ...record };
  }

  async unacknowledge(
    incidentId: number,
    acknowledgedBy: string,
    now: Date,
  ): Promise<IncidentAckRecord | null> {
    const row = this.live(incidentId, acknowledgedBy);
    if (row === undefined) return null;
    row.unacknowledgedAt = now;
    return { ...row };
  }

  async liveAcksFor(incidentIds: readonly number[]): Promise<Map<number, IncidentAckRecord>> {
    const wanted = new Set(incidentIds);
    const map = new Map<number, IncidentAckRecord>();
    for (const row of this.rows) {
      if (row.unacknowledgedAt !== null || !wanted.has(row.incidentId)) continue;
      map.set(row.incidentId, { ...row });
    }
    return map;
  }
}

// ── Prisma implementation (lazy import: generated code the unit suites skip) ──

/**
 * What a violation of `incident_acks_live_ack_key` looks like coming back.
 * BOTH codes are checked: Prisma maps Postgres 23505 to `P2002`, but that
 * mapping is documented for constraints Prisma knows from the schema, and this
 * index is hand-written in the migration precisely because Prisma cannot
 * express a partial unique. Matching the raw SQLSTATE too means a mapping gap
 * surfaces as a 409 rather than as a 500 on a race that has a correct answer.
 */
const UNIQUE_VIOLATION_CODES = ["P2002", "23505"];

/**
 * What Prisma returns for this model. `incidentId` is a `bigint` on the way out
 * because the column is BIGINT (it references `indexed.incidents.id`, a
 * BIGSERIAL); {@link IncidentAckRecord} carries a `number` because the wire
 * does, guarded into the safe-integer domain by the API's id mapper. The
 * conversion happens HERE, at the one boundary where both domains are visible.
 */
interface IncidentAckRow extends Omit<IncidentAckRecord, "incidentId"> {
  incidentId: bigint;
}

interface IncidentAckPrismaLike {
  incidentAck: {
    create(args: unknown): Promise<IncidentAckRow>;
    findFirst(args: unknown): Promise<IncidentAckRow | null>;
    findMany(args: unknown): Promise<IncidentAckRow[]>;
    updateMany(args: unknown): Promise<{ count: number }>;
  };
}

/** Row → record. The id came from a BIGINT column but originated as a wire
 * number, so `Number` is lossless for every value this table can hold. */
function toAckRecord(row: IncidentAckRow): IncidentAckRecord {
  return { ...row, incidentId: Number(row.incidentId) };
}

function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && UNIQUE_VIOLATION_CODES.includes(code);
}

export class PrismaIncidentAckStore implements IncidentAckStore {
  private readonly prisma: IncidentAckPrismaLike;

  constructor(prisma: IncidentAckPrismaLike) {
    this.prisma = prisma;
  }

  async acknowledge(
    incidentId: number,
    acknowledgedBy: string,
    note: string | null,
    now: Date,
  ): Promise<IncidentAckRecord> {
    try {
      // An unconditional INSERT: the partial unique index decides whether a
      // live ack already exists. Checking first and then inserting would be
      // exactly the read-then-write C3 forbids — two admins can both pass the
      // check before either writes.
      return toAckRecord(
        await this.prisma.incidentAck.create({
          data: { incidentId: BigInt(incidentId), acknowledgedBy, acknowledgedAt: now, note },
        }),
      );
    } catch (error) {
      if (isUniqueViolation(error)) throw new AckConflict();
      throw error;
    }
  }

  async unacknowledge(
    incidentId: number,
    acknowledgedBy: string,
    now: Date,
  ): Promise<IncidentAckRecord | null> {
    // A CONDITIONAL update, not find-then-update. `unacknowledgedAt: null` is
    // part of the WHERE, so the row is claimed in one statement under its own
    // lock: two concurrent reversals cannot both find a live ack and then both
    // stamp it, which is the last-write-wins on a nullable column that C3
    // forbids by name. The loser sees `count === 0` and gets the same "no live
    // ack" answer as someone reversing nothing.
    //
    // `acknowledgedBy` is in the predicate too, so this cannot reach another
    // admin's acknowledgment however the id was supplied.
    const { count } = await this.prisma.incidentAck.updateMany({
      where: { incidentId: BigInt(incidentId), acknowledgedBy, unacknowledgedAt: null },
      data: { unacknowledgedAt: now },
    });
    if (count === 0) return null;
    // Read back the row this call just stamped. Not a race: `unacknowledgedAt`
    // is now set, so no other reversal can claim or re-stamp it.
    const row = await this.prisma.incidentAck.findFirst({
      where: { incidentId: BigInt(incidentId), acknowledgedBy, unacknowledgedAt: now },
    });
    return row === null ? null : toAckRecord(row);
  }

  async liveAcksFor(incidentIds: readonly number[]): Promise<Map<number, IncidentAckRecord>> {
    if (incidentIds.length === 0) return new Map();
    const rows = await this.prisma.incidentAck.findMany({
      where: { incidentId: { in: incidentIds.map(BigInt) }, unacknowledgedAt: null },
    });
    return new Map(rows.map(toAckRecord).map((r) => [r.incidentId, r]));
  }
}

// ── Process-wide store ────────────────────────────────────────────────────

let storePromise: Promise<IncidentAckStore> | undefined;

async function createStore(config: {
  databaseUrl?: string | undefined;
  appEnv: string;
}): Promise<IncidentAckStore> {
  if (config.databaseUrl !== undefined) {
    const { PrismaClient } = await import("@prisma/client");
    return new PrismaIncidentAckStore(
      new PrismaClient({
        datasources: { db: { url: config.databaseUrl } },
      }) as unknown as IncidentAckPrismaLike,
    );
  }
  if (config.appEnv !== "development") {
    console.warn(
      "[nvhash-web] DATABASE_URL is not configured — incident acknowledgments are " +
        "in-memory and will not survive a restart. Production profiles must set it.",
    );
  }
  return new InMemoryIncidentAckStore();
}

/**
 * Process-wide acknowledgment store: Prisma when DATABASE_URL is configured,
 * else the non-durable in-memory store (the alert-store posture). Unlike the
 * funnel counters this DOES warn outside development: an acknowledgment is an
 * audit record, and losing one silently is a different class of loss than
 * losing a tally.
 */
export function getIncidentAckStore(config: {
  databaseUrl?: string | undefined;
  appEnv: string;
}): Promise<IncidentAckStore> {
  if (storePromise === undefined) {
    const promise = createStore(config);
    promise.catch(() => {
      if (storePromise === promise) storePromise = undefined;
    });
    storePromise = promise;
  }
  return storePromise;
}

/** Test seam: reset the process-wide store singleton. */
export function resetIncidentAckStoreForTests(): void {
  storePromise = undefined;
}
