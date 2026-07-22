import { expect, test } from "@playwright/test";

import { E2E_SERVER_ONLY_API, E2E_SERVER_ONLY_LCD } from "../playwright.config";

// Runtime side of the bundle-secret gate (SECURITY.md, app-spec §7): the
// build-time scan proves no server-only env value is inlined; this proves the
// running server does not serialize one either. The e2e server's LCD_URL is a
// sentinel origin — if it shows up in any byte the browser receives, the
// client-safe boundary is broken.

test("server-only config never reaches the page", async ({ page }) => {
  const bodies: string[] = [];
  page.on("response", async (response) => {
    const type = response.headers()["content-type"] ?? "";
    if (/(text|json|javascript)/.test(type)) {
      bodies.push(await response.text().catch(() => ""));
    }
  });

  await page.goto("/");
  await page.waitForLoadState("networkidle");

  expect(bodies.length).toBeGreaterThan(0);
  for (const body of bodies) {
    expect(body).not.toContain(E2E_SERVER_ONLY_LCD);
    expect(body).not.toContain("server-only-lcd.sentinel");
    expect(body).not.toContain(E2E_SERVER_ONLY_API);
    expect(body).not.toContain("server-only-api.sentinel");
  }
});
