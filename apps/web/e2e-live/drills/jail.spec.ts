// The jail lane's observation hook: run by jail-drill.sh via
// JAIL_OBSERVE_CMD between "reports exist" and the first purge. Gated on
// E2E_JAIL_VALOPER; skips clean standalone. The teardown re-invokes this
// file with E2E_JAIL_EXPECT=closed.

import { expect, test } from "@playwright/test";

const VALOPER = process.env.E2E_JAIL_VALOPER;
const API = process.env.E2E_LIVE_API_URL ?? "http://localhost:8080";
const EXPECT = process.env.E2E_JAIL_EXPECT ?? "open";

test.skip(
  VALOPER === undefined,
  "E2E_JAIL_VALOPER not set (driven by jail-drill.sh's observe hook)",
);

test(`the jail_report incident is ${EXPECT} for the drilled validator`, async ({ request }) => {
  const res = await request.get(`${API}/api/v1/incidents?limit=200`);
  expect(res.ok()).toBe(true);
  const body = (await res.json()) as {
    data: Array<{ kind: string; closed_at: string | null }>;
  };
  const jailIncidents = body.data.filter((row) => row.kind === "jail_report");
  if (EXPECT === "open") {
    expect(
      jailIncidents.some((row) => row.closed_at === null),
      "no OPEN jail_report incident while the chain holds a jail report — the reconciler's " +
        "jail decoder (8.1 commit A) is not producing",
    ).toBe(true);
  } else {
    expect(
      jailIncidents.every((row) => row.closed_at !== null),
      "a jail_report incident is still open after the purge — the episode did not close",
    ).toBe(true);
  }
});

test("the public validators page renders the jailed validator's state honestly", async ({
  page,
}) => {
  test.skip(EXPECT !== "open", "rendering is asserted while the report is live");
  await page.goto("/validators");
  // The live table is this page's per-validator source: the drilled valoper's
  // row must carry the Jailed status — never a healthy rendering of a
  // validator the chain has jailed.
  const row = page.getByRole("row").filter({ hasText: VALOPER!.slice(-8) });
  await expect(row.getByText("Jailed", { exact: false })).toBeVisible();
});
