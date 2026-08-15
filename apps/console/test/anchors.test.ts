// Entity-anchor grammar gate (console-spec §14 item 9). The GOLDEN STRINGS
// below are cross-pinned with apps/web/test/verify-link.test.ts — the two
// codebases cannot share code, so both suites pin the same strings against
// the spec record and drift fails whichever side moved.
import { describe, expect, it } from "vitest";
import { anchorDomId, anchorMissNotice, formatAnchor, parseAnchor } from "@/lib/anchors";
import { anchorDecision } from "@/lib/use-anchor";

const VALOPER = "pbvaloper1qypqxpq9qcrsszg2pvxq6rs0zqg3yyc5z5tpwxqergd3c8g4vgu5rmfd7";

describe("anchor grammar (the §14 item 9 spec record, cross-pinned)", () => {
  it("formats the four golden strings", () => {
    expect(formatAnchor({ kind: "request", id: 7 })).toBe("#req-7");
    expect(formatAnchor({ kind: "validator", valoper: VALOPER })).toBe(`#val-${VALOPER}`);
    expect(formatAnchor({ kind: "epoch", index: 12 })).toBe("#epoch-12");
    expect(formatAnchor({ kind: "proposal", id: "4" })).toBe("#prop-4");
  });

  it("parse is format's inverse for every kind", () => {
    const anchors = [
      { kind: "request", id: 7 },
      { kind: "validator", valoper: VALOPER },
      { kind: "epoch", index: 12 },
      { kind: "proposal", id: "4" },
    ] as const;
    for (const a of anchors) {
      expect(parseAnchor(formatAnchor(a).slice(1))).toEqual(a);
    }
  });

  it("tolerates unknown fragments as null, never a throw", () => {
    for (const f of [
      "",
      "section-2",
      "req-",
      "req-abc",
      "req-1x",
      "val-UPPER",
      "val-x", // below the bech32 minimum length
      "epoch--1",
      "prop-1.5",
      "prop-", // empty id
      "unknown-kind-9",
      "req-99999999999999999999", // beyond the numeric bound
    ]) {
      expect(parseAnchor(f), f).toBeNull();
    }
  });

  it("takes the whole fragment or nothing (no prefix/suffix salvage)", () => {
    expect(parseAnchor("req-7-extra")).toBeNull();
    expect(parseAnchor("xreq-7")).toBeNull();
  });

  it("the DOM id is the fragment without the hash", () => {
    expect(anchorDomId({ kind: "request", id: 7 })).toBe("req-7");
    expect(anchorDomId({ kind: "proposal", id: "4" })).toBe("prop-4");
  });
});

describe("anchor state machine (§2.1 / C4 cells)", () => {
  const req = { kind: "request", id: 3 } as const;

  it("no anchor → none", () => {
    expect(anchorDecision(null, false, "none", true, true)).toBe("none");
  });

  it("anchor + owning read not yet successful → pending, never missing", () => {
    // Absence is not a fact until a successful read (chain-facts §x/group 3
    // generalized): a failed or still-loading query must not produce a miss.
    expect(anchorDecision(req, false, "none", false, false)).toBe("pending");
  });

  it("anchor + successful read + row present → found", () => {
    expect(anchorDecision(req, false, "pending", true, true)).toBe("found");
  });

  it("anchor + successful read + row absent → missing", () => {
    expect(anchorDecision(req, false, "pending", true, false)).toBe("missing");
  });

  it("applies once: later polls never change the decision (C3)", () => {
    // After the first successful read decided "found", a poll in which the
    // row disappeared must not re-decide (and above all must not re-scroll).
    expect(anchorDecision(req, true, "found", true, false)).toBe("found");
    expect(anchorDecision(req, true, "missing", true, true)).toBe("missing");
  });
});

describe("anchor-miss notices (the entity-specific honesty copy)", () => {
  it("names the entity and the reason per kind", () => {
    expect(anchorMissNotice({ kind: "request", id: 9 })).toContain("request #9");
    expect(anchorMissNotice({ kind: "validator", valoper: VALOPER })).toContain(VALOPER);
    expect(anchorMissNotice({ kind: "epoch", index: 3 })).toContain("history accrues per browser");
    expect(anchorMissNotice({ kind: "proposal", id: "2" })).toContain("pruned");
    expect(anchorMissNotice({ kind: "proposal", id: "2" })).toContain("App's governance record");
  });

  it("the epoch notice quotes ledger coverage when known", () => {
    expect(
      anchorMissNotice({ kind: "epoch", index: 3 }, { ledgerCoverage: "epochs #7–#14" }),
    ).toContain("epochs #7–#14 in this browser");
  });
});
