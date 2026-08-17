// Degradation drills, observation half: infra/devnet/drills.sh sequences
// the failures; these specs only observe HTTP. Each degraded phase asserts
// the POSITIVE presence of the labeled state (a drill fails on silence);
// `baseline` asserts the absence first so a positive is caused, not ambient.

import { expect, test, type Page } from "@playwright/test";

import { activeDrillPhase, onlyInPhase } from "./phase";

test.skip(
  activeDrillPhase() === undefined,
  "E2E_DRILL_PHASE not set (driven by infra/devnet/drills.sh)",
);

const DEGRADED_LABEL = "Data degraded";
const DEGRADED_CONSEQUENCE = "Recent history may lag the chain. Live figures remain authoritative.";
const STATUS_UNAVAILABLE = "Program status unavailable";

/** CO-23: the coming-soon shells render as labeled states in every phase. */
async function assertShellsLabeled(page: Page): Promise<void> {
  await page.goto("/market");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Market");
  await expect(
    page.getByText("No bridged nvHASH market exists yet", { exact: false }),
  ).toBeVisible();
  await page.goto("/exit");
  await expect(page.getByText("Coming soon", { exact: false })).toBeVisible();
}

test.describe("baseline (the control: no degraded state is ambient)", () => {
  onlyInPhase("baseline");

  test("healthy stack renders no banner, a live footer, and labeled shells", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByText(DEGRADED_LABEL, { exact: false })).toHaveCount(0);
    await expect(page.getByText(STATUS_UNAVAILABLE, { exact: false })).toHaveCount(0);
    // The footer certifies a real indexed height on a running stack.
    await expect(page.getByText(/Indexed to block \d+/)).toBeVisible();
    await assertShellsLabeled(page);
  });
});

test.describe("corrupt-row (drill 1: the alarm chain is wired end to end)", () => {
  onlyInPhase("corrupt-row");

  test("an open reconciler_divergence renders the degraded banner; live figures survive", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(page.getByText(DEGRADED_LABEL, { exact: false })).toBeVisible();
    await expect(page.getByText(DEGRADED_CONSEQUENCE, { exact: false })).toBeVisible();
    // The live plane stays authoritative: no "unavailable", and the paused/
    // halted banners are not fabricated from an indexed-plane incident.
    await expect(page.getByText(STATUS_UNAVAILABLE, { exact: false })).toHaveCount(0);
    await expect(page.getByText("Program halted", { exact: false })).toHaveCount(0);
    await assertShellsLabeled(page);
  });
});

test.describe("repair (both directions: the alarm clears)", () => {
  onlyInPhase("repair");

  test("the repaired row closes the incident and the banner clears", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByText(DEGRADED_LABEL, { exact: false })).toHaveCount(0);
  });
});

test.describe("indexer-kill (drill 2: history dims — the 8.1 §2.2 mechanism)", () => {
  onlyInPhase("indexer-kill");

  test("a dead indexer flips degraded via the data's age, with the height delta frozen", async ({
    page,
  }) => {
    await page.goto("/");
    // The banner is the stale-heads clause firing: the frozen heights alone
    // would never flip it (that was the plan-time finding).
    await expect(page.getByText(DEGRADED_LABEL, { exact: false })).toBeVisible();
    // Canonical values survive: the live plane is untouched by the indexer.
    await expect(page.getByText(STATUS_UNAVAILABLE, { exact: false })).toHaveCount(0);
    // The footer age describes the DATA: past the threshold it reads in
    // minutes, never "(0s ago)" from the response clock.
    await expect(page.getByText(/Indexed to block \d+ \(\d+m ago\)/)).toBeVisible();
    await assertShellsLabeled(page);
  });
});

test.describe("indexer-recover", () => {
  onlyInPhase("indexer-recover");

  test("a restarted indexer clears the degraded banner", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByText(DEGRADED_LABEL, { exact: false })).toHaveCount(0);
    await expect(page.getByText(STATUS_UNAVAILABLE, { exact: false })).toHaveCount(0);
  });
});

test.describe("lcd-kill (drill 3: no fabricated program health)", () => {
  onlyInPhase("lcd-kill");

  test("a dead LCD yields 'status unavailable', never a fabricated banner or a 0", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(page.getByText(STATUS_UNAVAILABLE, { exact: false })).toBeVisible();
    // No paused/halted claim without a successful live read.
    await expect(page.getByText("Program halted", { exact: false })).toHaveCount(0);
    await expect(page.getByText("Deposits are paused", { exact: false })).toHaveCount(0);
    await assertShellsLabeled(page);
  });
});

test.describe("lcd-recover (invariant 7: the alarm outlives what it watches)", () => {
  onlyInPhase("lcd-recover");

  test("the stack returns to healthy unattended after the LCD comes back", async ({ page }) => {
    // This phase is what proves the per-pass tolerance + restart policy: no
    // hands touched the stack between lcd-kill and here.
    await page.goto("/");
    await expect(page.getByText(STATUS_UNAVAILABLE, { exact: false })).toHaveCount(0);
    await expect(page.getByText(DEGRADED_LABEL, { exact: false })).toHaveCount(0);
    await expect(page.getByText(/Indexed to block \d+/)).toBeVisible();
  });
});
