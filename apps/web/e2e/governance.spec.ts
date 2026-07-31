import { expect, test } from "@playwright/test";

// Governance center (app-spec §8.7) against the fixture-backed server.
//
// What this layer can and cannot see, stated rather than assumed (R1):
// the corpus's contract admin is a PLAIN ACCOUNT — the contract was deployed
// before the group existed and there is no admin-rotation message (M7 overview
// F2) — so offline the live plane correctly resolves to "no group behind this
// program". These specs therefore exercise the MIRROR end to end plus the honest
// live-unresolved state. The governed live plane is covered by
// `test/governance-data.test.ts` with MSW overrides and by e2e-live.
//
// There is also no session offline, which is the point of the last spec: §8.7 is
// a PUBLIC read, so the whole page must render anonymously.
//
// Both routes are in the axe route list (both themes).

test("the governance list renders the mirrored proposals, never a blank page", async ({ page }) => {
  await page.goto("/governance");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Governance");
  await expect(page.getByRole("heading", { name: "Open" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Outcome history" })).toBeVisible();
  // The drill's proposals, by title, from the captured sweep.
  await expect(page.getByRole("link", { name: "drill-accepted-not-run" })).toBeVisible();
  await expect(page.getByRole("link", { name: "drill-vpe-reject" })).toBeVisible();
});

test("the live plane's absence is STATED, not implied by missing sections", async ({ page }) => {
  await page.goto("/governance");
  // "this deployment has no group behind its admin" — a fact about the
  // deployment, and distinct from "we could not read the chain".
  await expect(
    page.getByText("is a plain account rather than a group policy", { exact: false }),
  ).toBeVisible();
  await expect(page.getByText("Mirrored from height", { exact: false })).toBeVisible();
});

test("every mirrored proposal says WHICH read produced its figures", async ({ page }) => {
  await page.goto("/governance");
  // With no live plane, every row is on the mirror and carries its as-of height.
  const badges = page.locator("[data-plane]");
  await expect(badges.first()).toBeVisible();
  for (const plane of await badges.evaluateAll((nodes) =>
    nodes.map((n) => n.getAttribute("data-plane")),
  )) {
    expect(["indexed", "indexed-fallback", "pruned"]).toContain(plane);
  }
});

test("a pruned proposal says the chain no longer holds it", async ({ page }) => {
  // The corpus has no mirrored ROW for a pruned proposal — only the prune event
  // — so the mock carries that event's three facts and this spec asserts only
  // the label they support (see `app/mocks/handlers.ts`).
  await page.goto("/governance/7");
  await expect(
    page.getByText("The chain no longer holds this proposal", { exact: false }).first(),
  ).toBeVisible();
});

test("the detail page shows the summary above the exact JSON, for every message", async ({
  page,
}) => {
  await page.goto("/governance/4");
  await expect(page.getByRole("heading", { name: "What this proposal does" })).toBeVisible();
  // The corpus's proposals carry MsgSend, which the closed union knows.
  await expect(page.getByText(/^Send [\d.]+ HASH to tp1/)).toBeVisible();
  await expect(page.getByText("Exact message").first()).toBeVisible();
  await expect(page.locator("pre code").first()).toContainText("/cosmos.bank.v1beta1.MsgSend");
});

test("tally, member status and votes all degrade honestly with no live plane", async ({ page }) => {
  await page.goto("/governance/4");
  await expect(page.getByRole("heading", { name: "Tally" })).toBeVisible();
  // The rule is a threshold with no percentage denominator needed, so the
  // verdict is decidable even with the live plane down.
  await expect(page.getByText("Passes at 2 weight in favour")).toBeVisible();
  // The member set could not be read: recorded votes only, and it says so —
  // an empty member table would read as "this group has no members".
  await expect(
    page.getByText("The current member set could not be read", { exact: false }),
  ).toBeVisible();
  await expect(page.getByText("No votes are recorded", { exact: false })).toBeVisible();
});

test("the READ half of the page renders ANONYMOUSLY — §8.7 is still a public read", async ({
  page,
}) => {
  // No session exists offline. No READ section may be withheld: session-address
  // highlighting is decoration, never a gate. The WRITE section is where the
  // distinction matters — the actions section may say "connect a wallet", but
  // nothing above it may be gated on one.
  await page.goto("/governance/4");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  for (const heading of ["Tally", "Member status", "Recorded votes", "What this proposal does"]) {
    await expect(page.getByRole("heading", { name: heading })).toBeVisible();
  }
  // The only connect prompt is inside the actions section.
  const prompts = page.getByRole("main").getByText(/connect a wallet/i);
  await expect(prompts).toHaveCount(1);
});

test("NO action control renders for an anonymous reader, in any state", async ({ page }) => {
  // The affordance sweep. Offline the corpus is ungoverned and there is no
  // session, so EVERY row of the affordance matrix lands on "hidden" — and what must
  // never appear is a control the reader could press into a certain failure.
  // The per-row logic is unit-gated in `test/governance-flows.test.ts`; this is
  // the end-to-end assertion that the loader's verdict actually reaches the DOM.
  for (const id of ["4", "5", "7"]) {
    await page.goto(`/governance/${id}`);
    for (const name of [/^Review and sign$/, /^Execute/, /^Vote/]) {
      await expect(page.getByRole("button", { name }), `${id} ${String(name)}`).toHaveCount(0);
    }
  }
});

test("the composer is member-gated and says which gate stopped you", async ({ page }) => {
  // Offline there is no session, so `/governance/new` renders the connect
  // prompt — never a form that would build a transaction nobody can sign, and
  // never a blank page.
  await page.goto("/governance/new");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Propose an admin action");
  await expect(page.getByText("Connect a wallet to compose", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Review and sign$/ })).toHaveCount(0);
});

test("the list links to the composer and no longer promises a later release", async ({ page }) => {
  await page.goto("/governance");
  await expect(page.getByRole("link", { name: "New proposal" })).toBeVisible();
  await expect(page.getByText("This page is read-only", { exact: false })).toHaveCount(0);
});

test("the status filter narrows the list and is reflected in the URL", async ({ page }) => {
  await page.goto("/governance");
  await page.getByRole("link", { name: "Rejected", exact: true }).click();
  await expect(page).toHaveURL(/status=rejected/);
  await expect(page.getByRole("link", { name: "drill-vpe-reject" })).toBeVisible();
  await expect(page.getByRole("link", { name: "drill-accepted-not-run" })).toHaveCount(0);
});

test("a malformed id is rejected and an unknown id is a 404 — not a blank proposal", async ({
  page,
}) => {
  const malformed = await page.goto("/governance/01");
  expect(malformed?.status()).toBe(400);
  const missing = await page.goto("/governance/999999");
  expect(missing?.status()).toBe(404);
});
