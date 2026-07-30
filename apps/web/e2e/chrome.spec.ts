import { expect, test } from "@playwright/test";

import { LIVE_DOWN_ORIGIN } from "../playwright.config";
import { manifest } from "./fixture-manifest";

// Global chrome (app-spec §8.0): nav that never 404s, environment
// badge, banner slot honesty, and the footer freshness line, against the
// fixture-backed server (pristine corpus) and the live-down server instance.

test("nav renders all §8.0 items and marks the active route", async ({ page }) => {
  await page.goto("/");
  const nav = page.getByRole("navigation", { name: "Primary" });
  for (const label of ["Learn", "Stake", "Portfolio", "Market", "Validators", "Governance"]) {
    await expect(nav.getByRole("link", { name: label })).toBeVisible();
  }
  await expect(nav.getByRole("link", { name: "Learn" })).toHaveAttribute("aria-current", "page");

  await nav.getByRole("link", { name: "Stake" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Stake");
  await expect(nav.getByRole("link", { name: "Stake" })).toHaveAttribute("aria-current", "page");
  await expect(nav.getByRole("link", { name: "Learn" })).not.toHaveAttribute(
    "aria-current",
    "page",
  );
});

test("nav stays locale-prefixed under /en", async ({ page }) => {
  await page.goto("/en");
  const nav = page.getByRole("navigation", { name: "Primary" });
  await expect(nav.getByRole("link", { name: "Market" })).toHaveAttribute("href", "/en/market");
});

test("environment badge is loud (labeled) off production", async ({ page }) => {
  await page.goto("/");
  const header = page.locator("header");
  await expect(header).toContainText("development");
  await expect(header).toContainText(manifest.chain_id);
});

test("pristine program state renders no banner", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("status")).toHaveCount(0);
});

test("footer renders the honest n/a freshness line (null heights)", async ({ page }) => {
  await page.goto("/");
  const footer = page.locator("footer");
  await expect(footer).toContainText("Indexed to block n/a");
  await expect(footer).not.toContainText("Program status unavailable");
});

test("failed live reads degrade honestly: no banner, footer says unavailable", async ({
  page,
}) => {
  await page.goto(`${LIVE_DOWN_ORIGIN}/`);
  await expect(page.getByRole("status")).toHaveCount(0);
  await expect(page.locator("footer")).toContainText("Program status unavailable");
});
