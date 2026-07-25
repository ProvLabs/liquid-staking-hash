// Security-executable gate (plan 5.1 §4.8): the `app` schema carries ONLY
// the PR 5.1 scope — sessions, single-use nonces, and the SECURITY.md
// accepted first/last-seen exception. No PII, no IP/device identifiers, and
// deliberately NO role column anywhere (roles are live chain facts, spec §4).
// The indexer's schema-allowlist pattern, pointed at apps/web/prisma.
//
// Adding a column is a design-review event: it must be added HERE (forcing
// the data-minimization review) — a migration alone fails CI.

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

/** The complete allowed column set — PR 5.1 scope + the M6.2 alert domain. */
const ALLOWED_FIELDS: Record<string, readonly string[]> = {
  Session: ["id", "address", "createdAt", "expiresAt", "lastRefreshAt"],
  SessionNonce: ["nonce", "address", "createdAt", "expiresAt"],
  // SECURITY.md accepted exception (Ira, 2026-07-13): first/last-seen only.
  AddressActivity: ["address", "firstSeenAt", "lastSeenAt"],
  // M6.2 alert domain (plan §2.1 design review). Every column is public chain
  // data (`address`), a closed enum (`kind`), a preference bit (`enabled`), a
  // replay-stable event id (`dedupeKey`), a minimal identifier-only payload,
  // an ordinal cursor, or operational metadata — nothing identity/device/IP-
  // shaped. A column beyond these lists is a stop-and-ask event (plan §8).
  AlertRule: ["address", "kind", "enabled", "createdAt", "updatedAt"],
  Notification: ["id", "address", "kind", "dedupeKey", "payload", "deliveredAt", "readAt"],
  NotifierCheckpoint: ["stream", "cursor", "updatedAt"],
  // M6.3 Web Push channel (plan §2.1 design review) — the ONE accepted
  // SECURITY.md exception (Ira, 2026-07-13): opt-in, opaque, revocable push
  // tokens deleted on opt-out/session removal. `address`/`sessionId` are the
  // existing public/scoping identifiers; the `endpoint`/`p256dh`/`auth` triple
  // IS the accepted-exception token material (opaque, never logged);
  // `createdAt` is minimal operational metadata (the cap evicts oldest by id).
  // Nothing else may join — no user-agent, no device label, no per-row counter.
  PushSubscription: ["id", "address", "sessionId", "endpoint", "p256dh", "auth", "createdAt"],
};

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
  it("parses exactly the app-schema models (PR 5.1 + M6.2 alert domain + M6.3 push)", () => {
    expect(models.map((m) => m.name).sort()).toEqual([
      "AddressActivity",
      "AlertRule",
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
          if (lowered.includes(forbidden)) violations.push(`${model.name}.${field} ("${forbidden}")`);
        }
      }
    }
    expect(violations, `forbidden columns: ${violations.join(", ")}`).toEqual([]);
  });
});
