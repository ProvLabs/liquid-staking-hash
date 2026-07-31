// Security-executable gate: the `app` schema carries ONLY
// the accepted scope — sessions, single-use nonces, and the SECURITY.md
// accepted first/last-seen exception. No PII, no IP/device identifiers, and
// deliberately NO role column anywhere (roles are live chain facts, spec §4).
// The indexer's schema-allowlist pattern, pointed at apps/web/prisma.
//
// Adding a column is a design-review event: it must be added HERE (forcing
// the data-minimization review) — a migration alone fails CI.
//
// TWO GATES LIVE HERE, and the second is narrower than the first. The global
// allowlist above holds every model to its reviewed column set. The FUNNEL
// denylist below additionally holds `FunnelCounter` to a per-model rule —
// `address` is legitimate on Session and forbidden on the counters — which is
// the master plan §4 security-executable check, "analytics counters are never
// keyed by wallet, session or device", standing in `apps/web` CI from PR
// 7.5–7.6 on (app-spec §14.10 enforcement clause).

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PRISMA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "prisma");

interface PrismaModel {
  name: string;
  fields: string[];
}

function parseModels(): PrismaModel[] {
  const source = readdirSync(PRISMA_DIR)
    .filter((f) => f.endsWith(".prisma"))
    .sort()
    .map((f) => readFileSync(join(PRISMA_DIR, f), "utf8"))
    .join("\n");
  const models: PrismaModel[] = [];
  const modelRe = /model\s+(\w+)\s*\{([^}]*)\}/g;
  let match: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: the canonical `exec` iteration idiom; `match` is explicitly typed and compared to null.
  while ((match = modelRe.exec(source)) !== null) {
    const fields: string[] = [];
    for (const rawLine of match[2]!.split("\n")) {
      const line = rawLine.trim();
      if (line === "" || line.startsWith("//") || line.startsWith("@@")) continue;
      const fieldMatch = /^(\w+)\s+[A-Za-z0-9_]+(?:\[\])?\??\s*/.exec(line);
      if (fieldMatch) fields.push(fieldMatch[1]!);
    }
    models.push({ name: match[1]!, fields });
  }
  return models;
}

/** The complete allowed column set — session scope + the alert domain. */
const ALLOWED_FIELDS: Record<string, readonly string[]> = {
  Session: ["id", "address", "createdAt", "expiresAt", "lastRefreshAt"],
  SessionNonce: ["nonce", "address", "createdAt", "expiresAt"],
  // SECURITY.md accepted exception (Ira, 2026-07-13): first/last-seen only.
  AddressActivity: ["address", "firstSeenAt", "lastSeenAt"],
  // Alert domain (design review). Every column is public chain
  // data (`address`), a closed enum (`kind`), a preference bit (`enabled`), a
  // replay-stable event id (`dedupeKey`), a minimal identifier-only payload,
  // an ordinal cursor, or operational metadata — nothing identity/device/IP-
  // shaped. A column beyond these lists is a stop-and-ask event.
  AlertRule: ["address", "kind", "enabled", "createdAt", "updatedAt"],
  Notification: ["id", "address", "kind", "dedupeKey", "payload", "deliveredAt", "readAt"],
  NotifierCheckpoint: ["stream", "cursor", "updatedAt"],
  // Web Push channel (design review) — the ONE accepted
  // SECURITY.md exception (Ira, 2026-07-13): opt-in, opaque, revocable push
  // tokens deleted on opt-out/session removal. `address`/`sessionId` are the
  // existing public/scoping identifiers; the `endpoint`/`p256dh`/`auth` triple
  // IS the accepted-exception token material (opaque, never logged);
  // `createdAt` is minimal operational metadata (the cap evicts oldest by id).
  // Nothing else may join — no user-agent, no device label, no per-row counter.
  PushSubscription: ["id", "address", "sessionId", "endpoint", "p256dh", "auth", "createdAt"],
  // Admin acknowledgment of an indexer-computed incident (design review, plan
  // §2.3 / §7 Q2). `incidentId` references `indexed.incidents` BY ID with no
  // cross-schema FK (ADR-001 Decision 1) — the web tier never writes
  // `incidents`. `acknowledgedBy` is a bech32 address (public chain data, and
  // the SESSION address only). `unacknowledgedAt` exists so reversal preserves
  // the trail instead of deleting it. `note` is operator text ABOUT AN
  // INCIDENT, not about a person, bounded at 500 chars (Ira, 2026-07-31) —
  // deliberately admitted here so the bound is reviewed, not discovered.
  IncidentAck: ["id", "incidentId", "acknowledgedBy", "acknowledgedAt", "unacknowledgedAt", "note"],
  // Aggregate funnel counters (§14.10). EXACTLY three columns and no more:
  // the row IS the aggregate, so there is no per-person record to restrain.
  // Retention: 400 days of day rows, then swept (Ira, 2026-07-31). `day` is
  // UTC. Adding a column here is a design-review event, not an implementation
  // choice — and FUNNEL_FORBIDDEN_SUBSTRINGS below makes the common mistakes
  // fail CI on the name alone.
  FunnelCounter: ["stage", "day", "count"],
};

/**
 * Models whose column names are held to the FUNNEL denylist as well as the
 * global one. Scoped rather than global because `address` is legitimate on
 * every other `app` model and forbidden on this one — a per-model rule is the
 * only way to say that.
 */
const FUNNEL_DOMAIN_MODELS = ["FunnelCounter"];

/**
 * The §14.10 / plan invariant 6 denylist. The master plan §4
 * security-executable check — "analytics counters are never keyed by wallet,
 * session or device" — is THIS list, gating `apps/web` CI from PR 7.5–7.6 on.
 *
 * Its limit, stated because it must not be mistaken for more than it is: this
 * checks column NAMES, not cardinality. Columns that are individually innocuous
 * can still be jointly identifying — a sufficiently granular page class crossed
 * with a day can isolate a single rare visitor without any column being called
 * `address`. That is why the stage enum's membership is a privacy decision made
 * in review (plan §7.1 Q3), not something this gate can decide.
 */
const FUNNEL_FORBIDDEN_SUBSTRINGS = [
  "address",
  "wallet",
  "session",
  "device",
  "ip",
  "user",
  "fingerprint",
];

/**
 * Identity / network / device markers that must never appear in a column
 * name — plus "role": the sessions schema stores no role by design.
 */
const FORBIDDEN_FIELD_SUBSTRINGS = [
  "email",
  "phone",
  "passport",
  "ssn",
  "ip_",
  "ipaddr",
  "device",
  "useragent",
  "user_agent",
  "fingerprint",
  "role",
];

const models = parseModels();

describe("app schema field allowlist (SECURITY.md data minimization)", () => {
  it("parses exactly the app-schema models (sessions + alerts + push + admin)", () => {
    expect(models.map((m) => m.name).sort()).toEqual([
      "AddressActivity",
      "AlertRule",
      "FunnelCounter",
      "IncidentAck",
      "Notification",
      "NotifierCheckpoint",
      "PushSubscription",
      "Session",
      "SessionNonce",
    ]);
  });

  it("every column is on its model's allowlist", () => {
    const violations: string[] = [];
    for (const model of models) {
      const allowed = ALLOWED_FIELDS[model.name] ?? [];
      for (const field of model.fields) {
        if (!allowed.includes(field)) violations.push(`${model.name}.${field}`);
      }
    }
    expect(
      violations,
      `columns outside the allowed-fields list (data-minimization review required): ${violations.join(", ")}`,
    ).toEqual([]);
  });

  it("every allowlisted column actually exists (the list cannot go stale)", () => {
    for (const [name, allowed] of Object.entries(ALLOWED_FIELDS)) {
      const model = models.find((m) => m.name === name);
      expect(model, `model ${name} missing from the schema`).toBeDefined();
      expect(model!.fields.sort()).toEqual([...allowed].sort());
    }
  });

  it("no column name matches a forbidden identity/device/role substring", () => {
    const violations: string[] = [];
    for (const model of models) {
      for (const field of model.fields) {
        const lowered = field.toLowerCase();
        for (const forbidden of FORBIDDEN_FIELD_SUBSTRINGS) {
          if (lowered.includes(forbidden))
            violations.push(`${model.name}.${field} ("${forbidden}")`);
        }
      }
    }
    expect(violations, `forbidden columns: ${violations.join(", ")}`).toEqual([]);
  });
});

describe("funnel counters are never keyed by wallet, session or device (§14.10)", () => {
  it("FunnelCounter's columns are EXACTLY {stage, day, count}", () => {
    const model = models.find((m) => m.name === "FunnelCounter");
    expect(model, "FunnelCounter missing from the schema").toBeDefined();
    // Written as an exact equality rather than a subset check: the point is
    // that the row IS the aggregate, which a fourth column of any kind would
    // stop being true.
    expect(model!.fields.slice().sort()).toEqual(["count", "day", "stage"]);
  });

  it("no funnel-domain column name matches the identifier denylist", () => {
    const violations: string[] = [];
    for (const name of FUNNEL_DOMAIN_MODELS) {
      const model = models.find((m) => m.name === name);
      expect(model, `${name} missing from the schema`).toBeDefined();
      for (const field of model!.fields) {
        const lowered = field.toLowerCase();
        for (const forbidden of FUNNEL_FORBIDDEN_SUBSTRINGS) {
          if (lowered.includes(forbidden)) violations.push(`${name}.${field} ("${forbidden}")`);
        }
      }
    }
    expect(violations, `identifier-shaped funnel columns: ${violations.join(", ")}`).toEqual([]);
  });

  it("the denylist actually rejects the columns it exists to reject", () => {
    // The gate is only worth having if it fails when it should, so the
    // predicate is exercised against the names a well-meaning change would
    // reach for. Without this, a typo'd or accidentally-empty denylist passes
    // every run and nobody finds out.
    const trips = (field: string): boolean =>
      FUNNEL_FORBIDDEN_SUBSTRINGS.some((f) => field.toLowerCase().includes(f));
    for (const tempting of [
      "address",
      "walletAddress",
      "sessionId",
      "deviceId",
      "ipHash",
      "userId",
      "fingerprint",
      "visitorFingerprint",
    ]) {
      expect(trips(tempting), `${tempting} must be rejected`).toBe(true);
    }
    // And does not reject the three legitimate ones, or the gate would be
    // unsatisfiable rather than protective.
    for (const allowed of ["stage", "day", "count"]) {
      expect(trips(allowed), `${allowed} must be allowed`).toBe(false);
    }
  });

  it("scopes the funnel denylist to the funnel domain, not the whole schema", () => {
    // `address` is legitimate on Session, AlertRule, Notification and
    // IncidentAck — it is public chain data there. The denylist must be a
    // per-model rule, so this asserts the scoping rather than leaving a future
    // reader to assume a global list was somehow satisfied.
    expect(FUNNEL_DOMAIN_MODELS).toEqual(["FunnelCounter"]);
    const withAddress = models
      .filter((m) => m.fields.includes("address"))
      .map((m) => m.name)
      .sort();
    expect(withAddress).toEqual([
      "AddressActivity",
      "AlertRule",
      "Notification",
      "PushSubscription",
      "Session",
      "SessionNonce",
    ]);
  });
});
