// Live-lane axe pass (8.3 §2.7, Q2): exactly the POPULATED authenticated
// surfaces the offline suite structurally cannot render honestly —
// /portfolio, /validators/mine, /admin — against the real devnet stack.
// An ADDITION to the standing offline matrix (the per-PR gate), not the
// closure mechanism; runs on 8.1's scheduled lane, skip-clean without a key.
// The lifecycle confirm step's keyboard variant rides the existing lifecycle
// specs' machinery when the lane runs them.

import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

import { DevnetTestSigner } from "./signer";

const KEY = process.env.E2E_LIVE_SIGNER_KEY;
test.skip(KEY === undefined, "E2E_LIVE_SIGNER_KEY not set (needs the devnet stack)");

async function login(
  request: import("@playwright/test").APIRequestContext,
  context: import("@playwright/test").BrowserContext,
  signer: DevnetTestSigner,
) {
  const base = process.env.E2E_LIVE_BASE_URL ?? "http://localhost:3000";
  const { nonce, challenge } = (await (
    await request.post(`${base}/session/nonce`, { data: { address: signer.address } })
  ).json()) as { nonce: string; challenge: string };
  const loginRes = await request.post(`${base}/session/login`, {
    data: {
      address: signer.address,
      nonce,
      pubkey: signer.pubkeyBase64,
      signature: signer.signChallenge(challenge),
    },
  });
  expect(loginRes.ok()).toBe(true);
  const value = /nvhash_session=([A-Za-z0-9_-]{43})/.exec(
    loginRes.headers()["set-cookie"] ?? "",
  )?.[1];
  expect(value).toBeDefined();
  await context.addCookies([{ name: "nvhash_session", value: value ?? "", url: base }]);
}

for (const route of ["/portfolio", "/validators/mine", "/admin"]) {
  test(`axe (live, populated): ${route}`, async ({ page, context, request }) => {
    await login(request, context, new DevnetTestSigner(KEY!));
    await page.goto(route);
    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();
    expect(results.violations).toEqual([]);
  });
}
