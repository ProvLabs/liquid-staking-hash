// The state × affordance matrix, and the affordance-plane rule. One case per
// ROW, driven table-style rather than written per-branch.
//
// WHY THIS SUITE EXISTS IN THIS SHAPE. The failure it guards — an action panel
// rendered against a state the action cannot validly operate on — is what a
// decision made in JSX produces, because no table can reach it there. So the
// decision lives in `app/governance/actions.ts` as a pure function over a
// closed input, and the table below is the matrix itself rather than a sample
// of it.
//
// THE C5 RULE, stated once and asserted many times: an action is decided from
// the LIVE plane alone. `live: null` means the chain did not confirm the state
// we would be acting on, and every affordance is then hidden WITH the reason —
// never rendered optimistically from a mirrored row.

import { describe, expect, it } from "vitest";

import {
  executableAtIso,
  executeAffordance,
  parseDurationSeconds,
  voteAffordance,
  type AffordanceInput,
  type LiveProposalState,
} from "~/governance/actions";

const MEMBER = "tp1rxvcuzkn0zk4nwgclw2nf2wcc5pym3fjc7y4s0";
const NOW = Date.parse("2026-07-30T12:00:00Z");
const SUBMITTED_AT = "2026-07-29T12:00:00Z";
const OPEN_UNTIL = "2026-07-31T12:00:00Z";

const liveOpen: LiveProposalState = {
  status: "submitted",
  executorResult: "not_run",
  submitTime: SUBMITTED_AT,
  votingPeriodEnd: OPEN_UNTIL,
  groupVersion: "3",
  minExecutionPeriod: "0s",
};
const liveAccepted: LiveProposalState = { ...liveOpen, status: "accepted" };

function input(overrides: Partial<AffordanceInput> = {}): AffordanceInput {
  return {
    live: liveOpen,
    pruned: false,
    membershipChanged: false,
    sessionAddress: MEMBER,
    isMember: true,
    hasVoted: false,
    votedOption: null,
    nowMs: NOW,
    ...overrides,
  };
}

describe("C4 — the vote column, one case per row", () => {
  it("open, not yet voted, session is a member → OFFERED", () => {
    expect(voteAffordance(input())).toEqual({ state: "offered" });
  });

  it("open, already voted → hidden, carrying the recorded option", () => {
    // 7.1 MEASURED that x/group records one vote per member and refuses a
    // change — the plan carried this cell as `[VERIFY]` against the drill, and
    // the drill answered it. Had the chain accepted re-votes, this cell would
    // read "offered, as a change" instead.
    expect(voteAffordance(input({ hasVoted: true, votedOption: "yes" }))).toEqual({
      state: "hidden",
      reason: "already-voted",
      option: "yes",
    });
  });

  it("open, session is NOT a member → hidden, with the reason stated", () => {
    expect(voteAffordance(input({ isMember: false }))).toEqual({
      state: "hidden",
      reason: "not-member",
    });
  });

  it("open, membership could not be READ → hidden, and NOT as 'not a member'", () => {
    // The cell that separates "we could not check" from "you are not a member".
    // Collapsing null to false would tell an actual member they are not one.
    expect(voteAffordance(input({ isMember: null }))).toEqual({
      state: "hidden",
      reason: "membership-unknown",
    });
  });

  it("open, anonymous → hidden with the connect prompt", () => {
    expect(voteAffordance(input({ sessionAddress: null }))).toEqual({
      state: "hidden",
      reason: "anonymous",
    });
  });

  it("open on paper but the voting period has ELAPSED → hidden", () => {
    // "Still submitted" is not "still votable": the module tallies at the
    // EndBlocker, so there is a window where the status has not moved and a
    // vote would be rejected.
    expect(voteAffordance(input({ nowMs: Date.parse("2026-08-01T00:00:00Z") }))).toEqual({
      state: "hidden",
      reason: "voting-ended",
    });
  });

  it("accepted / rejected / aborted / withdrawn → hidden", () => {
    for (const status of ["accepted", "rejected", "aborted", "withdrawn", "unspecified"] as const) {
      expect(voteAffordance(input({ live: { ...liveOpen, status } })), status).toEqual({
        state: "hidden",
        reason: "not-open",
      });
    }
  });

  it("pruned → hidden (no action can reference a proposal the chain discarded)", () => {
    expect(voteAffordance(input({ pruned: true }))).toEqual({ state: "hidden", reason: "pruned" });
  });

  it("groupVersion ≠ current → hidden (today's members were not its electorate)", () => {
    expect(voteAffordance(input({ membershipChanged: true }))).toEqual({
      state: "hidden",
      reason: "membership-changed",
    });
  });

  it("C5 — live read DOWN → hidden with the reason, never offered optimistically", () => {
    expect(voteAffordance(input({ live: null }))).toEqual({
      state: "hidden",
      reason: "live-unavailable",
    });
  });
});

describe("C4 — the execute column, one case per row", () => {
  it("open → hidden (nothing has passed yet)", () => {
    expect(executeAffordance(input())).toEqual({ state: "hidden", reason: "not-passed" });
  });

  it("accepted, min_execution_period PENDING → SHOWN, DISABLED, with the eligible-at time", () => {
    // Disabled-with-reason, never hidden: the user needs to know it is coming.
    const verdict = executeAffordance(
      // 48h from a submit 24h ago.
      input({ live: { ...liveAccepted, minExecutionPeriod: "172800s" } }),
    );
    expect(verdict).toEqual({
      state: "disabled",
      reason: "min-execution-pending",
      readyAtIso: "2026-07-31T12:00:00.000Z",
    });
  });

  it("accepted, executable → OFFERED", () => {
    expect(executeAffordance(input({ live: liveAccepted }))).toEqual({ state: "offered" });
  });

  it("accepted, executable, session is NOT a member → still OFFERED", () => {
    // Execution is PERMISSIONLESS in x/group. Hiding it from non-members would
    // imply a restriction the module does not enforce.
    expect(executeAffordance(input({ live: liveAccepted, isMember: false }))).toEqual({
      state: "offered",
    });
  });

  it("accepted, executable, membership CHANGED → still OFFERED", () => {
    // Execution acts on a decision already taken. Gating it on today's
    // electorate would strand a passed proposal permanently after any
    // membership change.
    expect(executeAffordance(input({ live: liveAccepted, membershipChanged: true }))).toEqual({
      state: "offered",
    });
  });

  it("executed SUCCESS or FAILURE → hidden (FAILURE is terminal)", () => {
    expect(
      executeAffordance(input({ live: { ...liveAccepted, executorResult: "success" } })),
    ).toEqual({ state: "hidden", reason: "already-executed" });
    expect(
      executeAffordance(input({ live: { ...liveAccepted, executorResult: "failure" } })),
    ).toEqual({ state: "hidden", reason: "execution-failed" });
  });

  it("rejected / aborted / withdrawn → hidden", () => {
    for (const status of ["rejected", "aborted", "withdrawn", "unspecified"] as const) {
      expect(executeAffordance(input({ live: { ...liveOpen, status } })), status).toEqual({
        state: "hidden",
        reason: "terminal",
      });
    }
  });

  it("pruned → hidden", () => {
    expect(executeAffordance(input({ pruned: true, live: liveAccepted }))).toEqual({
      state: "hidden",
      reason: "pruned",
    });
  });

  it("anonymous → hidden (a transaction still needs a signer)", () => {
    expect(executeAffordance(input({ sessionAddress: null, live: liveAccepted }))).toEqual({
      state: "hidden",
      reason: "anonymous",
    });
  });

  it("C5 — live read DOWN on an accepted proposal → hidden, never offered", () => {
    // The sharpest C5 cell: a stale "accepted" that has since been executed
    // would offer a button guaranteed to fail. And because x/group PRUNES a
    // successfully executed proposal in its own transaction, a failed live read
    // on an accepted proposal is itself evidence not to offer it.
    expect(executeAffordance(input({ live: null }))).toEqual({
      state: "hidden",
      reason: "live-unavailable",
    });
  });

  it("an UNDETERMINED window → disabled with an unknown time, NEVER offered", () => {
    // THE DEFECT THIS REFUSES. Falling through to `offered` on the reasoning
    // that there is "no window to wait out" is wrong: x/group serializes a
    // Duration for both
    // recognized decision-policy kinds, so a policy with NO waiting period
    // yields `"0s"` — null means only that we could not DETERMINE it (the policy
    // is outside the discovered set, or its rule is a kind this build does not
    // model). Offering execute on it let the user sign into the chain's own
    // "must wait until …" rejection.
    //
    // Reachable, not theoretical: `/governance/:proposalId` accepts any proposal
    // id and the live read is unscoped, so a proposal belonging to ANOTHER
    // group's policy resolves a `liveState` whose policy is absent from this
    // program's discovered set.
    for (const minExecutionPeriod of [null, "P2D", "600", "", "1m"]) {
      expect(
        executeAffordance(input({ live: { ...liveAccepted, minExecutionPeriod } })),
        String(minExecutionPeriod),
      ).toEqual({ state: "disabled", reason: "min-execution-pending", readyAtIso: null });
    }
  });

  it('a ZERO window is still offered — `"0s"` is a value, not an absence', () => {
    // The other half: the fix must not turn a legitimately-executable proposal
    // into a permanently disabled one. A policy with no waiting period says so
    // explicitly, and that is distinguishable from not knowing.
    expect(
      executeAffordance(input({ live: { ...liveAccepted, minExecutionPeriod: "0s" } })),
    ).toEqual({ state: "offered" });
  });

  it("an unparseable SUBMIT TIME is also undetermined → disabled, not offered", () => {
    // The other input to the window. Same rule, same reason.
    expect(
      executeAffordance(
        input({ live: { ...liveAccepted, submitTime: "not-a-date", minExecutionPeriod: "0s" } }),
      ),
    ).toEqual({ state: "disabled", reason: "min-execution-pending", readyAtIso: null });
  });
});

describe("the execution window comes from the LIVE policy", () => {
  // THE DEFECT THIS PINS. Taking `min_execution_period` from the MIRROR'S
  // SNAPSHOT of the decision policy
  // while `runGovernancePreflight` reads the LIVE policy means that after any policy
  // change the button and the check gating it disagreed: a proposal the chain
  // would execute showed as pending, or one it would refuse advanced to
  // simulation.
  //
  // Live is the correct source, structurally: x/group's `Proposal` carries NO
  // decision policy, so at execution time the module can only read the policy
  // account as it stands then. `minExecutionPeriod` therefore lives INSIDE
  // `LiveProposalState`, which makes supplying the snapshot unrepresentable.
  //
  // NOT YET DRILLED — the devnet policy runs `min_execution_period: 0`, so the
  // window never bit and `manifest.json`'s drill observations do not cover it.
  // Recorded as a gap rather than asserted as measured (7.1's lesson: four plan
  // assumptions about x/group were contradicted by the drill).
  const accepted: LiveProposalState = {
    status: "accepted",
    executorResult: "not_run",
    submitTime: SUBMITTED_AT,
    votingPeriodEnd: OPEN_UNTIL,
    groupVersion: "3",
    minExecutionPeriod: "0s",
  };

  it("a policy LENGTHENING its window after submission makes an offered proposal pending", () => {
    expect(executeAffordance(input({ live: accepted }))).toEqual({ state: "offered" });
    // The policy is updated to a 48h window; the same proposal is now pending,
    // which is what the chain will say too.
    expect(
      executeAffordance(input({ live: { ...accepted, minExecutionPeriod: "172800s" } })),
    ).toEqual({
      state: "disabled",
      reason: "min-execution-pending",
      readyAtIso: "2026-07-31T12:00:00.000Z",
    });
  });

  it("a policy SHORTENING its window after submission makes a pending proposal offered", () => {
    expect(
      executeAffordance(input({ live: { ...accepted, minExecutionPeriod: "172800s" } })).state,
    ).toBe("disabled");
    expect(executeAffordance(input({ live: { ...accepted, minExecutionPeriod: "60s" } }))).toEqual({
      state: "offered",
    });
  });

  it("the window is not readable from anywhere but `live`", () => {
    // A type-level property with a runtime witness: the affordance decides from
    // `live` alone, so a caller holding a stale snapshot has no way to inject
    // it. If `AffordanceInput` ever regains a `minExecutionPeriod` field, this
    // spread would silently take effect and the first case above would fail.
    const withStaleSnapshot = {
      ...input({ live: { ...accepted, minExecutionPeriod: "172800s" } }),
      minExecutionPeriod: "0s",
    } as AffordanceInput;
    expect(executeAffordance(withStaleSnapshot).state).toBe("disabled");
  });
});

describe("the execution window is computed from SUBMIT time, not the voting end", () => {
  it("matches x/group's own rule", () => {
    // `keeper.Exec` compares the block time against
    // `proposal.submit_time + min_execution_period`. Using the voting-period end
    // would show a countdown that expires before the chain agrees, and the user
    // would sign into a revert.
    expect(executableAtIso("2026-07-29T12:00:00Z", "86400s")).toBe("2026-07-30T12:00:00.000Z");
    expect(executableAtIso("2026-07-29T12:00:00Z", "0s")).toBe("2026-07-29T12:00:00.000Z");
  });

  it("null propagates rather than collapsing to 'now'", () => {
    // A null that became 0 would claim a proposal is executable immediately.
    expect(executableAtIso("2026-07-29T12:00:00Z", null)).toBeNull();
    expect(executableAtIso("not-a-date", "0s")).toBeNull();
    expect(executableAtIso("2026-07-29T12:00:00Z", "2 days")).toBeNull();
  });

  it("parses the durations x/group serializes, and refuses the rest", () => {
    expect(parseDurationSeconds("0s")).toBe(0);
    expect(parseDurationSeconds("600s")).toBe(600);
    expect(parseDurationSeconds("0.5s")).toBe(0.5);
    for (const bad of [null, "", "600", "PT10M", "-1s", "1m", "abc"]) {
      expect(parseDurationSeconds(bad), String(bad)).toBeNull();
    }
  });
});

describe("no action is offered in any terminal state, under any other input", () => {
  it("sweeps the terminal states against every membership/vote combination", () => {
    // The belt-and-braces sweep the e2e assertion mirrors: whatever else is
    // true of the session, a terminal proposal offers nothing.
    for (const status of ["rejected", "aborted", "withdrawn"] as const) {
      for (const isMember of [true, false, null]) {
        for (const hasVoted of [true, false]) {
          const facts = input({
            live: { ...liveOpen, status },
            isMember,
            hasVoted,
            votedOption: hasVoted ? "yes" : null,
          });
          expect(voteAffordance(facts).state, `${status}/${isMember}/${hasVoted}`).toBe("hidden");
          expect(executeAffordance(facts).state, `${status}/${isMember}/${hasVoted}`).toBe(
            "hidden",
          );
        }
      }
    }
  });
});
