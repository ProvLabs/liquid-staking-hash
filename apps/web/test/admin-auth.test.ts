// The `admin:` MINT GATE (plan invariant 2): an `admin:` assertion is minted
// only after a FRESH on-chain membership read, and a DEGRADED read mints
// nothing. The other half of the invariant — that the read bypasses the 60 s
// role cache — is pinned in test/roles.test.ts, where the cache lives.
//
// Separate from test/assertion.test.ts because the gate is a separate module:
// minting must stay dependency-free for the notifier entrypoint, so the chain
// read lives here and so does its suite.

import { http, HttpResponse } from "msw";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { loadConfig } from "~/config/config.server";
import { adminApiHeaders } from "~/lib/services/admin-auth.server";
import { resetRoleCacheForTests } from "~/lib/services/roles.server";
import {
  FIXTURE_CHAIN_ID,
  FIXTURE_CONTRACT_ADDRESS,
  FIXTURE_VAULT_ADDRESS,
} from "~/mocks/handlers";
import { server } from "~/mocks/node";

// The cross-pinned vector literals, imported from the minting suite that owns
// them rather than copied — a copy here could drift silently.
import { VECTOR_ADMIN_HEADER, VECTOR_IAT, VECTOR_KEY } from "./assertion.test";

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());
beforeEach(() => resetRoleCacheForTests());

const adminConfig = loadConfig({
  APP_ENV: "development",
  CHAIN_ID: FIXTURE_CHAIN_ID,
  LCD_URL: "http://lcd.mock:1317",
  CONTRACT_ADDRESS: FIXTURE_CONTRACT_ADDRESS,
  VAULT_ADDRESS: FIXTURE_VAULT_ADDRESS,
  CONSOLE_URL: "https://console.example",
  CONSOLE_CHAIN_ID: FIXTURE_CHAIN_ID,
  API_URL: "http://api.mock:8787",
  API_SERVICE_ASSERTION_KEY: VECTOR_KEY,
} as NodeJS.ProcessEnv);

/** The `Config {}` admin in the captured corpus — a group-policy account. */
const CONTRACT_ADMIN = "tp18kkn20p7dphkal2x84t30cv7z6v9rf9cvykjhk";
const MEMBER = "tp1l39wu7cht0zcycc5rkcd90sdd4ksjmxwdf388y";
const OUTSIDER = "tp1xj828fwstxajpn95mq07mw0ztn449lxx65skad";

/** Group-policy + members handlers with a parameterized member set. */
function groupHandlers(members: string[]) {
  return [
    http.get("*/cosmos/group/v1/group_policy_info/:address", ({ params }) =>
      params["address"] === CONTRACT_ADMIN
        ? HttpResponse.json({
            info: {
              address: CONTRACT_ADMIN,
              group_id: "1",
              admin: CONTRACT_ADMIN,
              metadata: "",
              version: "1",
              decision_policy: {
                "@type": "/cosmos.group.v1.ThresholdDecisionPolicy",
                threshold: "2",
                windows: { voting_period: "300s", min_execution_period: "0s" },
              },
              created_at: "2026-07-01T00:00:00Z",
            },
          })
        : HttpResponse.json({ code: 2, message: "not found", details: [] }, { status: 404 }),
    ),
    http.get("*/cosmos/group/v1/group_members/:groupId", () =>
      HttpResponse.json({
        members: members.map((address) => ({
          group_id: "1",
          member: { address, weight: "1", metadata: "", added_at: "2026-07-01T00:00:00Z" },
        })),
        pagination: { next_key: null, total: String(members.length) },
      }),
    ),
  ];
}

describe("admin: assertion minting (invariant 2 — fresh read, or nothing)", () => {
  it("mints for a member, and the bytes are the cross-pinned vector", async () => {
    server.use(...groupHandlers([MEMBER]));
    const result = await adminApiHeaders(adminConfig, MEMBER, {}, VECTOR_IAT);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.headers).toEqual({ Authorization: VECTOR_ADMIN_HEADER });
  });

  it("mints NOTHING for a non-member (the read succeeded and said no)", async () => {
    server.use(...groupHandlers([MEMBER]));
    const result = await adminApiHeaders(adminConfig, OUTSIDER, {}, VECTOR_IAT);
    expect(result).toEqual({ ok: false, reason: "not-admin" });
  });

  it("mints NOTHING on a DEGRADED read — never a hopeful assertion", async () => {
    // The contract `Config {}` read fails, so membership is unknown. The App
    // does not guess a privilege (SECURITY.md: never lie about state), and the
    // caller gets a reason it can render as "we could not check" rather than
    // as "you are not an admin".
    server.use(
      http.get("*/cosmwasm/wasm/v1/contract/:address/smart/:query", () =>
        HttpResponse.json({ code: 2, message: "unavailable", details: [] }, { status: 503 }),
      ),
    );
    const result = await adminApiHeaders(adminConfig, MEMBER, {}, VECTOR_IAT);
    expect(result).toEqual({ ok: false, reason: "degraded" });
  });

  it("reports DEGRADED when only the x/group read fails — not `not-admin`", async () => {
    // The contract `Config {}` read succeeds and the membership query is what
    // fails. `not-admin` here would render "this address is not a program
    // administrator" to a real administrator on the strength of a read that
    // never happened; `/admin` must say "we could not check" instead
    // (plan invariant 17).
    server.use(
      ...groupHandlers([MEMBER]).slice(0, 1),
      http.get("*/cosmos/group/v1/group_members/:groupId", () =>
        HttpResponse.json({ code: 2, message: "unavailable", details: [] }, { status: 503 }),
      ),
    );
    const result = await adminApiHeaders(adminConfig, MEMBER, {}, VECTOR_IAT);
    expect(result).toEqual({ ok: false, reason: "degraded" });
  });

  it("mints NOTHING with no assertion key, and never reaches the chain to find out", async () => {
    // `onUnhandledRequest: "error"` is the assertion here: with no key
    // configured there must be no membership read at all — the answer cannot
    // depend on the chain when nothing could be minted either way.
    const unconfigured = loadConfig({
      APP_ENV: "development",
      CHAIN_ID: FIXTURE_CHAIN_ID,
      LCD_URL: "http://lcd.mock:1317",
      CONTRACT_ADDRESS: FIXTURE_CONTRACT_ADDRESS,
      VAULT_ADDRESS: FIXTURE_VAULT_ADDRESS,
      CONSOLE_URL: "https://console.example",
      CONSOLE_CHAIN_ID: FIXTURE_CHAIN_ID,
      API_URL: "http://api.mock:8787",
    } as NodeJS.ProcessEnv);
    const result = await adminApiHeaders(unconfigured, MEMBER, {}, VECTOR_IAT);
    expect(result).toEqual({ ok: false, reason: "unconfigured" });
  });
});
