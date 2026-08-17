import { describe, expect, it } from "vitest";
import { tallyCellFor, thresholdProgress, secondsUntil } from "@/lib/governance";
import { mockGovTopology, mockGovTopologyPlainAccount, mockGovProposals } from "@/data/fixtures";
import type { GroupPolicyInfo, TallyCounts } from "@/lib/types";

const ZEROS: TallyCounts = {
  yes_count: "0",
  no_count: "0",
  abstain_count: "0",
  no_with_veto_count: "0",
};
const LIVE: TallyCounts = {
  yes_count: "2",
  no_count: "1",
  abstain_count: "0",
  no_with_veto_count: "0",
};

describe("the zeros-tally rule (§x/group 7)", () => {
  it("an open proposal's tally comes from the Tally query, never final_tally_result", () => {
    const cell = tallyCellFor(
      { status: "PROPOSAL_STATUS_SUBMITTED", final_tally_result: ZEROS },
      LIVE,
      null,
    );
    expect(cell).toEqual({ state: "live", tally: LIVE });
  });

  it("an open proposal with a genuinely-zero LIVE tally is labeled live, not final", () => {
    const cell = tallyCellFor(
      { status: "PROPOSAL_STATUS_SUBMITTED", final_tally_result: ZEROS },
      ZEROS,
      null,
    );
    expect(cell.state).toBe("live");
  });

  it("a failed tally read degrades THAT row with a reason; it never falls back to final_tally_result", () => {
    const cell = tallyCellFor(
      { status: "PROPOSAL_STATUS_SUBMITTED", final_tally_result: LIVE },
      null,
      "LCD 500 /tally",
    );
    expect(cell).toEqual({ state: "unavailable", reason: "LCD 500 /tally" });
  });

  it("a closed proposal's final tally is the module's recorded outcome and is shown", () => {
    const cell = tallyCellFor(
      { status: "PROPOSAL_STATUS_ACCEPTED", final_tally_result: LIVE },
      null,
      null,
    );
    expect(cell).toEqual({ state: "final", tally: LIVE });
  });
});

describe("no-group vs could-not-check (§x/group 8)", () => {
  it("the plain-account variant is a data state, not an error", () => {
    expect(mockGovTopologyPlainAccount).toEqual({ state: "no-group" });
  });

  it("the governed variant carries the set-valued policy topology (D25: two on devnet)", () => {
    expect(mockGovTopology.state).toBe("governed");
    if (mockGovTopology.state === "governed") {
      expect(mockGovTopology.policies.items.length).toBeGreaterThanOrEqual(2);
      // Rendered as found — no expected-count assertion anywhere (1..n rule).
    }
  });
});

describe("truncation is labeled, never a prune signal (§x/group 3, 9)", () => {
  it("the bounded shape carries the cap hit in the type", () => {
    if (mockGovTopology.state !== "governed") throw new Error("fixture shape");
    expect(mockGovTopology.policies.truncated).toBe(false);
    expect(mockGovProposals.truncated).toBe(false);
  });
});

describe("threshold progress (unmodeled rules render unknown, never 0)", () => {
  const policy = (decision: Record<string, unknown>): GroupPolicyInfo => ({
    address: "pb1policy",
    group_id: "1",
    admin: "pb1admin",
    metadata: "",
    version: "1",
    decision_policy: decision,
  });

  it("reads a threshold decision policy", () => {
    expect(thresholdProgress(LIVE, policy({ threshold: "2" }))).toEqual({
      yes: "2",
      threshold: "2",
    });
  });

  it("a percentage or unknown rule yields null (rendered as unknown), never a fabricated 0", () => {
    expect(thresholdProgress(LIVE, policy({ percentage: "0.5" }))).toBeNull();
    expect(thresholdProgress(LIVE, policy({}))).toBeNull();
    expect(thresholdProgress(LIVE, undefined)).toBeNull();
  });
});

describe("countdowns tolerate unparseable instants (C6)", () => {
  it("parses an RFC3339 end and signs a past one negative", () => {
    expect(secondsUntil("2026-01-01T00:00:10Z", Date.parse("2026-01-01T00:00:00Z") / 1000)).toBe(
      10,
    );
    expect(secondsUntil("2026-01-01T00:00:00Z", Date.parse("2026-01-01T00:00:10Z") / 1000)).toBe(
      -10,
    );
  });

  it("an unparseable instant is null (rendered as unknown), never NaN or 0", () => {
    expect(secondsUntil("not-a-time", 0)).toBeNull();
  });
});

describe("votes exist only while SUBMITTED (§x/group 2)", () => {
  it("the closed fixture row carries no votes, by shape", () => {
    const closed = mockGovProposals.rows.find(
      (r) => r.proposal.status === "PROPOSAL_STATUS_ACCEPTED",
    );
    expect(closed).toBeDefined();
    expect(closed?.votes).toBeNull();
    expect(closed?.liveTally).toBeNull();
  });
});
