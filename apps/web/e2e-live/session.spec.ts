// e2e-live: session establishment against the REAL devnet stack (plan 5.2
// §2.4; master plan §4 "e2e (live)" layer). Requires `stack.sh up` with the
// web tier reachable at E2E_LIVE_BASE_URL and a funded devnet key in
// E2E_LIVE_SIGNER_KEY (throwaway material; SECURITY.md devnet rules).
//
//   ./dev pw --filter @nvhash/web run test:e2e:live
//
// The signer lives in THIS process (signer.ts) — the app has no test-injection
// seam; everything below exercises the same HTTP surface a wallet-driven
// browser session uses.

import { expect, test } from "@playwright/test";

import { DevnetTestSigner } from "./signer";

const KEY = process.env.E2E_LIVE_SIGNER_KEY;
test.skip(KEY === undefined, "E2E_LIVE_SIGNER_KEY not set (needs the devnet stack)");

test("nonce → ADR-36 login → HttpOnly session; replay refused; logout kills it", async ({
  request,
  browser,
}) => {
  const signer = new DevnetTestSigner(KEY!);

  const nonceRes = await request.post("/session/nonce", {
    data: { address: signer.address },
  });
  expect(nonceRes.ok()).toBe(true);
  const { nonce, challenge } = (await nonceRes.json()) as { nonce: string; challenge: string };

  const signature = signer.signChallenge(challenge);
  const loginRes = await request.post("/session/login", {
    data: { address: signer.address, nonce, pubkey: signer.pubkeyBase64, signature },
  });
  expect(loginRes.ok()).toBe(true);

  // Cookie discipline (§12.3): HttpOnly, SameSite=Lax, opaque id only.
  const setCookie = loginRes.headers()["set-cookie"] ?? "";
  expect(setCookie).toContain("nvhash_session=");
  expect(setCookie).toContain("HttpOnly");
  expect(setCookie).toContain("SameSite=Lax");
  expect(setCookie).not.toContain(signer.address);

  // Replay: the same signed nonce is burned.
  const replay = await request.post("/session/login", {
    data: { address: signer.address, nonce, pubkey: signer.pubkeyBase64, signature },
  });
  expect(replay.status()).toBe(401);

  // The session renders: /portfolio shows the connected address, and the
  // cookie is invisible to page script (HttpOnly).
  const cookieValue = /nvhash_session=([A-Za-z0-9_-]{43})/.exec(setCookie)?.[1];
  expect(cookieValue).toBeDefined();
  const context = await browser.newContext();
  await context.addCookies([
    {
      name: "nvhash_session",
      value: cookieValue!,
      url: process.env.E2E_LIVE_BASE_URL ?? "http://localhost:3000",
    },
  ]);
  const page = await context.newPage();
  await page.goto("/portfolio");
  await expect(page.getByText(signer.address.slice(0, 12), { exact: false })).toBeVisible();
  expect(await page.evaluate(() => document.cookie)).not.toContain("nvhash_session");

  // Logout destroys the row: the same cookie is dead server-side.
  const logoutRes = await request.post("/session/logout", { data: {} });
  expect(logoutRes.ok()).toBe(true);
  const status = await request.get("/tx/status?hash=" + "0".repeat(64));
  expect(status.status()).toBe(401);
  await context.close();
});
