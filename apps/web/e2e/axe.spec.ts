import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

// Accessibility gate (app-spec §11: WCAG AA on both themes) —
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
  // The proposal detail. A concrete id from the mirrored corpus: the
  // detail page has table, disclosure and time semantics the list does not.
  "/governance/4",
  // The template composer. Offline it renders its anonymous gate rather
  // than the form, which is the state a scan can reach without a session — the
  // `/validators/mine` precedent for an authenticated surface.
  "/governance/new",
  // Admin analytics. Offline there is no session, so the scan reaches the
  // anonymous connect-prompt state rather than the panels — the
  // `/validators/mine` precedent for an authenticated surface. The panels'
  // own accessibility rides the live suite and their semantic markup
  // (captioned tables, `role="status"` on every "n/a" state).
  "/admin",
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
