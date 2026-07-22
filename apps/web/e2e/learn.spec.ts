import { expect, test } from "@playwright/test";

import { LIVE_DOWN_ORIGIN } from "../playwright.config";

// Learn page (plan 4.2, app-spec §8.1) against the fixture-backed server:
// all seven sections render, live figures show the corpus values, indexed
// figures show honest cold-start states, and verify links stay under the
// booted console origin (§12.2).

test("renders every §8.1 section", async ({ page }) => {
  await page.goto("/");
  for (const heading of [
    "The program right now",
    "Where the yield comes from",
    "Security and trust",
    "Incidents and slashing history",
    "Getting out",
    "Ready to stake",
  ]) {
    await expect(page.getByRole("heading", { name: heading })).toBeVisible();
  }
});

test("proof strip shows live corpus figures and honest n/a for indexed ones", async ({ page }) => {
  await page.goto("/");
  const strip = page.getByLabel("The program right now");
  await expect(strip).toContainText("1.0175"); // NAV from the fixture corpus
  await expect(strip).toContainText("48.44%"); // net APR
  await expect(strip).toContainText("315.39"); // TVL
  await expect(strip).toContainText("n/a"); // participants/age: not yet indexed
});

test("cold-start renderings: empty epoch history and the proud incident empty state", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByText("No settled epochs are indexed yet", { exact: false })).toBeVisible();
  await expect(
    page.getByText("generated from chain history, not curated", { exact: false }),
  ).toBeVisible();
});

test("every verify link stays under the booted console origin (§12.2)", async ({ page }) => {
  await page.goto("/");
  const links = page.getByRole("link", { name: "Verify on the console" });
  const count = await links.count();
  expect(count).toBeGreaterThanOrEqual(6); // one per proof tile + the footer
  for (let i = 0; i < count; i += 1) {
    const href = await links.nth(i).getAttribute("href");
    expect(href, `verify link ${i}`).toMatch(/^https:\/\/console\.invalid(\/|$)/);
  }
});

test("CTA routes to the stake page", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("link", { name: "Go to Stake" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Stake");
});

test("failed live reads degrade per figure; the page still renders", async ({ page }) => {
  await page.goto(`${LIVE_DOWN_ORIGIN}/`);
  await expect(page.getByRole("heading", { level: 1 })).toContainText("nvHASH");
  const strip = page.getByLabel("The program right now");
  await expect(strip).toContainText("n/a"); // NAV/TVL tiles degrade honestly
  await expect(strip).toContainText("48.44%"); // the APR read is its own surface
});
