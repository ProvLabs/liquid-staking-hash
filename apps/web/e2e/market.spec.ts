import { expect, test } from "@playwright/test";

// Market page (plan 4.4, app-spec §8.5) against the fixture-backed server:
// the labeled v1 forthcoming shell (the REAL contract state), the always-on
// explainer, live local supply, history cold states, and the §12.1 rule that
// market figures never carry a verify link.

test("renders the labeled forthcoming shell, never a fabricated market", async ({ page }) => {
  await page.goto("/market");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Market");
  await expect(page.getByText("No bridged nvHASH market exists yet", { exact: false })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Why a spread exists" })).toBeVisible();
});

test("supply location shows the live local figure and the honest bridged empty state", async ({
  page,
}) => {
  await page.goto("/market");
  const supply = page.getByLabel("Where nvHASH lives");
  await expect(supply).toContainText("309.96"); // live corpus shares
  await expect(supply).toContainText("Live chain read");
  await expect(supply).toContainText("All nvHASH lives on Provenance today", {
    useInnerText: true,
  });
});

test("history section renders its cold states with empty indexed history", async ({ page }) => {
  await page.goto("/market");
  const history = page.getByLabel("Program history");
  await expect(history).toContainText("No monthly settlements are indexed yet");
});

test("market figures carry no verify link; the chain-derived history section does (§12.1)", async ({
  page,
}) => {
  await page.goto("/market");
  const marketSection = page.getByLabel("Market price");
  await expect(marketSection.getByRole("link", { name: "Verify on the console" })).toHaveCount(0);
  const supplySection = page.getByLabel("Where nvHASH lives");
  await expect(supplySection.getByRole("link", { name: "Verify on the console" })).toHaveCount(0);
  const history = page.getByLabel("Program history");
  await expect(history.getByRole("link", { name: "Verify on the console" })).toHaveCount(1);
  const href = await history
    .getByRole("link", { name: "Verify on the console" })
    .getAttribute("href");
  expect(href).toMatch(/^https:\/\/console\.invalid\//);
});
