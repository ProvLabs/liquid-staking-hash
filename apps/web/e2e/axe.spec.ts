import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

import { GRANT_ORIGIN } from "../playwright.config";
import { holderSigner, loginAs, roleSigner } from "./support/login";
import { pageRoutePaths } from "./support/routes";

// Accessibility gate (app-spec §11, WCAG AA both themes). The matrix is
// derived from the route registry × three auth states via the app's own
// login path; populated states ride the live lane (e2e-live/axe.spec.ts).
// Weakening the tag set or the empty-violations shape requires a recorded
// exception in app-spec §11 in the same change.

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
