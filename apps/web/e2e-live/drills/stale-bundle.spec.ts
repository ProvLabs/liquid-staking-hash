// The stale-bundle gate (8.1 §2.8; web-design-notes "Live e2e re-run trap"):
// a green live run must certify the bundle it ran against. The compose `web`
// service builds at container START, so a long-running stack serves a stale
// bundle — it has already blessed code that was not deployed once. The
// `stack.sh e2e` entry restarts web and exports E2E_LIVE_STACK_PREPARED_AT;
// this spec runs FIRST in every prepared session and FAILS when the served
// bundle's `started_at` predates it. Unset (an ad-hoc local run outside the
// entry), it skips clean like its siblings — with the documented manual
// restart as before.

import { expect, test } from "@playwright/test";

const PREPARED_AT = process.env.E2E_LIVE_STACK_PREPARED_AT;
test.skip(
  PREPARED_AT === undefined,
  "E2E_LIVE_STACK_PREPARED_AT not set (run through `stack.sh e2e`)",
);

test("the served bundle postdates this session's preparation", async ({ request }) => {
  const res = await request.get("/healthz");
  expect(res.ok()).toBe(true);
  const body = (await res.json()) as { started_at?: string };
  expect(body.started_at, "/healthz must report started_at (commit C of 8.1)").toBeDefined();
  const startedMs = Date.parse(body.started_at ?? "");
  expect(Number.isFinite(startedMs)).toBe(true);
  const preparedMs = Number(PREPARED_AT) * 1000;
  expect(
    startedMs,
    `served bundle started ${body.started_at} — BEFORE this session's prepared-at ` +
      `(${new Date(preparedMs).toISOString()}): the stack is serving a STALE bundle. ` +
      "Run through `infra/devnet/stack.sh e2e`, which restarts web first.",
  ).toBeGreaterThanOrEqual(preparedMs);
});
