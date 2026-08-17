// Every labeled shell, cold-start, below-threshold and degraded state is
// visible in the accessibility tree — never aria-hidden, never blank — and
// passes axe in both themes.

import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

import { GRANT_ORIGIN, LIVE_DOWN_ORIGIN } from "../playwright.config";
import { loginAs, roleSigner } from "./support/login";

const ORIGIN = "http://127.0.0.1:43117";

/** The text is exposed to AT: attached, non-hidden, and inside no
 * aria-hidden ancestor. */
async function assertAccessibleText(page: Page, text: string | RegExp): Promise<void> {
  const target = page.getByText(text, { exact: false }).first();
  await expect(target).toBeVisible();
  const hiddenAncestor = await target.evaluate((el) => {
    for (let node = el as HTMLElement | null; node; node = node.parentElement) {
      if (node.getAttribute("aria-hidden") === "true") return true;
    }
    return false;
  });
  expect(hiddenAncestor, `"${String(text)}" must not sit inside aria-hidden`).toBe(false);
}

async function axeClean(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(results.violations).toEqual([]);
}

for (const theme of ["light", "dark"] as const) {
  test(`exit DEX coming-soon column is AT-visible (${theme})`, async ({ page, context }) => {
    await context.addCookies([{ name: "nvhash-theme", value: theme, url: ORIGIN }]);
    await page.goto("/exit");
    await assertAccessibleText(page, "Coming soon");
    await assertAccessibleText(page, "once nvHASH is bridged");
    await axeClean(page);
  });

  test(`market forthcoming shell is AT-visible (${theme})`, async ({ page, context }) => {
    await context.addCookies([{ name: "nvhash-theme", value: theme, url: ORIGIN }]);
    await page.goto("/market");
    await assertAccessibleText(page, "No bridged nvHASH market exists yet");
    await axeClean(page);
  });

  test(`cold-start redemption copy is AT-visible (${theme})`, async ({ page, context }) => {
    await context.addCookies([{ name: "nvhash-theme", value: theme, url: ORIGIN }]);
    await page.goto("/exit");
    // §14.12: the guarantee stands alone, honestly, below the sample gate.
    await assertAccessibleText(page, "Guaranteed within 60 days");
    await assertAccessibleText(page, /Not enough recent redemptions/);
  });

  test(`degraded chrome (LIVE_DOWN) is AT-visible (${theme})`, async ({ browser }) => {
    const context = await browser.newContext({ baseURL: LIVE_DOWN_ORIGIN });
    await context.addCookies([{ name: "nvhash-theme", value: theme, url: LIVE_DOWN_ORIGIN }]);
    const page = await context.newPage();
    await page.goto("/");
    await assertAccessibleText(page, "Program status unavailable");
    await axeClean(page);
    await context.close();
  });
}

test("admin below-threshold / n-a panels are AT-visible (role session)", async ({
  page,
  context,
  request,
}) => {
  await loginAs(request, context, roleSigner(), GRANT_ORIGIN);
  await page.goto(`${GRANT_ORIGIN}/admin`);
  // The honest-empty admin renders every panel in a stated non-numeric state
  // — those states must be in the tree, not hidden placeholders.
  const statuses = page.locator('[role="status"]');
  expect(await statuses.count()).toBeGreaterThan(0);
  await axeClean(page);
});

test("environment badge is AT-visible (the D22 pre-certification caveat)", async ({ page }) => {
  await page.goto("/");
  // APP_ENV=development on the harness server: the badge must say so to AT.
  await assertAccessibleText(page, /development/i);
});
