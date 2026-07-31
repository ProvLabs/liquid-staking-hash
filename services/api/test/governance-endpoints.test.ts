// The governance endpoints' own gate (App).
//
// The registry-driven harnesses already cover these routes for the envelope
// shape, GET-only/405, query bounds, rate limits and credential-free access — a
// route added to `routes.ts` inherits all of that. What they cannot cover is what
// the payloads MEAN, and specifically the four honesty properties this PR's §4
// invariants name:
//
//   inv. 5  — the list never implies completeness it lacks (`indexed_from_height`)
//   inv. 4  — a pruned proposal is served as pruned, with no verify affordance
//   inv. 7  — every input bounded at entry, rejected not clamped
//   inv. 6  — nothing here is address-scoped
//
// Plus the two C2 truncation flags, which are the difference between "trimmed and
// said so" and "quietly misstated what is being voted on".

import { describe, expect, it } from "vitest";
import { startServer } from "./helpers.ts";
import { fakeReader, type FakeFacts } from "./reader-fake.ts";
import type { GovProposalFacts, GovVoteFacts } from "../src/derive.ts";
import {
  MAX_GOV_PROPOSAL_MESSAGES,
  MAX_GOV_PROPOSERS,
  MAX_GOV_VOTES_PER_PROPOSAL,
  type GovPolicyRow,
  type GovProposalDetail,
  type GovProposalsPayload,
} from "@nvhash/api-types";

const POLICY_A = "tp1afk9zr2hn2jsac63h4hm60vl9z3e5u69gndzf7c99cqge3vzwjzserjkkf";
const POLICY_B = "tp1dlszg2sst9r69my4f84l3mj66zxcf3umcgujys30t84srg95dgvst74vwc";

const THRESHOLD_POLICY = {
  "@type": "/cosmos.group.v1.ThresholdDecisionPolicy",
  threshold: "2",
  windows: { voting_period: "300s", min_execution_period: "0s" },
};

function proposal(over: Partial<GovProposalFacts> & { proposalId: bigint }): GovProposalFacts {
  return {
    groupPolicyAddress: POLICY_A,
    groupId: 1n,
    proposers: ["tp1proposer"],
    status: "SUBMITTED",
    executorResult: "NOT_RUN",
    metadata: null,
    title: `proposal ${over.proposalId}`,
    summary: "a summary",
    messages: [{ "@type": "/cosmos.bank.v1beta1.MsgSend" }],
    submitTime: new Date("2026-07-29T00:00:00Z"),
    votingPeriodEnd: new Date("2026-07-29T00:05:00Z"),
    yesCount: 0n,
    noCount: 0n,
    abstainCount: 0n,
    noWithVetoCount: 0n,
    groupVersion: 1n,
    groupPolicyVersion: 1n,
    decisionPolicy: THRESHOLD_POLICY,
    observedHeight: 500n,
    observedAt: new Date("2026-07-29T00:06:00Z"),
    height: 480n,
    txhash: "A".repeat(64),
    prunedAtHeight: null,
    ...over,
  };
}

function vote(over: Partial<GovVoteFacts> & { proposalId: bigint; voter: string }): GovVoteFacts {
  return {
    option: "YES",
    metadata: null,
    weight: 1n,
    submitTime: new Date("2026-07-29T00:01:00Z"),
    height: 490n,
    txhash: "B".repeat(64),
    ...over,
  };
}

const FACTS: FakeFacts = {
  govIndexedFromHeight: 1,
  govProposals: [
    proposal({
      proposalId: 1n,
      status: "ACCEPTED",
      executorResult: "SUCCESS",
      prunedAtHeight: 496n,
      yesCount: 2n,
      abstainCount: 1n,
    }),
    proposal({ proposalId: 2n, status: "ACCEPTED", executorResult: "FAILURE", yesCount: 2n }),
    proposal({ proposalId: 3n, status: "REJECTED", groupPolicyAddress: POLICY_B, noCount: 1n }),
    proposal({ proposalId: 4n, status: "SUBMITTED", groupPolicyAddress: POLICY_B }),
  ],
  govVotes: [
    vote({ proposalId: 2n, voter: "tp1votera" }),
    // The state-recovered case: no provenance, no weight. Both stay null.
    vote({
      proposalId: 2n,
      voter: "tp1voterb",
      option: "ABSTAIN",
      weight: null,
      height: null,
      txhash: null,
    }),
  ],
  govPolicies: [
    {
      address: POLICY_A,
      groupId: 1n,
      proposalCount: 2,
      lastSeenHeight: 500n,
      decisionPolicy: THRESHOLD_POLICY,
    },
    {
      address: POLICY_B,
      groupId: 1n,
      proposalCount: 2,
      lastSeenHeight: 490n,
      decisionPolicy: null,
    },
  ],
};

async function get(path: string, facts: FakeFacts = FACTS): Promise<{ status: number; body: any }> {
  const server = await startServer({}, undefined, fakeReader(facts));
  try {
    const res = await fetch(`${server.baseUrl}${path}`);
    const body = res.headers.get("content-type")?.includes("json") ? await res.json() : null;
    return { status: res.status, body };
  } finally {
    await server.close();
  }
}

describe("GET /governance/proposals", () => {
  it("serves proposals newest first with the frozen shape", async () => {
    const { status, body } = await get("/api/v1/governance/proposals");
    expect(status).toBe(200);
    const data = body.data as GovProposalsPayload;
    expect(data.proposals.map((p) => p.proposal_id)).toEqual(["4", "3", "2", "1"]);
    const first = data.proposals[0]!;
    // u64 ids are STRINGS on the wire: the JSON number domain stops at 2^53.
    expect(typeof first.proposal_id).toBe("string");
    expect(typeof first.group_id).toBe("string");
    // Unbounded weight sums are decimal strings, never numbers.
    expect(typeof first.tally.yes).toBe("string");
  });

  // Invariant 5. `x/group` prunes, so proposals that closed before the indexer
  // existed are unrecoverable — a list that omitted them silently would imply a
  // completeness it does not have.
  it("carries indexed_from_height so the page never implies completeness it lacks", async () => {
    const { body } = await get("/api/v1/governance/proposals");
    expect((body.data as GovProposalsPayload).indexed_from_height).toBe(1);
  });

  it("reports indexed_from_height as NULL when no height certifies the window", async () => {
    // Null, not 0. A 0 would claim the mirror covers everything from genesis.
    const { body } = await get("/api/v1/governance/proposals", {
      ...FACTS,
      govIndexedFromHeight: null,
    });
    expect((body.data as GovProposalsPayload).indexed_from_height).toBeNull();
  });

  it("serves ACCEPTED + FAILURE — the pair `status` alone cannot express", async () => {
    const { body } = await get("/api/v1/governance/proposals");
    const row = (body.data as GovProposalsPayload).proposals.find((p) => p.proposal_id === "2")!;
    expect(row.status).toBe("accepted");
    expect(row.executor_result).toBe("failure");
  });

  // Invariant 4: the mirror outlives chain state and says so.
  it("marks a pruned proposal as pruned rather than hiding or faking it", async () => {
    const { body } = await get("/api/v1/governance/proposals");
    const pruned = (body.data as GovProposalsPayload).proposals.find((p) => p.proposal_id === "1")!;
    // Present in the list, flagged, with its terminal outcome intact — the row is
    // the durable record precisely because the chain stopped being one. The absent
    // `governance` verify target (D8) is what keeps the UI from offering a link
    // that resolves to nothing.
    expect(pruned.pruned_at_height).toBe(496);
    expect(pruned.status).toBe("accepted");
    expect(pruned.executor_result).toBe("success");
  });

  it("filters by policy", async () => {
    const { body } = await get(`/api/v1/governance/proposals?policy=${POLICY_B}`);
    expect((body.data as GovProposalsPayload).proposals.map((p) => p.proposal_id)).toEqual([
      "4",
      "3",
    ]);
  });

  it("filters by status", async () => {
    const { body } = await get("/api/v1/governance/proposals?status=rejected");
    expect((body.data as GovProposalsPayload).proposals.map((p) => p.proposal_id)).toEqual(["3"]);
  });

  it("serves honest-empty for a well-formed policy that matches nothing", async () => {
    // Shape-bounded, not existence-checked: a real address with no proposals is an
    // empty list, which is a true statement rather than an error.
    const { status, body } = await get(
      "/api/v1/governance/proposals?policy=tp1rxvcuzkn0zk4nwgclw2nf2wcc5pym3fjc7y4s0",
    );
    expect(status).toBe(200);
    expect((body.data as GovProposalsPayload).proposals).toEqual([]);
  });

  // Invariant 7: bounded at entry, REJECTED not clamped.
  it("rejects out-of-range and malformed query params with 400", async () => {
    for (const q of [
      "limit=0",
      "limit=201",
      "limit=abc",
      "limit=1.5",
      "offset=-1",
      "policy=NOTBECH32",
      "policy=../../etc/passwd",
      "status=banana",
    ]) {
      const { status } = await get(`/api/v1/governance/proposals?${q}`);
      expect(status, q).toBe(400);
    }
  });
});

describe("GET /governance/proposal", () => {
  it("returns the proposal with its votes", async () => {
    const { status, body } = await get("/api/v1/governance/proposal?id=2");
    expect(status).toBe(200);
    const detail = body.data as GovProposalDetail;
    expect(detail.proposal.proposal_id).toBe("2");
    expect(detail.votes.map((v) => v.voter)).toEqual(["tp1votera", "tp1voterb"]);
    expect(detail.votes_truncated).toBe(false);
  });

  it("keeps a state-recovered vote's null weight and null provenance null", async () => {
    const { body } = await get("/api/v1/governance/proposal?id=2");
    const recovered = (body.data as GovProposalDetail).votes.find((v) => v.voter === "tp1voterb")!;
    // x/group's Vote payload has no weight field, and the module deletes votes at
    // the tally — so "not recoverable" is a real, common state. A 0 here would
    // assert this member's vote counted for nothing.
    expect(recovered.weight).toBeNull();
    expect(recovered.height).toBeNull();
    expect(recovered.txhash).toBeNull();
  });

  it("404s for an id the mirror has never seen", async () => {
    // Not an empty 200: "we hold no record of this id" and "it exists and is
    // blank" are different answers, and conflating them would render a mistyped
    // id as a real, empty proposal.
    const { status } = await get("/api/v1/governance/proposal?id=999");
    expect(status).toBe(404);
  });

  it("rejects a missing or malformed id with 400, never a coerced number", async () => {
    for (const q of ["", "id=", "id=abc", "id=-1", "id=1.5", "id=01", `id=${"9".repeat(21)}`]) {
      const { status } = await get(`/api/v1/governance/proposal?${q}`);
      expect(status, q).toBe(400);
    }
  });

  it("accepts a u64 id far beyond the JS safe-integer range", async () => {
    // The reason `id` is a string schema: 2^60 is a legal proposal id and would be
    // silently corrupted by `z.coerce.number()`.
    const big = (2n ** 60n).toString();
    const { status } = await get(`/api/v1/governance/proposal?id=${big}`);
    // 404 (the mirror has no such row) proves it PARSED — a 400 would mean the
    // bound rejected a legitimate id.
    expect(status).toBe(404);
  });

  // C2, producer side. The wire bound is imported by both tiers and the pairing is
  // asserted in packages/api-types/test/bounds.test.ts.
  it("trims an over-limit vote list and FLAGS it", async () => {
    const many = Array.from({ length: MAX_GOV_VOTES_PER_PROPOSAL + 5 }, (_, i) =>
      vote({ proposalId: 2n, voter: `tp1voter${String(i).padStart(4, "0")}` }),
    );
    const { body } = await get("/api/v1/governance/proposal?id=2", { ...FACTS, govVotes: many });
    const detail = body.data as GovProposalDetail;
    expect(detail.votes).toHaveLength(MAX_GOV_VOTES_PER_PROPOSAL);
    // Flagged, never silently short: the vote list is NOT page-controlled by the
    // caller, so a quiet trim would understate participation with no signal.
    expect(detail.votes_truncated).toBe(true);
  });

  it("trims an over-limit message list and FLAGS it", async () => {
    const messages = Array.from({ length: MAX_GOV_PROPOSAL_MESSAGES + 3 }, (_, i) => ({
      "@type": "/cosmos.bank.v1beta1.MsgSend",
      n: i,
    }));
    const { body } = await get("/api/v1/governance/proposal?id=2", {
      ...FACTS,
      govProposals: [proposal({ proposalId: 2n, messages })],
    });
    const detail = body.data as GovProposalDetail;
    expect(detail.proposal.messages).toHaveLength(MAX_GOV_PROPOSAL_MESSAGES);
    // A governance payload that quietly lost a message would misstate what is
    // being voted on — the one truncation that must never be silent.
    expect(detail.proposal.messages_truncated).toBe(true);
  });

  it("FLAGS a truncated proposer list", async () => {
    const many = Array.from({ length: 40 }, (_, i) => `tp1proposer${String(i).padStart(3, "0")}`);
    const { body } = await get("/api/v1/governance/proposal?id=2", {
      ...FACTS,
      govProposals: [proposal({ proposalId: 2n, proposers: many })],
    });
    const row = (body.data as GovProposalDetail).proposal;
    expect(row.proposers).toHaveLength(MAX_GOV_PROPOSERS);
    // Without the flag a 40-proposer proposal is indistinguishable from a
    // 32-proposer one, and WHO proposed something is identity data.
    expect(row.proposers_truncated).toBe(true);
  });

  it("does not flag a proposer list that fits", async () => {
    const { body } = await get("/api/v1/governance/proposal?id=2");
    expect((body.data as GovProposalDetail).proposal.proposers_truncated).toBe(false);
  });

  it("carries messages VERBATIM when under the bound", async () => {
    const messages = [
      { "@type": "/cosmwasm.wasm.v1.MsgExecuteContract", msg: { set_halted: { halted: false } } },
    ];
    const { body } = await get("/api/v1/governance/proposal?id=2", {
      ...FACTS,
      govProposals: [proposal({ proposalId: 2n, messages })],
    });
    // Undecoded and unnormalized: 7.2 owns the decode, and 7.4's relay guard
    // re-encodes exactly these bytes.
    expect((body.data as GovProposalDetail).proposal.messages).toEqual(messages);
  });
});

describe("GET /governance/policies", () => {
  it("serves the historical policy set with counts and last-seen heights", async () => {
    const { status, body } = await get("/api/v1/governance/policies");
    expect(status).toBe(200);
    const rows = body.data as GovPolicyRow[];
    // More than one, because the program's policy set is 1..n — the admin/ops
    // split is still open and nothing may assume a single policy.
    expect(rows).toHaveLength(2);
    expect(rows[0]!.address).toBe(POLICY_A);
    expect(rows[0]!.proposal_count).toBe(2);
    expect(rows[0]!.last_seen_height).toBe(500);
  });

  it("decodes a threshold policy and tags an absent one as null", async () => {
    const { body } = await get("/api/v1/governance/policies");
    const rows = body.data as GovPolicyRow[];
    expect(rows[0]!.decision_policy).toEqual({
      kind: "threshold",
      threshold: "2",
      voting_period: "300s",
      min_execution_period: "0s",
    });
    // Null rather than a guessed rule: a policy whose snapshot is missing must not
    // be scored against an invented threshold.
    expect(rows[1]!.decision_policy).toBeNull();
  });

  it("tags an unrecognized policy type instead of guessing its rule", async () => {
    const { body } = await get("/api/v1/governance/policies", {
      ...FACTS,
      govPolicies: [
        {
          address: POLICY_A,
          groupId: 1n,
          proposalCount: 1,
          lastSeenHeight: 10n,
          decisionPolicy: { "@type": "/cosmos.group.v1.FutureDecisionPolicy", magic: 7 },
        },
      ],
    });
    expect((body.data as GovPolicyRow[])[0]!.decision_policy).toEqual({
      kind: "unknown",
      type_url: "/cosmos.group.v1.FutureDecisionPolicy",
    });
  });

  it("serves honest-empty on a dataless reader", async () => {
    const server = await startServer();
    try {
      const res = await fetch(`${server.baseUrl}/api/v1/governance/policies`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        data: unknown;
        meta: { chain_height: number | null; indexed_height: number | null };
      };
      expect(body.data).toEqual([]);
      // Null heights: no indexer height certifies this list yet (§12.1).
      expect(body.meta.chain_height).toBeNull();
      expect(body.meta.indexed_height).toBeNull();
    } finally {
      await server.close();
    }
  });
});

describe("governance is public and address-free (invariant 6)", () => {
  it("needs no credential and ignores an ?address= param entirely", async () => {
    // Proposals and votes are public chain facts with no address keying, so there
    // is nothing to scope. The registry-derived cross-address suite enforces the
    // converse — that no `PERSONAL_PATHS` entry appears for these — automatically.
    const { status, body } = await get(
      "/api/v1/governance/proposals?address=tp1rxvcuzkn0zk4nwgclw2nf2wcc5pym3fjc7y4s0",
    );
    // An unknown param is ignored by the schema, not honored: the payload is the
    // same list every caller sees.
    expect(status).toBe(200);
    expect((body.data as GovProposalsPayload).proposals).toHaveLength(4);
  });
});
