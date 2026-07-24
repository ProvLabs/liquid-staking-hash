// e2e-live: Portfolio against the REAL devnet stack (plan M6.1 §2.6; master
// plan §4 "e2e (live)" layer). Establishes a session the same way session.spec
// does (nonce → ADR-36 → HttpOnly cookie), then asserts the authenticated
// Portfolio page renders the position summary and that the CSV export carries
// its freshness headers. Skips cleanly when the stack is absent (no
// E2E_LIVE_SIGNER_KEY), exactly like the rest of the live suite.

import { expect, test } from "@playwright/test";

import { DevnetTestSigner } from "./signer";

const KEY = process.env.E2E_LIVE_SIGNER_KEY;
test.skip(KEY === undefined, "E2E_LIVE_SIGNER_KEY not set (needs the devnet stack)");

/** nonce → ADR-36 login; returns the session cookie value for a browser context. */
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

test("authenticated portfolio renders the summary for the session address", async ({
  request,
  browser,
}) => {
  const signer = new DevnetTestSigner(KEY!);
  const cookieValue = await login(request, signer);

  const context = await browser.newContext();
  await context.addCookies([
    {
      name: "nvhash_session",
      value: cookieValue,
      url: process.env.E2E_LIVE_BASE_URL ?? "http://localhost:3000",
    },
  ]);
  const page = await context.newPage();
  await page.goto("/portfolio");

  // The connected address is shown, and the live-plane summary renders (a live
  // balance figure or an honest n/a, never a fabricated zero).
  await expect(page.getByText(signer.address.slice(0, 12), { exact: false })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Your position" })).toBeVisible();
  await expect(page.getByText("nvHASH balance", { exact: false })).toBeVisible();
  await context.close();
});

test("CSV export returns text/csv with the freshness headers", async ({ request }) => {
  const signer = new DevnetTestSigner(KEY!);
  await login(request, signer);

  // The `request` context retains the session cookie from login.
  const res = await request.get("/portfolio/export");
  expect(res.status()).toBe(200);
  expect(res.headers()["content-type"]).toContain("text/csv");
  // Assert header presence, not values (freshness is stack-dependent).
  for (const header of ["x-chain-height", "x-indexed-height", "x-generated-at"]) {
    expect(res.headers()[header], header).toBeDefined();
  }
});
