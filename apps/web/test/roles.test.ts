// Role-detection gate: roles are LIVE on-chain facts —
// operator from the contract's Validators {} operator set, admin from the
// x/group policy membership behind Config.admin — re-checked per refresh and
// never persisted. The pinned behavior: remove the address from the group
// fixture and the next (cache-expired) refresh loses admin. Chain-read
// failure degrades to no-roles + degraded, and degraded results are not
// cached.

import { http, HttpResponse } from "msw";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { loadConfig } from "~/config/config.server";
import {
  detectRoles,
  resetRoleCacheForTests,
  ROLE_CACHE_TTL_SECONDS,
  verifyAdminUncached,
} from "~/lib/services/roles.server";
import {
  FIXTURE_CHAIN_ID,
  FIXTURE_CONTRACT_ADDRESS,
  FIXTURE_VAULT_ADDRESS,
} from "~/mocks/handlers";
import { server } from "~/mocks/node";

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());
beforeEach(() => resetRoleCacheForTests());

const config = loadConfig({
  APP_ENV: "development",
  CHAIN_ID: FIXTURE_CHAIN_ID,
  LCD_URL: "http://lcd.mock:1317",
  CONTRACT_ADDRESS: FIXTURE_CONTRACT_ADDRESS,
  VAULT_ADDRESS: FIXTURE_VAULT_ADDRESS,
  CONSOLE_URL: "https://console.example",
  CONSOLE_CHAIN_ID: FIXTURE_CHAIN_ID,
  API_URL: "http://api.mock:8787",
} as NodeJS.ProcessEnv);

// Addresses from the captured corpus (@nvhash/fixtures):
const OPERATOR = "tp1l39wu7cht0zcycc5rkcd90sdd4ksjmxwdf388y"; // validators fixture operator
const CONTRACT_ADMIN = "tp18kkn20p7dphkal2x84t30cv7z6v9rf9cvykjhk"; // config fixture admin
const NOBODY = "tp1xj828fwstxajpn95mq07mw0ztn449lxx65skad";

// The corpus carries group_policy_info / group_members. These handlers keep the
// local override so the member set stays a test parameter, but their SHAPES are
// the captured ones: notably `decision_policy` is served INLINE and is a real
// object, never `null`. A stub serving `null` is rejected by the parser, which
// is corpus drift-detection working: such a stub describes a response the chain
// never sends.
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

describe("role detection (live chain facts, spec §4)", () => {
  it("detects operator from the contract Validators {} operator set", async () => {
    server.use(...groupHandlers([]));
    const roles = await detectRoles(config, OPERATOR);
    expect(roles).toEqual({ operator: true, admin: false, degraded: false });
  });

  it("detects admin from group-policy membership behind Config.admin", async () => {
    server.use(...groupHandlers([NOBODY]));
    const roles = await detectRoles(config, NOBODY);
    expect(roles.admin).toBe(true);
    expect(roles.operator).toBe(false);
  });

  it("LOSES admin on the next refresh after membership is removed", async () => {
    let now = 1_750_000_000_000;
    const deps = { now: () => now };

    server.use(...groupHandlers([NOBODY]));
    expect((await detectRoles(config, NOBODY, deps)).admin).toBe(true);

    // Membership removed on chain; within the TTL the cache still answers.
    server.resetHandlers();
    server.use(...groupHandlers([]));
    expect((await detectRoles(config, NOBODY, deps)).admin).toBe(true);

    // Past the TTL the next refresh re-reads the chain and loses the role.
    now += (ROLE_CACHE_TTL_SECONDS + 1) * 1000;
    expect((await detectRoles(config, NOBODY, deps)).admin).toBe(false);
  });

  it("falls back to direct admin equality when Config.admin is a plain account", async () => {
    // No group handlers at all: policy lookup 404s via MSW's unhandled-error?
    // No — provide an explicit 404 so the read path is deterministic.
    server.use(
      http.get("*/cosmos/group/v1/group_policy_info/:address", () =>
        HttpResponse.json({ code: 2, message: "not found", details: [] }, { status: 404 }),
      ),
    );
    expect((await detectRoles(config, CONTRACT_ADMIN)).admin).toBe(true);
    resetRoleCacheForTests();
    expect((await detectRoles(config, NOBODY)).admin).toBe(false);
  });

  it("degrades to no roles on chain failure — and does not cache the failure", async () => {
    server.use(
      http.get("*/cosmwasm/wasm/v1/contract/:address/smart/:query", () =>
        HttpResponse.json({ code: 2, message: "unavailable", details: [] }, { status: 503 }),
      ),
    );
    const degraded = await detectRoles(config, OPERATOR);
    expect(degraded).toEqual({ operator: false, admin: false, degraded: true });

    // Chain recovers: the very next call re-reads (no cached failure).
    server.resetHandlers();
    server.use(...groupHandlers([]));
    const recovered = await detectRoles(config, OPERATOR);
    expect(recovered).toEqual({ operator: true, admin: false, degraded: false });
  });
});

// ── The mint-time cache bypass (invariant 2) ────────────────────────────────
//
// THE difference between the ADR's claim and its implementation. `detectRoles`
// is allowed to answer a revoked admin "yes" for up to ROLE_CACHE_TTL_SECONDS —
// that is correct for rendering. `verifyAdminUncached` must not, because its
// answer mints a capability. The pinned behavior: revoke membership on chain
// and the very NEXT uncached check fails, with no TTL advanced.
//
// What this does NOT claim, and must not: that stale-admin access is
// eliminated. An assertion already minted stays valid for its remaining
// lifetime, so the residual window is the assertion's ≤ 60 s — down from the
// cache's 60 s PLUS the assertion's, not down to zero.

describe("admin membership at MINT time bypasses the role cache (invariant 2)", () => {
  it("loses admin on the very next check after revocation — no TTL wait", async () => {
    // A frozen clock: any TTL-driven expiry would need it to advance, so a pass
    // here cannot be the cache quietly timing out instead of being bypassed.
    const now = 1_750_000_000_000;
    const deps = { now: () => now };

    server.use(...groupHandlers([NOBODY]));
    // Warm the cache through the RENDERING path first, so there is a cached
    // "admin: true" for the mint path to ignore.
    expect((await detectRoles(config, NOBODY, deps)).admin).toBe(true);
    expect(await verifyAdminUncached(config, NOBODY, deps)).toEqual({
      admin: true,
      degraded: false,
    });

    // Membership revoked on chain, clock unmoved.
    server.resetHandlers();
    server.use(...groupHandlers([]));

    // The cache still answers the rendering path — that is its documented,
    // accepted staleness, asserted here so the bypass below is a contrast and
    // not an accident of test ordering.
    expect((await detectRoles(config, NOBODY, deps)).admin).toBe(true);

    // The mint path does not. This is the invariant.
    expect(await verifyAdminUncached(config, NOBODY, deps)).toEqual({
      admin: false,
      degraded: false,
    });
  });

  it("does not POPULATE the cache either — a mint check cannot warm a stale role", async () => {
    const now = 1_750_000_000_000;
    const deps = { now: () => now };

    server.use(...groupHandlers([NOBODY]));
    expect(await verifyAdminUncached(config, NOBODY, deps)).toEqual({
      admin: true,
      degraded: false,
    });

    // Revoke, clock unmoved. If the uncached read had written the cache, the
    // rendering path would now serve `admin: true` from that write for a full
    // TTL — a privilege check leaking into the render cache.
    server.resetHandlers();
    server.use(...groupHandlers([]));
    expect((await detectRoles(config, NOBODY, deps)).admin).toBe(false);
  });

  it("reports degraded (not `admin: false`) when the membership read fails", async () => {
    // `degraded` and `admin: false` are different answers and the caller renders
    // them differently: "we could not check" versus "you are not an admin". A
    // failed read collapsing to the latter would be the App stating a fact it
    // does not have (SECURITY.md: never lie about state).
    server.use(
      http.get("*/cosmwasm/wasm/v1/contract/:address/smart/:query", () =>
        HttpResponse.json({ code: 2, message: "unavailable", details: [] }, { status: 503 }),
      ),
    );
    expect(await verifyAdminUncached(config, NOBODY)).toEqual({ admin: false, degraded: true });

    // And it caches nothing on the way out: the next check re-reads.
    server.resetHandlers();
    server.use(...groupHandlers([NOBODY]));
    expect(await verifyAdminUncached(config, NOBODY)).toEqual({ admin: true, degraded: false });
  });
});
