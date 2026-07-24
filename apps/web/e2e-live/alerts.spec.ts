// e2e-live: Alerts against the REAL devnet stack (plan 6.2 §3 commit C; master
// plan §4 "e2e (live)" layer). Establishes a session (nonce → ADR-36 → cookie,
// the session.spec pattern), then exercises the authenticated alert routes over
// the real app + `app` schema: effective-settings CRUD roundtrip, the
// notifications endpoint shape, and the Portfolio alert-settings section. Skips
// cleanly when the stack is absent (no E2E_LIVE_SIGNER_KEY).
//
// Note (recorded deviation): the full "redemption drill → run one notifier tick
// → bell shows the matured notification" chain is covered by the pure
// test/notifier.test.ts (exactly-once, presence, opt-out, mapping) rather than
// driven end-to-end here, since a notifier tick is a separate worker process;
// this spec proves the authenticated read/write surface the notifier feeds.

import { expect, test } from "@playwright/test";

import { DevnetTestSigner } from "./signer";

const KEY = process.env.E2E_LIVE_SIGNER_KEY;
test.skip(KEY === undefined, "E2E_LIVE_SIGNER_KEY not set (needs the devnet stack)");

async function login(request: import("@playwright/test").APIRequestContext, signer: DevnetTestSigner) {
  const nonceRes = await request.post("/session/nonce", { data: { address: signer.address } });
  expect(nonceRes.ok()).toBe(true);
  const { nonce, challenge } = (await nonceRes.json()) as { nonce: string; challenge: string };
  const signature = signer.signChallenge(challenge);
  const loginRes = await request.post("/session/login", {
    data: { address: signer.address, nonce, pubkey: signer.pubkeyBase64, signature },
  });
  expect(loginRes.ok()).toBe(true);
  const setCookie = loginRes.headers()["set-cookie"] ?? "";
  const value = /nvhash_session=([A-Za-z0-9_-]{43})/.exec(setCookie)?.[1];
  expect(value).toBeDefined();
  return value!;
}

test("authenticated alert-settings CRUD roundtrip + notifications shape", async ({ playwright, baseURL }) => {
  const signer = new DevnetTestSigner(KEY!);
  const request = await playwright.request.newContext({ baseURL });
  try {
    await login(request, signer);

    // Effective settings: the closed kind list with the R2 defaults on.
    const rulesRes = await request.get("/alerts/rules");
    expect(rulesRes.ok()).toBe(true);
    const { settings } = (await rulesRes.json()) as {
      settings: Array<{ kind: string; enabled: boolean; isDefault: boolean }>;
    };
    const byKind = new Map(settings.map((s) => [s.kind, s]));
    expect(byKind.get("redemption_update")).toMatchObject({ enabled: true, isDefault: true });
    expect(byKind.get("nav_step_posted")).toMatchObject({ enabled: false, isDefault: false });

    // Opt in to nav steps, then confirm it persisted.
    const post = await request.post("/alerts/rules", { data: { kind: "nav_step_posted", enabled: true } });
    expect(post.ok()).toBe(true);
    const afterRes = await request.get("/alerts/rules");
    const after = (await afterRes.json()) as { settings: Array<{ kind: string; enabled: boolean }> };
    expect(after.settings.find((s) => s.kind === "nav_step_posted")!.enabled).toBe(true);

    // Restore the default so the run is idempotent.
    await request.post("/alerts/rules", { data: { kind: "nav_step_posted", enabled: false } });

    // Notifications endpoint answers with the frozen shape (possibly empty).
    const notifRes = await request.get("/alerts/notifications");
    expect(notifRes.ok()).toBe(true);
    const body = (await notifRes.json()) as { notifications: unknown[]; unread: number };
    expect(Array.isArray(body.notifications)).toBe(true);
    expect(typeof body.unread).toBe("number");

    // An unknown kind is rejected (reject, never guess).
    const bad = await request.post("/alerts/rules", { data: { kind: "not_a_kind", enabled: true } });
    expect(bad.status()).toBe(400);
  } finally {
    await request.dispose();
  }
});

test("the Portfolio page renders the alert-settings section for a session", async ({ browser, baseURL }) => {
  const signer = new DevnetTestSigner(KEY!);
  const request = await browser.newContext().then((c) => c.request);
  const cookie = await login(request, signer);

  const context = await browser.newContext({ baseURL });
  await context.addCookies([
    { name: "nvhash_session", value: cookie, url: baseURL!, httpOnly: true, sameSite: "Lax" },
  ]);
  const page = await context.newPage();
  try {
    await page.goto("/portfolio");
    await expect(page.getByRole("heading", { name: "Alert settings" })).toBeVisible();
    // The default-on redemption row is present and annotated.
    await expect(page.getByText("Redemption updates")).toBeVisible();
    await expect(page.getByText("on by default").first()).toBeVisible();
  } finally {
    await context.close();
  }
});
