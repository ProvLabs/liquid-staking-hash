import { expect, test } from "@playwright/test";

// Stake page (app-spec §8.3) against the fixture-backed server.
// The anonymous surface: inline education, the next-epoch date, and the
// connect prompt — the wallet-driven amount/preview/sign path is exercised
// by the e2e-live drill (needs a real signer), not offline.

test("renders the inline education and the next-epoch date", async ({ page }) => {
  await page.goto("/stake");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Stake");
  await expect(page.getByText("You deposit HASH into the vault", { exact: false })).toBeVisible();
  await expect(page.getByText("your nvHASH amount stays fixed", { exact: false })).toBeVisible();
  await expect(page.getByText("Next expected epoch step", { exact: false })).toBeVisible();
});

test("anonymous visitors see the connect prompt, not an amount field", async ({ page }) => {
  await page.goto("/stake");
  await expect(page.getByText("Connect a wallet to stake", { exact: false })).toBeVisible();
  await expect(page.getByLabel("Amount to deposit (HASH)")).toHaveCount(0);
});
