import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

// Accessibility gate (plan §4, app-spec §11: WCAG AA on both themes) —
// standing in CI from the scaffold on. Pages added later are covered by
// adding their routes here.

const ROUTES = [
  "/",
  "/stake",
  "/exit",
  "/portfolio",
  "/market",
  "/validators",
  "/validators/mine",
  "/governance",
  // The proposal detail (M7.2). A concrete id from the mirrored corpus: the
  // detail page has table, disclosure and time semantics the list does not.
  "/governance/4",
];

for (const route of ROUTES) {
  test(`axe: ${route} (light)`, async ({ page, context }) => {
    await context.addCookies([
      { name: "nvhash-theme", value: "light", url: "http://127.0.0.1:43117" },
    ]);
    await page.goto(route);
    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();
    expect(results.violations).toEqual([]);
  });

  test(`axe: ${route} (dark)`, async ({ page, context }) => {
    await context.addCookies([
      { name: "nvhash-theme", value: "dark", url: "http://127.0.0.1:43117" },
    ]);
    await page.goto(route);
    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();
    expect(results.violations).toEqual([]);
  });
}
