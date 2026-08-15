import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

import { GRANT_ORIGIN } from "../playwright.config";
import { holderSigner, loginAs, roleSigner } from "./support/login";
import { pageRoutePaths } from "./support/routes";

// Accessibility gate (app-spec §11: WCAG AA on both themes) — standing in CI
// from the scaffold on. Since PR 8.3 the matrix is DERIVED from the route
// registry (a new page route is scanned by existing; a new dynamic segment
// without a binding fails test/a11y-routes.test.ts) and covers three auth
// states through the app's own login path (CO-22: the authenticated surfaces
// the offline suite never reached). The offline cells render what the corpus
// honestly yields — anonymous gates, authenticated empty/cold-start, labeled
// shells; POPULATED states ride the live lane (e2e-live/axe.spec.ts), stated
// as a limit rather than silently absorbed.
//
// The axe tag set and the empty-violations shape are load-bearing: weakening
// either requires a recorded exception in app-spec §11 (rule id + surface +
// reason) in the same change — invariant 9 of the 8.3 plan.

const ORIGIN = "http://127.0.0.1:43117";
const THEMES = ["light", "dark"] as const;
const AUTH_STATES = ["anonymous", "holder", "roles"] as const;

async function scan(page: import("@playwright/test").Page): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(results.violations).toEqual([]);
}

for (const route of pageRoutePaths()) {
  for (const theme of THEMES) {
    for (const auth of AUTH_STATES) {
      test(`axe: ${route} (${theme}, ${auth})`, async ({ page, context, request }) => {
        // Role cells run against the GRANT instance (its mocked chain reports
        // the pinned role signer as operator + member); anonymous and holder
        // cells run against the knob-free primary, whose chain state stays
        // byte-identical to the corpus.
        const origin = auth === "roles" ? GRANT_ORIGIN : ORIGIN;
        await context.addCookies([{ name: "nvhash-theme", value: theme, url: origin }]);
        if (auth === "holder") await loginAs(request, context, holderSigner(), origin);
        if (auth === "roles") await loginAs(request, context, roleSigner(), origin);
        await page.goto(`${origin}${route}`);
        await scan(page);
      });
    }
  }
}

// Q1: two representative auto-theme cells on `/` — the default state real
// visitors land in (no data-theme attribute; CSS light-dark() follows the
// OS). Proves the attribute-less path resolves the same validated palettes
// without tripling the matrix.
for (const colorScheme of ["light", "dark"] as const) {
  test(`axe: / (auto theme, prefers-color-scheme: ${colorScheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme });
    await page.goto("/");
    await scan(page);
  });
}
