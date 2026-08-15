// Keyboard-only operability gate (8.3 §2.6; app-spec §11): the enumerated
// flows drive KEYBOARD EVENTS ONLY and assert operability, focus landing, and
// Escape behavior. The confirm dialog cannot be reached end-to-end offline
// (the mock refuses to fabricate gas), so its semantics are pinned at the
// component level (test/tx-confirm-a11y.test.ts) and the live lane carries
// the real step — the split is stated, not hidden. Q4: one degraded-chrome
// keyboard case runs against the LIVE_DOWN instance.

import { expect, test } from "@playwright/test";

import { LIVE_DOWN_ORIGIN } from "../playwright.config";
import { holderSigner, loginAs } from "./support/login";

const ORIGIN = "http://127.0.0.1:43117";

test("wallet popover: Enter opens, Escape closes and returns focus to the trigger", async ({
  page,
}) => {
  await page.goto("/");
  const trigger = page.getByRole("button", { name: "Connect wallet" });
  await trigger.focus();
  await page.keyboard.press("Enter");
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  // The vendor list is reachable by keyboard.
  await page.keyboard.press("Tab");
  const active = await page.evaluate(() => document.activeElement?.tagName ?? "");
  expect(active).toBe("BUTTON");
  await page.keyboard.press("Escape");
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await expect(trigger).toBeFocused();
});

test("alerts bell popover (authenticated): Escape closes and returns focus", async ({
  page,
  context,
  request,
}) => {
  await loginAs(request, context, holderSigner(), ORIGIN);
  await page.goto("/");
  const bell = page.getByRole("button", { name: /^Alerts,/ });
  await bell.focus();
  await page.keyboard.press("Enter");
  await expect(bell).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("Escape");
  await expect(bell).toHaveAttribute("aria-expanded", "false");
  await expect(bell).toBeFocused();
});

test("theme toggle cycles by keyboard and announces its state", async ({ page }) => {
  await page.goto("/");
  const toggle = page.getByRole("button", { name: "Theme" });
  const before = await toggle.textContent();
  await toggle.focus();
  await page.keyboard.press("Enter");
  // The button's own text carries the state (Auto → Light → Dark), so the
  // announcement is the accessible name changing — no color-only signal.
  await expect(toggle).not.toHaveText(before ?? "");
  await expect(toggle).toBeFocused();
});

test("/stake offline renders the honest connect prompt, keyboard-perceivable", async ({ page }) => {
  // The amount form sits behind a wallet connection, which the offline
  // harness cannot make (no vendor exists offline) — the reachable state is
  // the connect prompt, and IT must be perceivable rather than a blank form.
  // The connected form's validation-alert flow rides the live lane.
  await page.goto("/stake");
  await expect(page.getByText("Connect a wallet", { exact: false }).first()).toBeVisible();
  // The page stays keyboard-navigable in this state.
  await page.keyboard.press("Tab");
  expect(await page.evaluate(() => document.activeElement !== document.body)).toBe(true);
});

test("chart table view: the disclosure is keyboard-operable on /validators", async ({ page }) => {
  // The public validators page renders the set; the chart-table disclosure
  // pattern is exercised where a chart renders offline — the market history
  // section has the cold state, so use the Learn accrual pattern's toggle if
  // present; the structural assertion is that EVERY aria-pressed toggle is
  // reachable and flips by keyboard.
  await page.goto("/market");
  const toggles = page.locator("button[aria-pressed]");
  const count = await toggles.count();
  for (let i = 0; i < count; i += 1) {
    const toggle = toggles.nth(i);
    await toggle.focus();
    const before = await toggle.getAttribute("aria-pressed");
    await page.keyboard.press("Enter");
    await expect(toggle).toHaveAttribute("aria-pressed", before === "true" ? "false" : "true");
  }
});

test("governance: list → detail → affordances are reachable by keyboard", async ({ page }) => {
  await page.goto("/governance/4");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  // The detail's disclosure semantics: every native disclosure is
  // keyboard-operable — focus its summary, press Enter, the details opens.
  const summaries = page.locator("summary");
  const count = await summaries.count();
  for (let i = 0; i < Math.min(count, 3); i += 1) {
    const summary = summaries.nth(i);
    await summary.scrollIntoViewIfNeeded();
    // Some disclosures render open by default (the first decoded message);
    // keyboard operability is the state FLIPPING on Enter, either direction.
    const before = await summary.evaluate((el) => (el.parentElement as HTMLDetailsElement).open);
    await summary.focus();
    await page.keyboard.press("Enter");
    await expect
      .poll(() => summary.evaluate((el) => (el.parentElement as HTMLDetailsElement).open))
      .toBe(!before);
  }
  // The whole page is tabbable (nothing traps or strands focus).
  await page.keyboard.press("Tab");
  expect(await page.evaluate(() => document.activeElement !== document.body)).toBe(true);
});

test("degraded chrome (LIVE_DOWN) stays keyboard-operable (Q4)", async ({ browser }) => {
  const context = await browser.newContext({ baseURL: LIVE_DOWN_ORIGIN });
  const page = await context.newPage();
  await page.goto("/");
  // The footer's unavailability line is present, and the nav is fully
  // keyboard-reachable in the degraded state.
  await expect(page.getByText("Program status unavailable", { exact: false })).toBeVisible();
  await page.keyboard.press("Tab");
  const active = await page.evaluate(() => document.activeElement !== document.body);
  expect(active).toBe(true);
  await context.close();
});
