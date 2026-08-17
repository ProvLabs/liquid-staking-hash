// Chart-table disclosure semantics, pinned here because no populated chart
// renders in the offline e2e corpus (e2e/keyboard.spec.ts holds the tripwire).

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StepChart } from "~/components/charts/step-chart";

function render(): string {
  return renderToStaticMarkup(
    createElement(StepChart, {
      title: "NAV per share",
      caption: "Monthly settlements.",
      showTableLabel: "Show table",
      showChartLabel: "Show chart",
      points: [1, 1.01],
      firstXLabel: "#1",
      lastXLabel: "#2",
      formatAxisValue: (value: number) => value.toFixed(4),
      tableHeaders: ["Settlement", "NAV"],
      tableRows: [
        ["1", "1.0000"],
        ["2", "1.0100"],
      ],
    }),
  );
}

describe("StepChart disclosure semantics", () => {
  it("offers the table view behind a native button exposing pressed state", () => {
    const html = render();
    expect(html).toMatch(/<button[^>]*aria-pressed="false"/);
    expect(html).toContain("Show table");
    expect(html).not.toContain("<table");
  });

  it("titles the chart for AT", () => {
    const html = render();
    expect(html).toContain('role="img"');
    expect(html).toContain('aria-label="NAV per share"');
  });
});
