import { expect, test } from "@playwright/test";

import { LIVE_DOWN_ORIGIN } from "../playwright.config";

// Validators public page (plan 4.3, app-spec §8.6) against the fixture-backed
// server: the consumer table with the corpus values, honest cold-start set
// history, environment-locked verify links, and per-surface degradation.

test("renders the set table with the corpus validator", async ({ page }) => {
  await page.goto("/validators");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Validators");
  const table = page.getByRole("table");
  await expect(table).toContainText("testing"); // x/staking moniker
  await expect(table).toContainText("Eligible");
  await expect(table).toContainText("100.00% / 0.00% required");
  await expect(table).toContainText("315.35"); // program delegation, HASH
});

test("set health shows the live eligible count and the indexed aggregates", async ({
  page,
}) => {
  await page.goto("/validators");
  const health = page.getByLabel("Set health");
  await expect(health).toContainText("Eligible now");
  await expect(health).toContainText("1");
  // Honest-empty indexed plane: zero counts from the unwired reader.
  await expect(health).toContainText("Active in set");
  await expect(health).toContainText("Enrollments all-time");
  await expect(health).toContainText("From indexed history");
});

test("verify link stays under the booted console origin (§12.2)", async ({ page }) => {
  await page.goto("/validators");
  const links = page.getByRole("link", { name: "Verify on the console" });
  const count = await links.count();
  expect(count).toBeGreaterThanOrEqual(1);
  for (let i = 0; i < count; i += 1) {
    const href = await links.nth(i).getAttribute("href");
    expect(href, `verify link ${i}`).toMatch(/^https:\/\/console\.invalid(\/|$)/);
  }
});

test("chrome live-down leaves this page's own reads intact and honest", async ({ page }) => {
  // The live-down toggle kills the CHROME's reads (vault get, epoch_status);
  // this page's smart queries (validators, config, epoch_snapshot) stay up.
  // So the footer says unavailable while the set table stays real: surfaces
  // degrade independently, exactly the §12.1 posture.
  await page.goto(`${LIVE_DOWN_ORIGIN}/validators`);
  await expect(page.locator("footer")).toContainText("Program status unavailable");
  await expect(page.getByRole("table")).toContainText("testing");
});
