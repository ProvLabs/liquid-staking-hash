// Offline session fabrication through the app's own login path (nonce →
// ADR-36 signature in the test process → login → cookie). No injection seam
// in `app/`; role-bearing renders come from the mocked chain reads alone.
//
// The two pinned harness keys are THROWAWAY CONSTANTS, deliberately committed
// (SECURITY.md devnet-material rule; they sign nothing outside this suite)
// and sentinel-marked via the signer class they feed, whose
// TEST_SIGNER_SENTINEL the check:bundle scan watches. Pinned rather than
// per-run so the role-grant knob (NVHASH_MOCK_GRANT_ROLES) can target a
// stable address and failures reproduce.

import type { BrowserContext, APIRequestContext } from "@playwright/test";
import { expect } from "@playwright/test";

import { DevnetTestSigner } from "./signer";

/** The holder-session key (no roles granted). Throwaway harness constant. */
export const HARNESS_HOLDER_KEY =
  "1111111111111111111111111111111111111111111111111111111111111111";

/** The role-session key: its address is what NVHASH_MOCK_GRANT_ROLES carries
 * in playwright.config.ts, so the mocked chain reads report it as operator +
 * group member. Throwaway harness constant. */
export const HARNESS_ROLE_KEY = "2222222222222222222222222222222222222222222222222222222222222222";

export const holderSigner = () => new DevnetTestSigner(HARNESS_HOLDER_KEY);
export const roleSigner = () => new DevnetTestSigner(HARNESS_ROLE_KEY);

/**
 * Log `signer` in through the app's public login path and install the session
 * cookie into `context`. `origin` must be the webServer origin under test.
 */
export async function loginAs(
  request: APIRequestContext,
  context: BrowserContext,
  signer: DevnetTestSigner,
  origin: string,
): Promise<void> {
  const nonceRes = await request.post(`${origin}/session/nonce`, {
    data: { address: signer.address },
  });
  expect(nonceRes.ok()).toBe(true);
  const { nonce, challenge } = (await nonceRes.json()) as { nonce: string; challenge: string };
  const loginRes = await request.post(`${origin}/session/login`, {
    data: {
      address: signer.address,
      nonce,
      pubkey: signer.pubkeyBase64,
      signature: signer.signChallenge(challenge),
    },
  });
  expect(loginRes.ok()).toBe(true);
  const setCookie = loginRes.headers()["set-cookie"] ?? "";
  const value = /nvhash_session=([A-Za-z0-9_-]{43})/.exec(setCookie)?.[1];
  expect(value, "login must set the session cookie").toBeDefined();
  await context.addCookies([{ name: "nvhash_session", value: value ?? "", url: origin }]);
}
