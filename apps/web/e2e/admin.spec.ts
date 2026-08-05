import { expect, test } from "@playwright/test";

// Offline e2e for `/admin` (app-spec §8.8). The offline harness has no session,
// so what it can reach is the ANONYMOUS gate — which is the state plan
// invariant 17 is about: `/admin` is not reachable by a non-admin, and it says
// so rather than 404ing or rendering an empty dashboard.
//
// It also covers invariant 8's client-side half: no analytics request of any
// kind leaves the page. The funnel counters are incremented SERVER-SIDE in
// loaders, so a browser that blocks third-party scripts sees the same page —
// and, more to the point, there is no beacon to block.

test("anonymous /admin renders the connect prompt, not a dashboard and not a 404", async ({
  page,
}) => {
  const response = await page.goto("/admin");
  // 200 with an explanation, deliberately not 404: the route's existence is not
  // a secret (the gate is a capability gate, not a safety gate), and a 404
  // would make a real permissions problem look like a typo.
  expect(response?.status()).toBe(200);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(/admin analytics/i);
  await expect(page.getByRole("status")).toContainText(/connect the wallet/i);
});

test("anonymous /admin renders NO panel data", async ({ page }) => {
  await page.goto("/admin");
  const body = await page.locator("body").innerText();
  // None of the panel headings render, so an unauthenticated visitor sees no
  // program aggregate at all — not even an empty one.
  for (const heading of [
    "Program health",
    "Holder cohort",
    "Validator cohort",
    "Evaluator funnel",
  ]) {
    expect(body).not.toContain(heading);
  }
});

test("the acknowledgment resource route refuses an anonymous POST with 401", async ({
  request,
}) => {
  const response = await request.post("/admin/incidents/ack", {
    data: { incident_id: 1, action: "acknowledge" },
  });
  expect(response.status()).toBe(401);
});

test("no analytics request leaves the page (invariant 8)", async ({ page }) => {
  // The counters are server-side by design (§14.10: no client script, no
  // beacon, no pixel, no cookie). This asserts the observable consequence: the
  // browser issues no request that looks like analytics, first- or third-party.
  const suspicious: string[] = [];
  page.on("request", (request) => {
    const url = request.url();
    if (/analytics|telemetry|beacon|collect|pixel|gtag|segment|plausible|matomo/i.test(url)) {
      suspicious.push(url);
    }
    // Anything leaving the app's own origin is also flagged: a first-party
    // counter that posted somewhere else would be exactly the design §14.10
    // rules out.
    if (!url.startsWith("http://127.0.0.1") && !url.startsWith("http://localhost")) {
      suspicious.push(url);
    }
  });
  await page.goto("/");
  await page.goto("/validators");
  await page.goto("/market");
  await page.waitForLoadState("networkidle");
  expect(suspicious).toEqual([]);
});

test("the counted pages set no analytics cookie", async ({ page, context }) => {
  // §14.10: no cookie, no client identifier. The session cookie is the only
  // one the app sets, and an anonymous visit sets none at all.
  await page.goto("/");
  await page.goto("/validators");
  const cookies = await context.cookies();
  const names = cookies.map((c) => c.name);
  // The theme cookie is a rendering preference, not an identifier; nothing
  // else may appear, and in particular nothing visitor-scoped.
  expect(names.filter((n) => n !== "nvhash-theme")).toEqual([]);
});
