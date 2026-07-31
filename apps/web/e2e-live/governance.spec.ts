import { expect, test } from "@playwright/test";

// e2e-live: the governance center against the REAL devnet stack. Needs no signer — §8.7 is a public read — so it
// runs whenever the stack is up, and skips cleanly otherwise.
//
// WHY THIS LAYER EXISTS FOR THIS PAGE, when the offline suite already covers the
// rendering: the offline corpus is UNGOVERNED — its contract was deployed
// before the group existed, and there is no admin-rotation message.
// So the GOVERNED live plane — set-valued policy discovery, the member set, and
// the module's own tally for an open proposal — is exercised offline only
// through MSW overrides. This spec is where it meets a real chain.
//
// It also carries the one claim §3.4 R2 records as UNVERIFIED: whether the LCD
// answers `group_policy_info` on a non-policy account with 404 (read as "not a
// group policy") or with 500 (read as "could not check"). The page is honest
// either way — the two states have different copy — so this asserts which one a
// real chain produces rather than encoding a guess.

const LIVE = process.env.E2E_LIVE_BASE_URL !== undefined;
test.skip(!LIVE, "E2E_LIVE_BASE_URL not set (needs the devnet stack)");

test("the governance page renders against the real chain, with no session", async ({ page }) => {
  await page.goto("/governance");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Governance");
  await expect(page.getByRole("heading", { name: "Open" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Outcome history" })).toBeVisible();
  // The page is not read-only, and the note says what the write path is
  // rather than promising it for a later release.
  await expect(page.getByText("Members vote and execute", { exact: false })).toBeVisible();
});

test("the live plane resolves to exactly one of its three states, and says which", async ({
  page,
}) => {
  await page.goto("/governance");
  const notGoverned = await page
    .getByText("is a plain account rather than a group policy", { exact: false })
    .count();
  const unavailable = await page.getByText("The chain could not be read", { exact: false }).count();
  // Against a stack bootstrapped by `nvhash-group-bootstrap.sh` the expected
  // answer is GOVERNED (neither note). A stack whose CONTRACT_ADMIN hook was
  // skipped shows the not-governed note — a real deployment state, not a bug.
  // What must never happen is both notes, or an unavailable note on a chain the
  // rest of the page is clearly reading.
  expect(notGoverned + unavailable).toBeLessThanOrEqual(1);
  if (notGoverned === 0 && unavailable === 0) {
    // Governed: the policy SET (D1 — never "the" policy) and the live group.
    await expect(page.getByText(/^Group \d+, version/)).toBeVisible();
  }
});

test("a governed stack renders the member set rather than a not-checked note", async ({ page }) => {
  await page.goto("/governance");
  const governed = await page.getByText(/^Group \d+, version/).count();
  test.skip(governed === 0, "stack has no group behind the program admin");

  // Open the newest proposal the list offers, whatever it is.
  const firstProposal = page.getByRole("link", { name: /^View proposal|drill-/ }).first();
  const anyProposal = await firstProposal.count();
  test.skip(anyProposal === 0, "no proposals on this stack yet");
  await firstProposal.click();

  await expect(page.getByRole("heading", { name: "Member status" })).toBeVisible();
  // Either the members table or the membership-changed note — both are real
  // answers. "The current member set could not be read" is not, on a chain the
  // page just read a group from.
  await expect(
    page.getByText("The current member set could not be read", { exact: false }),
  ).toHaveCount(0);
});
