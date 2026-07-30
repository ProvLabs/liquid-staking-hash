import { expect, test } from "@playwright/test";

// Operator view (app-spec §8.6) against the fixture-backed server.
// Offline there is no session, so the page must render the connect prompt and
// expose NOTHING operator-scoped — the same prompt-and-explain posture as
// `/portfolio`. The authenticated states (arrears loudness, the three-state
// banner, the export link) need a real session, which is e2e-live's job; their
// composition is gated offline by test/operator-data.test.ts.
// `/validators/mine` is in the axe route list (both themes).

test("anonymous operator view renders the connect prompt, never a blank page", async ({ page }) => {
  await page.goto("/validators/mine");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("My validator");
  await expect(
    page.getByText("Connect the wallet that operates your validator", { exact: false }),
  ).toBeVisible();
});

test("anonymous operator view exposes no operator data or actions", async ({ page }) => {
  await page.goto("/validators/mine");
  for (const heading of ["Standing", "Net benefit after fees", "Payment history", "Per-epoch history"]) {
    await expect(page.getByRole("heading", { name: heading })).toHaveCount(0);
  }
  // The export is session-gated; its link must not exist for an anonymous visitor.
  await expect(page.getByRole("link", { name: "Export CSV" })).toHaveCount(0);
});

test("the public validators page is unaffected by the operator route", async ({ page }) => {
  // `/validators/mine` is registered after `/validators`; the public page must
  // keep the bare path (a routing regression here would hide the public set).
  await page.goto("/validators");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Validators");
});
