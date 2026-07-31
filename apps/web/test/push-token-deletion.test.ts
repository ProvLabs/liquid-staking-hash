// Push-token deletion — THE STANDING SECURITY-EXECUTABLE GATE
//. This is the SECURITY.md accepted exception's
// condition made mechanical: a Web Push token is opt-in, opaque, and REVOCABLE,
// "deleted on opt-out AND session delete." All four deletion paths are asserted
// here — not just opt-out:
//
//   1. opt-out          → the DELETE-route seam removes the session's rows.
//   2. logout           → the deletion chain removes them with the session.
//   3. session expiry   → a stale cookie's sweep removes them with the remnant.
//   4. dead endpoint    → a 404/410 at send time prunes the row.
//   5. invariant sweep  → the notifier tick deletes any token whose session is
//      missing or expired — the browser that NEVER presents its stale cookie,
//      and crash remnants of the two-step chain (PR-review fix).
//
// …and nothing else recreates a token (only an explicit opt-in POST does).

import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";

import { loadConfig } from "~/config/config.server";
import { getPushStore, InMemoryPushStore, resetPushStoreForTests } from "~/lib/models/push.server";
import { InMemorySessionStore, type SessionRow } from "~/lib/models/session.server";
import { deleteSubscriptionsForSession } from "~/push/push.server";
import {
  getSessionContext,
  logout,
  SESSION_ABSOLUTE_TTL_SECONDS,
} from "~/lib/services/session.server";
import { fanOutPush, type PushSender } from "../notifier/push.ts";

const config = loadConfig({
  APP_ENV: "development",
  CHAIN_ID: "chain-dev",
  LCD_URL: "http://lcd.mock:1317",
  CONTRACT_ADDRESS: "tp14hj2tavq8fpesdwxxcu44rty3hh90vhujrvcmstl4zr3txmfvw9s96lrg8",
  VAULT_ADDRESS: "tp1xj828fwstxajpn95mq07mw0ztn449lxx65skad",
  CONSOLE_URL: "https://console.example",
  CONSOLE_CHAIN_ID: "chain-dev",
  API_URL: "http://api.mock:8787",
} as NodeJS.ProcessEnv); // no DATABASE_URL → in-memory stores

const ADDRESS = "tp1holder";
const NOW = new Date("2026-07-24T00:00:00Z");
const silentLog = { error: () => {} };

const SUB = { endpoint: "https://push.example/ep/1", p256dh: "x".repeat(40), auth: "y".repeat(16) };

/** A live session row + a matching cookie, and a push sub bound to its id. */
async function seededSession(sessionStore: InMemorySessionStore, pushStore: InMemoryPushStore) {
  const id = randomBytes(32).toString("base64url"); // the 43-char base64url cookie shape
  const row: SessionRow = {
    id,
    address: ADDRESS,
    createdAt: NOW,
    expiresAt: new Date(NOW.getTime() + SESSION_ABSOLUTE_TTL_SECONDS * 1000),
    lastRefreshAt: NOW,
  };
  await sessionStore.createSession(row);
  await pushStore.upsertForSession(ADDRESS, id, SUB);
  const request = new Request("http://app.local/portfolio", {
    headers: { Cookie: `nvhash_session=${id}` },
  });
  return { id, request };
}

async function stores() {
  resetPushStoreForTests();
  const pushStore = (await getPushStore(config)) as InMemoryPushStore;
  return { pushStore, sessionStore: new InMemorySessionStore() };
}

describe("push-token deletion (the SECURITY.md accepted exception's condition)", () => {
  it("1. opt-out: the DELETE seam removes the session's push token", async () => {
    const { pushStore } = await stores();
    await pushStore.upsertForSession(ADDRESS, "sess-1", SUB);
    expect(await pushStore.countForAddress(ADDRESS)).toBe(1);
    const removed = await deleteSubscriptionsForSession(config, "sess-1");
    expect(removed).toBe(1);
    expect(await pushStore.countForAddress(ADDRESS)).toBe(0);
  });

  it("2. logout: removing the session removes its push token (the deletion chain)", async () => {
    const { pushStore, sessionStore } = await stores();
    const { request } = await seededSession(sessionStore, pushStore);
    expect(await pushStore.countForAddress(ADDRESS)).toBe(1);
    await logout(config, request, { store: sessionStore, pushStore, now: () => NOW });
    expect(await pushStore.countForAddress(ADDRESS)).toBe(0);
  });

  it("3. session expiry: a stale cookie's sweep removes the push token", async () => {
    const { pushStore, sessionStore } = await stores();
    const { request } = await seededSession(sessionStore, pushStore);
    // Advance past the absolute ceiling: the session is no longer live.
    const later = () => new Date(NOW.getTime() + (SESSION_ABSOLUTE_TTL_SECONDS + 1) * 1000);
    const context = await getSessionContext(config, request, {
      store: sessionStore,
      pushStore,
      now: later,
    });
    expect(context).toBeNull(); // expired
    expect(await pushStore.countForAddress(ADDRESS)).toBe(0); // …and swept
  });

  it("4. dead endpoint: a 410 at send time prunes the token", async () => {
    const { pushStore } = await stores();
    await pushStore.upsertForSession(ADDRESS, "sess-1", SUB);
    const sender: PushSender = {
      send: () => {
        const err = new Error("gone") as Error & { statusCode: number };
        err.statusCode = 410;
        return Promise.reject(err);
      },
    };
    await fanOutPush({
      inserted: [
        {
          address: ADDRESS,
          kind: "redemption_update",
          dedupeKey: "r1",
          payload: { request_id: "r1", event: "matured" },
        },
      ],
      pushStore,
      sender,
      log: silentLog,
    });
    expect(await pushStore.countForAddress(ADDRESS)).toBe(0);
  });

  it("5. invariant sweep: a never-returning browser's token dies when its session does", async () => {
    // No cookie is ever presented after opt-in — paths 1–3 never fire. The
    // notifier tick's sweep alone must revoke the token once the session is
    // past its bounds (liveness delegated to the session store's own rule).
    const sessionStore = new InMemorySessionStore();
    const pushStore = new InMemoryPushStore(
      async (sessionId, at) => (await sessionStore.getSession(sessionId, at)) !== null,
    );
    await seededSession(sessionStore, pushStore);
    // While the session lives, the sweep removes nothing.
    expect(await pushStore.sweepOrphans(NOW)).toBe(0);
    expect(await pushStore.countForAddress(ADDRESS)).toBe(1);
    // Past the absolute ceiling, with NO request ever made: swept.
    const later = new Date(NOW.getTime() + (SESSION_ABSOLUTE_TTL_SECONDS + 1) * 1000);
    expect(await pushStore.sweepOrphans(later)).toBe(1);
    expect(await pushStore.countForAddress(ADDRESS)).toBe(0);
  });

  it("5b. invariant sweep: a crash remnant (session row GONE, token left) is swept", async () => {
    const sessionStore = new InMemorySessionStore();
    const pushStore = new InMemoryPushStore(
      async (sessionId, at) => (await sessionStore.getSession(sessionId, at)) !== null,
    );
    // A token whose session never made it / was deleted first: orphan.
    await pushStore.upsertForSession(ADDRESS, "sess-crash-remnant", SUB);
    expect(await pushStore.sweepOrphans(NOW)).toBe(1);
    expect(await pushStore.countForAddress(ADDRESS)).toBe(0);
  });

  it("nothing recreates a token: repeated logout / stale-cookie reads stay empty", async () => {
    const { pushStore, sessionStore } = await stores();
    const { request } = await seededSession(sessionStore, pushStore);
    await logout(config, request, { store: sessionStore, pushStore, now: () => NOW });
    expect(await pushStore.countForAddress(ADDRESS)).toBe(0);
    // A second logout and a subsequent context read (dead cookie) never re-add.
    await logout(config, request, { store: sessionStore, pushStore, now: () => NOW });
    await getSessionContext(config, request, { store: sessionStore, pushStore, now: () => NOW });
    expect(await pushStore.countForAddress(ADDRESS)).toBe(0);
  });
});
