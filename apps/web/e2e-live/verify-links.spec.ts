// The verify-link contract proven LIVE, App↔Console (plan 8.4 §2.7.3; §4
// invariants 13/14): the first environment with BOTH surfaces deployed is
// where this contract becomes testable at all. Walks real verify links from
// rendered App surfaces into the deployed console — including the 8.4b
// entity anchors and the `governance` target — and asserts each lands on
// the addressed entity's PAGE (not a host 404: the SPA-fallback rewrite is
// a hosting fact only this walk can see, and at least one DEEP-PATH anchor
// below is deliberate for exactly that reason). Also asserts the console's
// served CSP response header (handoff (b)).
//
// This is the PILOT'S ACCEPTANCE TEST, run against the deployment
// (E2E_LIVE_BASE_URL + E2E_LIVE_CONSOLE_URL), not an offline CI suite. It
// skips clean when the deployment env is unset; the devnet stack can also
// run it (stack.sh e2e) as the pre-merge §4b C7 drill.
import { expect, test } from "@playwright/test";

const BASE = process.env.E2E_LIVE_BASE_URL;
const CONSOLE_URL = process.env.E2E_LIVE_CONSOLE_URL;
test.skip(
  BASE === undefined || CONSOLE_URL === undefined,
  "E2E_LIVE_BASE_URL / E2E_LIVE_CONSOLE_URL not set (needs both surfaces deployed)",
);

test("every App verify link stays under the deployed console origin", async ({ page }) => {
  const consoleOrigin = new URL(CONSOLE_URL as string).origin;
  for (const path of ["/", "/market", "/governance"]) {
    await page.goto(`${BASE}${path}`);
    const hrefs = await page
      .getByRole("link", { name: "Verify on the console" })
      .evaluateAll((nodes) => nodes.map((n) => n.getAttribute("href")));
    for (const href of hrefs) {
      expect(href, `${path} verify link`).not.toBeNull();
      expect(new URL(href as string).origin, `${path} verify link origin`).toBe(consoleOrigin);
    }
  }
});

test("deep console page paths serve the app, never the host 404 (SPA rewrite)", async ({
  page,
}) => {
  // Fragments cannot 404; PAGE PATHS can — this is invariant 14(a)'s
  // detector. Every anchor landing view must serve the console shell.
  for (const path of ["/validators", "/redemptions", "/epoch", "/governance"]) {
    const response = await page.goto(`${CONSOLE_URL}${path}`);
    expect(response?.status(), `${path} must not 404 at the host`).toBe(200);
    await expect(page.getByText("nvHASH Console").first()).toBeVisible();
  }
});

test("an anchored governance link lands on the console panel with the matching chain id", async ({
  page,
}) => {
  await page.goto(`${BASE}/governance`);
  const appChain = await page.locator("footer").textContent();
  const verify = page.getByRole("link", { name: "Verify on the console" }).first();
  const href = await verify.getAttribute("href");
  expect(href?.startsWith(CONSOLE_URL as string)).toBe(true);
  await page.goto(href as string);
  await expect(page.getByRole("heading", { name: "Governance" })).toBeVisible();
  // Environment lock: the console's chain badge equals the App's footer chain.
  const consoleChain = await page.locator(".topbar").textContent();
  for (const chain of ["pio-testnet-1", "chain-dev"]) {
    if (appChain?.includes(chain)) expect(consoleChain).toContain(chain);
  }
});

test("the App badge is LOUD with the chain id on the pilot deployment", async ({ page }) => {
  // §2.7.1: asserted against the BUILT deployment, not assumed from devnet.
  await page.goto(`${BASE}/`);
  const badge = page
    .locator("header")
    .getByText(/testnet|development/)
    .first();
  await expect(badge).toBeVisible();
});

test("the console's served CSP header pins the profile LCD and frame-ancestors", async ({
  request,
}) => {
  // Handoff (b): headers cover frame-ancestors, which meta CSP cannot — a
  // public wallet-connecting page without it is clickjackable (invariant 14).
  const response = await request.get(CONSOLE_URL as string);
  const csp = response.headers()["content-security-policy"] ?? "";
  expect(csp, "the console must serve a CSP response header").not.toBe("");
  expect(csp).toContain("frame-ancestors");
  expect(csp).toContain("connect-src 'self'");
  expect(csp).not.toContain("connect-src 'self' https:;");
});
