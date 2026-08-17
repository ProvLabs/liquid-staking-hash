// Reduced-motion gate (WCAG 2.3.3): the kill switch zeroes every animation
// and transition; the non-vacuity case pins that the animation exists
// without the preference.

import { expect, test } from "@playwright/test";

async function pulseDurations(
  page: import("@playwright/test").Page,
): Promise<{ animation: string; transition: string }> {
  await page.goto("/");
  const pulse = page.locator(".flow-pulse").first();
  await expect(pulse).toBeAttached();
  return pulse.evaluate((el) => {
    const style = getComputedStyle(el);
    return { animation: style.animationDuration, transition: style.transitionDuration };
  });
}

test("prefers-reduced-motion zeroes the Learn hero animation", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const { animation } = await pulseDurations(page);
  // The kill switch sets 0.01ms — effectively zero, never the 3.2s pulse.
  expect(Number.parseFloat(animation)).toBeLessThanOrEqual(0.001);
});

test("without the preference the animation is present (non-vacuity)", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  const { animation } = await pulseDurations(page);
  expect(Number.parseFloat(animation)).toBeGreaterThan(1);
});

test("a transition-bearing control is zeroed under the preference too", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  const control = page.getByRole("button").first();
  const transition = await control.evaluate((el) => getComputedStyle(el).transitionDuration);
  for (const value of transition.split(",")) {
    expect(Number.parseFloat(value)).toBeLessThanOrEqual(0.001);
  }
});
