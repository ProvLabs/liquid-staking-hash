import { expect, test } from "@playwright/test";

// Portfolio page (plan M6.1 §2.6, app-spec §8.2) against the fixture-backed
// server. Offline there is no session, so the page must render the connect
// prompt (prompt-and-explain, never blank, never another address's data) and
// expose no personal figures. The authenticated view needs a real session,
// which is e2e-live's job. `/portfolio` is already in the axe route list.

test("anonymous portfolio renders the connect prompt, never a blank page", async ({ page }) => {
  await page.goto("/portfolio");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Portfolio");
  await expect(
    page.getByText("Connect a wallet to see your position", { exact: false }),
  ).toBeVisible();
});

test("anonymous portfolio exposes no personal position data", async ({ page }) => {
  await page.goto("/portfolio");
  // None of the session-only sections render for an anonymous visitor.
  await expect(page.getByRole("heading", { name: "Your position" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Transaction history" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Export CSV" })).toHaveCount(0);
});
