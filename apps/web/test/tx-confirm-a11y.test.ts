// Confirm-step semantics, pinned at the component level (offline e2e cannot
// reach the confirm): DOM order, native <details> disclosure, tier by text
// never color alone. Rendered with react-dom/server.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TxConfirm } from "~/tx/confirm";
import type { TxPlan } from "~/tx/build";

const plan = { disclosureJson: '{"kind":"swap_in"}' } as TxPlan;

function render(tier: "info" | "warning" | "danger"): string {
  return renderToStaticMarkup(
    createElement(TxConfirm, {
      locale: "en",
      plan,
      summaryLines: ["You stake 10 HASH."],
      feeDisplay: "0.001911 HASH",
      tier,
      onConfirm: () => {},
      onCancel: () => {},
    }),
  );
}

describe("TxConfirm semantics (the §10.2 step-4 dialog)", () => {
  it("is a labelled alertdialog with the reading order summary → disclosure → actions", () => {
    const html = render("info");
    expect(html).toContain('role="alertdialog"');
    expect(html).toContain("aria-labelledby");
    const order = [
      html.indexOf("You stake 10 HASH."),
      html.indexOf("<details"),
      html.indexOf("Cancel"),
      html.indexOf("Sign in wallet"),
    ];
    for (const index of order) expect(index).toBeGreaterThan(-1);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("exposes the exact signing payload behind a native operable disclosure", () => {
    const html = render("info");
    expect(html).toContain("<summary");
    expect(html).toContain(plan.disclosureJson.replace(/"/g, "&quot;"));
  });

  it("communicates warning and danger tiers by TEXT, never color alone", () => {
    expect(render("warning")).toContain("Caution: this action moves funds");
    expect(render("danger")).toContain("Danger: this is a program-level operation");
    expect(render("info")).not.toContain("Caution:");
  });
});
