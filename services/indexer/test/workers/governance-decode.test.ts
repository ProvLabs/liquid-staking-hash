// Fixture-decode for the governance worker: every x/group shape it decodes
// matches the captured devnet corpus (packages/fixtures/fixtures/governance/ and
// queries/group/, captured 2026-07-29 by contracts/drills/gov-drill.sh). A module
// shape change breaks THIS test, not production (app-spec §9.2).
//
// The assertions here are chosen to pin the four facts that CONTRADICTED the
// Plan, because those are the ones a future reader is most likely to
// "correct" back to the plan's wording:
//   - EventVote carries no voter/option (they come from the MsgVote body);
//   - a successful exec emits EventProposalPruned in its OWN transaction, with the
//     terminal status and full tally;
//   - a FAILED exec does not prune;
//   - the missing-proposal body is a 500-shaped "not found", not a 404.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { RawEvent } from "../../src/decode/attributes.ts";
import {
  decodeExecEvent,
  decodeMemberWeights,
  decodeProposal,
  decodeProposalPrunedEvent,
  decodeSubmitEvent,
  decodeTally,
  decodeTxVotes,
  decodeVote,
  groupEventIndexes,
  hasGroupEvent,
  isNotFoundBody,
} from "../../src/workers/governance/decode.ts";
import { GROUP_BLOCK_EVENT_TYPES, GROUP_EVENT } from "../../src/workers/governance/events.ts";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const CORPUS = join(REPO, "packages", "fixtures", "fixtures");

function load(rel: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(CORPUS, rel), "utf8")) as Record<string, unknown>;
}
function txEvents(fixture: Record<string, unknown>): RawEvent[] {
  return (fixture["tx_response"] as Record<string, unknown>)["events"] as RawEvent[];
}
function txMessages(fixture: Record<string, unknown>): unknown[] {
  const body = (fixture["tx"] as Record<string, unknown>)["body"] as Record<string, unknown>;
  return body["messages"] as unknown[];
}
function txHeight(fixture: Record<string, unknown>): bigint {
  return BigInt((fixture["tx_response"] as Record<string, unknown>)["height"] as string);
}
function txhashOf(fixture: Record<string, unknown>): string {
  return (fixture["tx_response"] as Record<string, unknown>)["txhash"] as string;
}
function find(events: RawEvent[], type: string): RawEvent {
  const ev = events.find((e) => e.type === type);
  if (!ev) throw new Error(`fixture missing event ${type}`);
  return ev;
}
function proposalOf(rel: string): Record<string, unknown> {
  return load(rel)["proposal"] as Record<string, unknown>;
}

describe("governance decode — tx plane", () => {
  it("decodes submit provenance, keyed per msg_index", () => {
    const fx = load("governance/submit-proposal.json");
    const events = txEvents(fx);
    const fact = decodeSubmitEvent(
      find(events, GROUP_EVENT.submitProposal),
      txhashOf(fx),
      txHeight(fx),
    );
    expect(fact.proposalId).toBeGreaterThan(0n);
    expect(fact.txhash).toBe(txhashOf(fx));
    expect(fact.msgIndex).toBeGreaterThanOrEqual(0);
    // `proposal_id` arrives JSON-quoted (`"2"`) while `msg_index` is bare (`0`) —
    // the mixed shape `dequote` exists to absorb. A decoder that skipped dequote
    // would produce `"2"` here and fail the u64 parse.
    expect(typeof fact.proposalId).toBe("bigint");
  });

  it("reads a vote's voter and option from the MESSAGE BODY, not the event", () => {
    const fx = load("governance/vote.json");
    const events = txEvents(fx);

    // The event genuinely carries neither. Asserted as an ABSENCE so nobody
    // "optimizes" the body fetch away.
    const voteEvent = find(events, GROUP_EVENT.vote);
    const keys = voteEvent.attributes.map((a) => a.key);
    expect(keys).toContain("proposal_id");
    expect(keys).not.toContain("voter");
    expect(keys).not.toContain("option");

    const decoded = decodeTxVotes(events, txMessages(fx), {
      txhash: txhashOf(fx),
      height: txHeight(fx),
      blockTime: new Date("2026-07-29T23:00:00Z"),
    });
    expect(decoded.undecodable).toEqual([]);
    expect(decoded.votes.length).toBeGreaterThan(0);
    const vote = decoded.votes[0]!;
    expect(vote.voter).toMatch(/^tp1/);
    expect(["YES", "NO", "ABSTAIN", "NO_WITH_VETO"]).toContain(vote.option);
    expect(vote.txhash).toBe(txhashOf(fx));
  });

  // The pair-by-msg_index rule under stress: one transaction, two votes, different
  // proposals. Keying discovery by txhash instead of (txhash, msgIndex) would
  // silently drop one of them.
  it("decodes TWO votes from ONE transaction at distinct msg_index values", () => {
    const fx = load("governance/vote-batched.json");
    const events = txEvents(fx);
    expect(groupEventIndexes(events, GROUP_EVENT.vote)).toEqual([0, 1]);

    const decoded = decodeTxVotes(events, txMessages(fx), {
      txhash: txhashOf(fx),
      height: txHeight(fx),
      blockTime: new Date("2026-07-29T23:00:00Z"),
    });
    expect(decoded.undecodable).toEqual([]);
    expect(decoded.votes).toHaveLength(2);
    expect(decoded.votes.map((v) => v.msgIndex)).toEqual([0, 1]);
    // Different proposals, same voter — so a (txhash, voter) key would also lose
    // one. Only the proposal id distinguishes them.
    expect(decoded.votes[0]!.proposalId).not.toBe(decoded.votes[1]!.proposalId);
  });

  it("quarantines a vote whose body is missing, without dropping its siblings", () => {
    const fx = load("governance/vote-batched.json");
    const events = txEvents(fx);
    // Body array truncated to one entry: msg_index 1 has no body to read.
    const decoded = decodeTxVotes(events, [txMessages(fx)[0]], {
      txhash: txhashOf(fx),
      height: txHeight(fx),
      blockTime: new Date("2026-07-29T23:00:00Z"),
    });
    expect(decoded.votes).toHaveLength(1);
    expect(decoded.undecodable).toHaveLength(1);
    expect(decoded.undecodable[0]!.msgIndex).toBe(1);
  });

  it("decodes a SUCCESSFUL exec and the prune it emits in the same transaction", () => {
    const fx = load("governance/exec.json");
    const events = txEvents(fx);

    const exec = decodeExecEvent(find(events, GROUP_EVENT.exec), txHeight(fx));
    expect(exec.result).toBe("SUCCESS");

    // The load-bearing consequence: a successful exec prunes the proposal in its
    // own transaction, so ACCEPTED+SUCCESS is a pair no state read can return —
    // and this event is the only record of the terminal status AND the tally.
    const prune = decodeProposalPrunedEvent(find(events, GROUP_EVENT.proposalPruned), txHeight(fx));
    expect(prune.proposalId).toBe(exec.proposalId);
    expect(prune.status).toBe("ACCEPTED");
    expect(prune.tally).not.toBeNull();
    expect(prune.tally!.yes).toMatch(/^[1-9][0-9]*$/);
  });

  it("decodes a FAILED exec, which does NOT prune", () => {
    const fx = load("governance/exec-failure.json");
    const events = txEvents(fx);
    expect(decodeExecEvent(find(events, GROUP_EVENT.exec), txHeight(fx)).result).toBe("FAILURE");
    // The proposal survives as ACCEPTED+FAILURE, which is why the corpus can pin
    // that pair from a state read while the SUCCESS pair can only come from events.
    expect(events.some((e) => e.type === GROUP_EVENT.proposalPruned)).toBe(false);
  });

  it("recognizes group traffic and ignores everything else", () => {
    expect(hasGroupEvent(txEvents(load("governance/vote.json")))).toBe(true);
    expect(hasGroupEvent([{ type: "transfer", attributes: [] }])).toBe(false);
  });
});

describe("governance decode — block plane", () => {
  // EventProposalPruned is the ONE x/group EndBlocker event on this build; there
  // is no voting-period-end tally event, which is why the state sweep is the only
  // observer of that transition.
  it("decodes an EndBlocker prune from finalize_block_events", () => {
    const fx = load("governance/proposal-pruned-block.json");
    const events = fx["finalize_block_events"] as RawEvent[];
    const pruneEvent = find(events, GROUP_EVENT.proposalPruned);
    const prune = decodeProposalPrunedEvent(pruneEvent, 288n);
    expect(prune.proposalId).toBeGreaterThan(0n);
    expect(["WITHDRAWN", "ABORTED", "REJECTED", "ACCEPTED"]).toContain(prune.status);
  });

  it("pins the observed EndBlocker event set to exactly the prune event", () => {
    // A one-element set, and the worker skips the per-height fetch when it is
    // empty. Recorded as an assertion so a future build's new event type is an
    // explicit, reviewed addition rather than a silent behavior change.
    expect(GROUP_BLOCK_EVENT_TYPES).toEqual([GROUP_EVENT.proposalPruned]);
  });
});

describe("governance decode — state plane", () => {
  const policyContext = { groupId: 1n, decisionPolicy: { "@type": "threshold" } };

  it("decodes ACCEPTED + NOT_RUN, keeping messages verbatim and tallies as strings", () => {
    const raw = proposalOf("queries/group/proposal-accepted-not-run.json");
    const p = decodeProposal(raw, policyContext);
    expect(p.status).toBe("ACCEPTED");
    expect(p.executorResult).toBe("NOT_RUN");
    // Verbatim: 7.4's guard canonically re-encodes these byte-for-byte.
    expect(p.messages).toEqual(raw["messages"]);
    // Unbounded weight sums stay strings — a JS number would corrupt past 2^53.
    expect(typeof p.tally.yes).toBe("string");
    expect(p.tally.yes).toMatch(/^(0|[1-9][0-9]*)$/);
    expect(p.proposers.length).toBeGreaterThan(0);
    expect(p.decisionPolicy).toEqual(policyContext.decisionPolicy);
    expect(p.groupId).toBe(1n);
  });

  it("decodes ACCEPTED + FAILURE and REJECTED", () => {
    expect(decodeProposal(proposalOf("queries/group/proposal-exec-failure.json"), policyContext).executorResult).toBe(
      "FAILURE",
    );
    expect(decodeProposal(proposalOf("queries/group/proposal-rejected.json"), policyContext).status).toBe("REJECTED");
  });

  it("decodes a vote with the weight supplied from the member set", () => {
    // The module's Vote payload has NO weight field, so the caller must resolve
    // it; null is the honest value when it cannot be, never 0.
    const v = decodeVote(
      {
        proposal_id: "8",
        voter: "tp1voter",
        option: "VOTE_OPTION_NO_WITH_VETO",
        metadata: "veto rationale",
        submit_time: "2026-07-29T22:47:17Z",
      },
      "1",
    );
    expect(v.option).toBe("NO_WITH_VETO");
    expect(v.weight).toBe("1");
    expect(decodeVote({ ...{ proposal_id: "8", voter: "tp1v", option: "VOTE_OPTION_YES", submit_time: "2026-07-29T00:00:00Z" } }, null).weight).toBeNull();
  });

  it("decodes member weights through the nested `member` envelope", () => {
    const weights = decodeMemberWeights(load("queries/group/group-members.json")["members"]);
    expect(weights.size).toBeGreaterThan(0);
    for (const [address, weight] of weights) {
      expect(address).toMatch(/^tp1/);
      expect(weight).toMatch(/^(0|[1-9][0-9]*)$/);
    }
  });

  it("returns an EMPTY vote list for a closed proposal, which must never read as 'nobody voted'", () => {
    const fx = load("queries/group/votes-by-proposal-closed.json");
    expect(fx["votes"]).toEqual([]);
    // The module deletes votes at the tally. The writer's COALESCE arms are what
    // stop this empty read from erasing recorded history.
  });

  it("recognizes the missing-proposal body — which is a 500, not a 404", () => {
    const body = JSON.stringify(load("queries/group/proposal-not-found.json"));
    expect(isNotFoundBody(body)).toBe(true);
    // And a genuine transport failure must NOT look like one, or a node outage
    // would be recorded as the chain having discarded a live proposal.
    expect(isNotFoundBody('{"message":"upstream connect error"}')).toBe(false);
  });
});

describe("governance decode — unknown shapes fail honestly, never fatally", () => {
  it("maps an unrecognized status or executor result to UNSPECIFIED", () => {
    const p = decodeProposal(
      {
        id: "1",
        group_policy_address: "tp1policy",
        proposers: ["tp1a"],
        submit_time: "2026-07-29T00:00:00Z",
        voting_period_end: "2026-07-29T00:01:00Z",
        group_version: "1",
        group_policy_version: "1",
        status: "PROPOSAL_STATUS_SOMETHING_NEW",
        executor_result: "PROPOSAL_EXECUTOR_RESULT_WAT",
        messages: [],
      },
      { groupId: 1n, decisionPolicy: null },
    );
    // A chain upgrade that adds an enum member must not stall a worker: an aborted
    // window is re-collected forever and would wedge the whole stream.
    expect(p.status).toBe("UNSPECIFIED");
    expect(p.executorResult).toBe("UNSPECIFIED");
  });

  it("records a prune whose tally is unreadable, rather than losing the prune", () => {
    const prune = decodeProposalPrunedEvent(
      {
        type: GROUP_EVENT.proposalPruned,
        attributes: [
          { key: "proposal_id", value: '"7"' },
          { key: "status", value: '"PROPOSAL_STATUS_WITHDRAWN"' },
          { key: "tally_result", value: "not-json" },
        ],
      },
      99n,
    );
    expect(prune.proposalId).toBe(7n);
    expect(prune.status).toBe("WITHDRAWN");
    expect(prune.tally).toBeNull();
  });

  it("REJECTS a malformed tally on a shape it does claim to understand", () => {
    // The tolerance above is for shapes we do not know. A required field that is
    // present but malformed is a decoder bug or an upgrade, and it throws.
    expect(() =>
      decodeTally({ yes_count: "1.5", no_count: "0", abstain_count: "0", no_with_veto_count: "0" }),
    ).toThrow(/canonical unsigned integer/);
    expect(() =>
      decodeTally({ yes_count: 2, no_count: "0", abstain_count: "0", no_with_veto_count: "0" }),
    ).toThrow();
  });
});
