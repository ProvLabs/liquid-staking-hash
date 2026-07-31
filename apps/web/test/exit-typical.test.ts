// Typical-display gate (app-spec §8.4, §9.5.3, §14.12): the
// guaranteed-vs-typical rule is normative — the typical figure exists ONLY
// when sample-sufficient and not cold-start, and the 60-day guarantee always
// stands regardless. This pins the decision; the component/e2e pin that the
// typical never occupies the promise position.

import { describe, expect, it } from "vitest";

import { typicalDisplay } from "~/exit/typical";
import type { PayoutStats } from "@nvhash/api-types";

const BAND = { band_floor_seconds: 21 * 86400, band_ceiling_seconds: 60 * 86400 };

describe("typicalDisplay", () => {
  it("withholds the typical during cold-start; guarantee still stands", () => {
    const stats: PayoutStats = {
      sample_count: 0,
      median_seconds: null,
      p90_seconds: null,
      cold_start: true,
      ...BAND,
    };
    const d = typicalDisplay(stats);
    expect(d.hasTypical).toBe(false);
    expect(d.withheld).toBe("cold-start");
    expect(d.guaranteeDays).toBe(60);
  });

  it("withholds when below sample threshold (null stats, not cold-start)", () => {
    const stats: PayoutStats = {
      sample_count: 4,
      median_seconds: null,
      p90_seconds: null,
      cold_start: false,
      ...BAND,
    };
    const d = typicalDisplay(stats);
    expect(d.hasTypical).toBe(false);
    expect(d.withheld).toBe("insufficient-sample");
    expect(d.guaranteeDays).toBe(60);
  });

  it("shows median/p90 in whole days when sample-sufficient", () => {
    const stats: PayoutStats = {
      sample_count: 20,
      median_seconds: 26 * 86400,
      p90_seconds: 31 * 86400 + 43200, // 31.5 days → rounds to 32
      cold_start: false,
      ...BAND,
    };
    const d = typicalDisplay(stats);
    expect(d.hasTypical).toBe(true);
    expect(d.medianDays).toBe(26);
    expect(d.p90Days).toBe(32);
    expect(d.guaranteeDays).toBe(60);
  });

  it("holds the 60-day guarantee even when the stats read failed (null)", () => {
    const d = typicalDisplay(null);
    expect(d.hasTypical).toBe(false);
    expect(d.guaranteeDays).toBe(60);
  });
});
