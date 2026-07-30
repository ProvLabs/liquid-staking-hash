import { expect, test } from "@playwright/test";

// Redeem & Exit page (app-spec §8.4) against the fixture-backed
// server. Anonymous surface: the comparison OPENS the page (not a form), the
// DEX column is a labeled "coming soon" shell, the guaranteed-vs-typical
// framing is honest (cold-start → guarantee alone), and the native form
// waits behind the connect prompt. The fund-moving path is the e2e-live drill.

test("opens with the exit-path comparison, not a form", async ({ page }) => {
  await page.goto("/exit");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Redeem & Exit");
  const table = page.getByRole("table");
  await expect(table).toBeVisible();
  // The comparison appears before the native form (which is gated on connect).
  await expect(page.getByText("Connect a wallet to redeem", { exact: false })).toBeVisible();
  await expect(page.getByLabel("Amount to redeem (nvHASH)")).toHaveCount(0);
});

test("DEX column is a labeled coming-soon shell (§14.4)", async ({ page }) => {
  await page.goto("/exit");
  await expect(page.getByText("Coming soon", { exact: false })).toBeVisible();
  await expect(page.getByText("once nvHASH is bridged", { exact: false }).first()).toBeVisible();
});

test("cold-start shows the 60-day guarantee alone, no fabricated typical", async ({ page }) => {
  await page.goto("/exit");
  // Guarantee in the promise position; the typical is honestly withheld —
  // asserted through the substituted day count so an unresolved {days}
  // placeholder fails here.
  await expect(page.getByText("Guaranteed within 60 days", { exact: false })).toBeVisible();
  await expect(
    page.getByText("Not enough recent redemptions to show a typical time yet; the 60-day guarantee stands", { exact: false }),
  ).toBeVisible();
  // No unresolved i18n placeholder ever reaches the user.
  await expect(page.getByText(/\{\w+\}/)).toHaveCount(0);
  // No fabricated "median of N days" text in the cold-start state.
  await expect(page.getByText(/median of \d+ days/)).toHaveCount(0);
});
