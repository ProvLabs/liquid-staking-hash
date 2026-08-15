// The jail lane's observation hook (8.1 §2.7, CO-19 / D30): run by
// contracts/drills/jail-drill.sh through JAIL_OBSERVE_CMD between "reports
// exist" and the first purge, on the lane's DEDICATED chain (real downtime
// jailing needs the default slash window, which only a purpose-reset chain
// has — the m6.4 constraint). It asserts what per-PR CI cannot: the only live
// jailed-validator rendering, and the jail_report incident lifecycle
// (delivered in commit A per Q1 — both planes must tell the story).
//
// Gated on E2E_JAIL_VALOPER (exported by the drill hook); skips clean
// standalone. The teardown assertion (incident closed after purge) lives in
// the drill script's final phase, which re-invokes this file with
// E2E_JAIL_EXPECT=closed.

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
