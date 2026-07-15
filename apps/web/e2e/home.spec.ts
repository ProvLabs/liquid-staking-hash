import { expect, test } from "@playwright/test";

import { manifest } from "./fixture-manifest";

// SSR + $lang+ routing + themes against the fixture-backed server.

test("renders the home page at / (default locale)", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("nvHASH");
});

test("serves the same page under /en", async ({ page }) => {
  await page.goto("/en");
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("nvHASH");
});

test("404s an unsupported locale instead of silently falling back", async ({ page }) => {
  const response = await page.goto("/xx");
  expect(response?.status()).toBe(404);
});

test("footer shows the configured chain id and a console link", async ({ page }) => {
  await page.goto("/");
  const footer = page.locator("footer");
  await expect(footer).toContainText(manifest.chain_id);
  await expect(footer.getByRole("link")).toHaveAttribute("href", "https://console.invalid");
});

test("theme toggle cycles auto → light → dark and persists via cookie", async ({ page }) => {
  await page.goto("/");
  const html = page.locator("html");
  const toggle = page.getByRole("button", { name: "Theme" });

  await expect(html).not.toHaveAttribute("data-theme");
  await toggle.click();
  await expect(html).toHaveAttribute("data-theme", "light");
  await toggle.click();
  await expect(html).toHaveAttribute("data-theme", "dark");

  // Cookie persists: a fresh SSR paint arrives already-dark (no flash).
  await page.reload();
  await expect(html).toHaveAttribute("data-theme", "dark");

  await toggle.click();
  await expect(html).not.toHaveAttribute("data-theme"); // back to auto
});
