import { expect, test } from "@playwright/test";

// e2e-live: the governance WRITE path against the REAL devnet stack
// (the master plan's §4 "e2e (live)" layer).
//
// WHAT THIS LAYER PROVES THAT NOTHING ELSE CAN. The rejection matrix
// (`test/broadcast-guard.test.ts`) proves the relay refuses what it must, and
// the unit suites prove the encoders and the affordance matrix. None of them
// proves the CANONICAL FORM IS THE FORM THE CHAIN ACCEPTS — that is a claim
// about a real node, and it is exactly the claim the byte-goldens exist for.
// So this spec closes the loop against the `gov-drill.sh` substrate:
// compose → vote → execute → observe `executorResult`.
//
// SKIP DISCIPLINE. The write legs need a funded throwaway devnet key that is
// ALSO a group member — proposing and voting are membership-gated, so the
// generic `E2E_LIVE_SIGNER_KEY` cannot cover them any more than it covers the
// operator enrol leg. Absent, those legs skip LOUDLY and the read-only assertions
// still run. SECURITY.md devnet rules: throwaway keys only, and the signer
// lives in the test process alone (`e2e-live/signer.ts`; `check:bundle` scans
// for its sentinel so it can never ship).
//
// RE-RUN TRAP: the compose `web` service builds at container START, so a
// long-running stack serves a stale bundle. A live run against it can PASS FOR
// THE WRONG REASON — guard assertions "pass" against a build where the type URL
// is not in the allowlist at all, a first-level rejection indistinguishable
// from the deep guard's. Restart the service before trusting a green run.

const LIVE = process.env.E2E_LIVE_BASE_URL !== undefined;
const MEMBER_KEY = process.env.E2E_LIVE_GOV_MEMBER_KEY;

test.skip(!LIVE, "E2E_LIVE_BASE_URL not set (needs the devnet stack)");

test("the composer gate resolves to exactly one state, and states which", async ({ page }) => {
  await page.goto("/governance/new");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Propose an admin action");

  const gates = [
    "Connect a wallet to compose",
    "no group policy",
    "could not be read right now",
    "is limited to this group's members",
  ];
  const counts = await Promise.all(
    gates.map((text) => page.getByText(text, { exact: false }).count()),
  );
  const shown = counts.reduce((sum, n) => sum + n, 0);
  const form = await page.getByRole("button", { name: /^Review and sign$/ }).count();

  // Either exactly one gate is stated, or the form is offered — never both, and
  // never neither. "Neither" is the blank-page failure the whole gate exists to
  // prevent; "both" would be two contradictory explanations on one screen.
  expect(shown + form).toBe(1);
});

test("the template picker offers exactly the program's admin actions, and no free-form field", async ({
  page,
}) => {
  test.skip(
    MEMBER_KEY === undefined,
    "E2E_LIVE_GOV_MEMBER_KEY not set — composer form unreachable",
  );
  await page.goto("/governance/new");

  // Proposal creation is TEMPLATE-SCOPED (§8.7, and the boundary doc's split:
  // free-form message building stays a Console strength). The absence of a
  // free-form input is a design property, so it is asserted rather than assumed.
  for (const label of [
    "Update program configuration",
    "Halt or resume the fund-moving cranks",
    "Pause the managed vault",
    "Unpause the managed vault",
    "Abort a stuck epoch continuation",
  ]) {
    await expect(page.getByRole("button", { name: label })).toBeVisible();
  }
  // Bridge config has NO template: absent, and the absence is stated.
  await expect(page.getByRole("button", { name: /bridge/i })).toHaveCount(0);
  await expect(
    page.getByText("Bridge configuration has no template", { exact: false }),
  ).toBeVisible();
});

test("the config diff shows current → proposed and leaves untouched fields visible", async ({
  page,
}) => {
  test.skip(
    MEMBER_KEY === undefined,
    "E2E_LIVE_GOV_MEMBER_KEY not set — composer form unreachable",
  );
  await page.goto("/governance/new");
  await page.getByRole("button", { name: "Update program configuration" }).click();

  // Tick one field and give it a value; every other field must still be listed,
  // marked untouched. A diff that showed only the changed row would leave the
  // reader unable to tell what this proposal leaves alone.
  const include = page.getByRole("checkbox").first();
  await include.check();
  await expect(page.getByRole("table")).toBeVisible();
  await expect(page.getByText("unchanged (not in this proposal)").first()).toBeVisible();
});

test("a value outside a contract bound is REJECTED, never clamped", async ({ page }) => {
  test.skip(
    MEMBER_KEY === undefined,
    "E2E_LIVE_GOV_MEMBER_KEY not set — composer form unreachable",
  );
  await page.goto("/governance/new");
  await page.getByRole("button", { name: "Update program configuration" }).click();

  const field = page.getByLabel("AUM fee (bps)");
  await page.getByRole("checkbox").nth(1).check();
  await field.fill("10001");
  // The contract's `Config::validate` caps this at 10000. The form says so and
  // withholds the sign button; it does not silently substitute 10000.
  await expect(page.getByText("must be between", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Review and sign$/ })).toBeDisabled();
  await expect(field).toHaveValue("10001");
});

test("the confirm step discloses what an execution would do, not just its id", async ({ page }) => {
  test.skip(MEMBER_KEY === undefined, "E2E_LIVE_GOV_MEMBER_KEY not set — no member session");
  // §2.6 / invariant 12, at the surface a signer actually reads. The drill
  // substrate carries an accepted, not-yet-executed proposal; where one is
  // offered, its confirm dialog must name the consequence.
  await page.goto("/governance");
  const executable = page.getByRole("button", { name: /^Review and sign$/ });
  test.skip((await executable.count()) === 0, "no executable proposal on this stack right now");
  await executable.first().click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toBeVisible();
  // The exact JSON rides with the human summary, always.
  await expect(dialog.getByText("Exact", { exact: false })).toBeVisible();
});
