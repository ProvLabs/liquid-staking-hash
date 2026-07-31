// The collector's contracts: policy-set discovery, pagination to exhaustion under
// a cap, the honest-empty state, and the sweep-success flag that gates prune
// detection. Pure over injected sources — no network, no Postgres.
//
// The cases here are the ones where getting it wrong is SILENT: a truncated sweep
// that looks complete, an empty policy set that looks like "everything was
// pruned", a discovery failure that looks like "there is no governance". Each of
// those would corrupt the mirror in a direction no later read could detect.

import { describe, expect, it } from "vitest";
import type { RawEvent } from "../../src/decode/attributes.ts";
import {
  discoverGovernance,
  paginate,
  MAX_PAGES,
  type PolicySource,
} from "../../src/workers/governance/policies.ts";
import { collectWindow, type GovEventSource } from "../../src/workers/governance/sources.ts";
import { sweepPolicies } from "../../src/workers/governance/state.ts";
import { GROUP_EVENT } from "../../src/workers/governance/events.ts";

const CONTRACT = "tp1contract";
const POLICY_A = "tp1policyaaa";
const POLICY_B = "tp1policybbb";
const ADMIN = "tp1groupadmin";

/** A scripted PolicySource: `routes` maps a path PREFIX to a body (or a thrower). */
function policySource(opts: {
  admin?: string | null;
  routes?: Record<string, unknown | (() => never)>;
}): PolicySource {
  return {
    smartAtHeight: async () => {
      if (opts.admin === null) throw new Error("LCD down");
      return { admin: opts.admin ?? POLICY_A };
    },
    getAtHeight: async (path) => {
      for (const [prefix, body] of Object.entries(opts.routes ?? {})) {
        if (path.startsWith(prefix)) {
          if (typeof body === "function") return (body as () => never)();
          return body;
        }
      }
      throw new Error(`no route for ${path}`);
    },
  };
}

const policyInfo = (address: string, groupId = "1"): Record<string, unknown> => ({
  address,
  group_id: groupId,
  admin: ADMIN,
  metadata: "",
  version: "1",
  decision_policy: {
    "@type": "/cosmos.group.v1.ThresholdDecisionPolicy",
    threshold: "2",
    windows: { voting_period: "300s", min_execution_period: "0s" },
  },
  created_at: "2026-07-29T00:00:00Z",
});

const noPage = { next_key: null, total: "0" };

const fullRoutes = {
  "cosmos/group/v1/group_policy_info/": { info: policyInfo(POLICY_A) },
  "cosmos/group/v1/group_policies_by_group/": {
    group_policies: [policyInfo(POLICY_A), policyInfo(POLICY_B)],
    pagination: noPage,
  },
  "cosmos/group/v1/group_info/": {
    info: {
      id: "1",
      admin: ADMIN,
      metadata: "",
      version: "1",
      total_weight: "3",
      created_at: "2026-07-29T00:00:00Z",
    },
  },
  "cosmos/group/v1/group_policies_by_admin/": { group_policies: [], pagination: noPage },
  "cosmos/group/v1/group_members/": {
    members: [
      {
        group_id: "1",
        member: { address: "tp1a", weight: "1", metadata: "", added_at: "2026-07-29T00:00:00Z" },
      },
      {
        group_id: "1",
        member: { address: "tp1b", weight: "2", metadata: "", added_at: "2026-07-29T00:00:00Z" },
      },
    ],
    pagination: noPage,
  },
};

describe("policy-set discovery (D1: the set, never 'the' policy)", () => {
  it("discovers EVERY policy on the group, not just the contract's admin", () => {
    // A decoder that took the admin policy and stopped would pass a one-policy
    // devnet and silently miss the pending admin/ops split. The corpus and this
    // test both carry two.
    return discoverGovernance(policySource({ routes: fullRoutes }), CONTRACT, 100n).then((got) => {
      expect(got.policies.map((p) => p.address).sort()).toEqual([POLICY_A, POLICY_B].sort());
      expect(got.memberWeights.get("1")?.get("tp1b")).toBe("2");
    });
  });

  it("resolves a plain-account admin to the EMPTY set — the honest no-governance state", async () => {
    const source = policySource({
      admin: "tp1plainaccount",
      routes: {
        // A plain account has no group_policy_info: the LCD errors, and that is
        // information, not a failure.
        "cosmos/group/v1/group_policy_info/": () => {
          throw new Error("not found");
        },
      },
    });
    const got = await discoverGovernance(source, CONTRACT, 100n);
    expect(got.policies).toEqual([]);
  });

  it("THROWS when the contract config cannot be read, instead of reporting empty", async () => {
    // The distinction that matters: "there is nothing to read" (above) yields an
    // empty set; "we could not read" must fail the window. Collapsing the two
    // would make an LCD blip look like a program without governance, and the read
    // surfaces would say so.
    await expect(
      discoverGovernance(policySource({ admin: null }), CONTRACT, 100n),
    ).rejects.toThrow();
  });

  it("unions configured override policies with what discovery finds", async () => {
    // The routes object is ORDERED: the plain-account admin's own lookup must
    // throw (there is no policy behind it) while the override's lookup resolves.
    // `policySource` matches by prefix in insertion order, so the specific entry
    // has to come first — spreading `fullRoutes` after it would shadow nothing,
    // but declaring the generic prefix twice would.
    const { "cosmos/group/v1/group_policy_info/": _generic, ...restRoutes } = fullRoutes;
    const source = policySource({
      admin: "tp1plainaccount",
      routes: {
        [`cosmos/group/v1/group_policy_info/${encodeURIComponent("tp1plainaccount")}`]: () => {
          throw new Error("not found");
        },
        "cosmos/group/v1/group_policy_info/": { info: policyInfo(POLICY_A) },
        ...restRoutes,
      },
    });
    // The override names ONE policy; discovery from its group still finds the
    // second. An override that pinned the set to one entry would defeat D1.
    const got = await discoverGovernance(source, CONTRACT, 100n, [POLICY_A]);
    expect(got.policies.map((p) => p.address).sort()).toEqual([POLICY_A, POLICY_B].sort());
  });
});

describe("pagination follows to exhaustion, and refuses to truncate", () => {
  function pagedSource(pages: number): PolicySource {
    let call = 0;
    return {
      smartAtHeight: async () => ({ admin: POLICY_A }),
      getAtHeight: async () => {
        call += 1;
        return {
          proposals: [{ id: String(call) }],
          pagination: { next_key: call < pages ? `key-${call}` : null, total: String(pages) },
        };
      },
    };
  }

  it("follows next_key across every page", async () => {
    const got = await paginate(pagedSource(3), "path", "proposals", 100n);
    expect(got).toHaveLength(3);
  });

  it("THROWS at the page cap rather than returning a short list", async () => {
    // This is invariant 14, and the reason it throws rather than truncating is
    // specific: the writer treats absence from a successful sweep as evidence of a
    // prune, so a silently short sweep would stamp `prunedAtHeight` on live
    // proposals. Failing the window is recoverable; a false prune is not.
    await expect(paginate(pagedSource(MAX_PAGES + 5), "path", "proposals", 100n)).rejects.toThrow(
      /pagination cap/,
    );
  });
});

describe("the sweep's success flag gates prune detection", () => {
  const policies = [
    { address: POLICY_A, groupId: 1n, decisionPolicy: null },
    { address: POLICY_B, groupId: 1n, decisionPolicy: null },
  ];

  const proposal = (id: string, status = "PROPOSAL_STATUS_SUBMITTED"): Record<string, unknown> => ({
    id,
    group_policy_address: POLICY_A,
    proposers: ["tp1a"],
    submit_time: "2026-07-29T00:00:00Z",
    voting_period_end: "2026-07-29T00:05:00Z",
    group_version: "1",
    group_policy_version: "1",
    status,
    executor_result: "PROPOSAL_EXECUTOR_RESULT_NOT_RUN",
    final_tally_result: {
      yes_count: "0",
      no_count: "0",
      abstain_count: "0",
      no_with_veto_count: "0",
    },
    messages: [],
  });

  it("reports sweepOk when every policy read succeeds", async () => {
    const source: PolicySource = {
      smartAtHeight: async () => ({ admin: POLICY_A }),
      getAtHeight: async (path) =>
        path.includes("votes_by_proposal")
          ? { votes: [], pagination: noPage }
          : { proposals: [proposal("1")], pagination: noPage },
    };
    const got = await sweepPolicies(source, policies, new Map(), 100n);
    expect(got.sweepOk).toBe(true);
    expect(got.sweptPolicies).toHaveLength(2);
    expect(got.proposals).toHaveLength(2);
  });

  it("CLEARS sweepOk when any one policy read fails", async () => {
    const source: PolicySource = {
      smartAtHeight: async () => ({ admin: POLICY_A }),
      getAtHeight: async (path) => {
        if (path.includes(POLICY_B)) throw new Error("LCD down");
        if (path.includes("votes_by_proposal")) return { votes: [], pagination: noPage };
        return { proposals: [proposal("1")], pagination: noPage };
      },
    };
    const got = await sweepPolicies(source, policies, new Map(), 100n);
    // A partial sweep is not a weaker prune signal — it is no prune signal at all.
    expect(got.sweepOk).toBe(false);
    expect(got.sweptPolicies).toEqual([POLICY_A]);
    // The proposals it DID read are still committed: they are true facts, stamped
    // with their observation height.
    expect(got.proposals).toHaveLength(1);
  });

  it("reads votes only for OPEN proposals", async () => {
    const voteReads: string[] = [];
    const source: PolicySource = {
      smartAtHeight: async () => ({ admin: POLICY_A }),
      getAtHeight: async (path) => {
        if (path.includes("votes_by_proposal")) {
          voteReads.push(path);
          return { votes: [], pagination: noPage };
        }
        return {
          proposals: [proposal("1"), proposal("2", "PROPOSAL_STATUS_REJECTED")],
          pagination: noPage,
        };
      },
    };
    await sweepPolicies(source, [policies[0]!], new Map(), 100n);
    // A closed proposal's votes are already deleted on chain, so reading them
    // would spend a round-trip to learn nothing and risk overwriting real history.
    expect(voteReads).toHaveLength(1);
    expect(voteReads[0]).toContain("/1");
  });

  it("keeps a decodable proposal when a sibling is undecodable, without clearing sweepOk", async () => {
    const source: PolicySource = {
      smartAtHeight: async () => ({ admin: POLICY_A }),
      getAtHeight: async (path) =>
        path.includes("votes_by_proposal")
          ? { votes: [], pagination: noPage }
          : { proposals: [proposal("1"), { id: "nonsense" }], pagination: noPage },
    };
    const got = await sweepPolicies(source, [policies[0]!], new Map(), 100n);
    expect(got.proposals).toHaveLength(1);
    // We DID read the chain successfully, so the undecodable id is present, not
    // pruned — clearing the flag here would suspend prune detection for no reason.
    expect(got.sweepOk).toBe(true);
  });
});

describe("collectWindow", () => {
  const ev = (type: string, attrs: Record<string, string>): RawEvent => ({
    type,
    attributes: Object.entries(attrs).map(([key, value]) => ({ key, value })),
  });

  function eventSource(
    txs: { hash: string; height: bigint; events: RawEvent[] }[],
    messages: unknown[] = [],
  ): GovEventSource {
    return {
      txSearch: async () => ({ totalCount: txs.length, txs }),
      blockResults: async () => ({ finalizeBlockEvents: [] }),
      blockTime: async () => new Date("2026-07-29T23:00:00Z"),
      txMessages: async () => messages,
    };
  }

  it("returns an empty batch with sweepOk FALSE when there is no governance", async () => {
    // The critical property: no policies means nothing was enumerated, so nothing
    // may be concluded absent. A `sweepOk: true` here would make an ungoverned
    // chain stamp every stored proposal pruned.
    const source = policySource({
      admin: "tp1plainaccount",
      routes: {
        "cosmos/group/v1/group_policy_info/": () => {
          throw new Error("not found");
        },
      },
    });
    const batch = await collectWindow(eventSource([]), source, CONTRACT, { from: 1n, to: 10n });
    expect(batch.policies).toEqual([]);
    expect(batch.proposals).toEqual([]);
    expect(batch.sweepOk).toBe(false);
    expect(batch.observedHeight).toBe(10n);
  });

  // P1: the collector must RECOVER a proposal whose whole lifecycle fell
  // inside one window, or the writer has no row to apply its events to. The
  // Specified this read; it was dropped in implementation when the
  // 404-means-pruned semantics were corrected.
  it("recovers a proposal absent from the sweep by a pinned read at a live height", async () => {
    const pinned: { path: string; height: bigint }[] = [];
    const source: PolicySource = {
      smartAtHeight: async () => ({ admin: POLICY_A }),
      getAtHeight: async (path, _params, height) => {
        if (path.startsWith("cosmos/group/v1/proposal/")) {
          pinned.push({ path, height });
          return {
            proposal: {
              id: "9",
              group_policy_address: POLICY_A,
              proposers: ["tp1a"],
              submit_time: "2026-07-29T00:00:00Z",
              voting_period_end: "2026-07-29T00:05:00Z",
              group_version: "1",
              group_policy_version: "1",
              status: "PROPOSAL_STATUS_SUBMITTED",
              executor_result: "PROPOSAL_EXECUTOR_RESULT_NOT_RUN",
              final_tally_result: {
                yes_count: "0",
                no_count: "0",
                abstain_count: "0",
                no_with_veto_count: "0",
              },
              messages: [],
            },
          };
        }
        if (path.includes("proposals_by_group_policy"))
          return { proposals: [], pagination: noPage };
        for (const [prefix, body] of Object.entries(fullRoutes)) {
          if (path.startsWith(prefix)) return body;
        }
        throw new Error(`no route for ${path}`);
      },
    };

    const batch = await collectWindow(
      eventSource([
        // Submitted at 100, executed and pruned at 120 — the normal shape, since a
        // proposal must be voted on before it can execute.
        {
          hash: "AABB",
          height: 100n,
          events: [ev(GROUP_EVENT.submitProposal, { proposal_id: '"9"', msg_index: "0" })],
        },
        {
          hash: "CCDD",
          height: 120n,
          events: [
            ev(GROUP_EVENT.exec, {
              proposal_id: '"9"',
              result: '"PROPOSAL_EXECUTOR_RESULT_SUCCESS"',
              msg_index: "0",
            }),
            ev(GROUP_EVENT.proposalPruned, {
              proposal_id: '"9"',
              status: '"PROPOSAL_STATUS_ACCEPTED"',
              msg_index: "0",
            }),
          ],
        },
      ]),
      source,
      CONTRACT,
      { from: 1n, to: 500n },
    );

    expect(batch.proposals).toEqual([]);
    expect(batch.recoveredProposals).toHaveLength(1);
    expect(batch.recoveredProposals[0]!.snapshot.proposalId).toBe(9n);
    // Pinned at the SUBMIT height — a height the proposal demonstrably existed at.
    // Not the window's end, where it is gone, and not the prune height, where the
    // read would fail for the same reason.
    expect(batch.recoveredProposals[0]!.observedHeight).toBe(100n);
    expect(pinned).toHaveLength(1);
  });

  it("pins one block BEFORE an exec/prune when this window saw no submit", async () => {
    // A proposal submitted in an earlier window and pruned in this one: the prune
    // lands in the same block as its transaction, so that block is already too
    // late and the one before it is the last where the proposal was there.
    const heights: bigint[] = [];
    const source: PolicySource = {
      smartAtHeight: async () => ({ admin: POLICY_A }),
      getAtHeight: async (path, _params, height) => {
        if (path.startsWith("cosmos/group/v1/proposal/")) {
          heights.push(height);
          throw new Error("500 not found: load proposal");
        }
        if (path.includes("proposals_by_group_policy"))
          return { proposals: [], pagination: noPage };
        for (const [prefix, body] of Object.entries(fullRoutes)) {
          if (path.startsWith(prefix)) return body;
        }
        throw new Error(`no route for ${path}`);
      },
    };
    await collectWindow(
      eventSource([
        {
          hash: "CCDD",
          height: 300n,
          events: [
            ev(GROUP_EVENT.proposalPruned, {
              proposal_id: '"4"',
              status: '"PROPOSAL_STATUS_REJECTED"',
              msg_index: "0",
            }),
          ],
        },
      ]),
      source,
      CONTRACT,
      { from: 1n, to: 500n },
    );
    expect(heights).toEqual([299n]);
  });

  it("attempts no read when submit and prune land in the SAME block", async () => {
    // Reachable with `MsgSubmitProposal.exec = EXEC_TRY` when the proposers alone
    // meet the threshold. No height has the proposal alive, so a pinned read would
    // 500 for a reason indistinguishable from an outage — better to not ask and say
    // so than to ask, fail, and log a misleading transport error.
    const attempted: bigint[] = [];
    const source: PolicySource = {
      smartAtHeight: async () => ({ admin: POLICY_A }),
      getAtHeight: async (path, _params, height) => {
        if (path.startsWith("cosmos/group/v1/proposal/")) {
          attempted.push(height);
          throw new Error("500 not found: load proposal");
        }
        if (path.includes("proposals_by_group_policy"))
          return { proposals: [], pagination: noPage };
        for (const [prefix, body] of Object.entries(fullRoutes)) {
          if (path.startsWith(prefix)) return body;
        }
        throw new Error(`no route for ${path}`);
      },
    };
    const batch = await collectWindow(
      eventSource([
        {
          hash: "AABB",
          height: 200n,
          events: [
            ev(GROUP_EVENT.submitProposal, { proposal_id: '"12"', msg_index: "0" }),
            ev(GROUP_EVENT.exec, {
              proposal_id: '"12"',
              result: '"PROPOSAL_EXECUTOR_RESULT_SUCCESS"',
              msg_index: "0",
            }),
            ev(GROUP_EVENT.proposalPruned, {
              proposal_id: '"12"',
              status: '"PROPOSAL_STATUS_ACCEPTED"',
              msg_index: "0",
            }),
          ],
        },
      ]),
      source,
      CONTRACT,
      { from: 1n, to: 500n },
    );
    expect(attempted).toEqual([]);
    expect(batch.recoveredProposals).toEqual([]);
  });

  it("recovers NOTHING, and reports it, when the pinned read fails", async () => {
    // A read below a pruning node's retention horizon (app-spec §9.3) is not a
    // prune signal and not information — so it recovers nothing and the writer will
    // decline to store orphan votes for it.
    const source: PolicySource = {
      smartAtHeight: async () => ({ admin: POLICY_A }),
      getAtHeight: async (path) => {
        if (path.startsWith("cosmos/group/v1/proposal/")) throw new Error("LCD down");
        if (path.includes("proposals_by_group_policy"))
          return { proposals: [], pagination: noPage };
        for (const [prefix, body] of Object.entries(fullRoutes)) {
          if (path.startsWith(prefix)) return body;
        }
        throw new Error(`no route for ${path}`);
      },
    };
    const batch = await collectWindow(
      eventSource([
        {
          hash: "EEFF",
          height: 120n,
          events: [ev(GROUP_EVENT.submitProposal, { proposal_id: '"9"', msg_index: "0" })],
        },
      ]),
      source,
      CONTRACT,
      { from: 1n, to: 500n },
    );
    expect(batch.recoveredProposals).toEqual([]);
    // The submit fact survives so the failure is visible downstream rather than
    // erased here.
    expect(batch.submits).toHaveLength(1);
  });

  it("does NOT attempt recovery for a proposal the sweep already returned", async () => {
    const attempted: string[] = [];
    const source: PolicySource = {
      smartAtHeight: async () => ({ admin: POLICY_A }),
      getAtHeight: async (path) => {
        if (path.startsWith("cosmos/group/v1/proposal/")) {
          attempted.push(path);
          throw new Error("should not be called");
        }
        if (path.includes("votes_by_proposal")) return { votes: [], pagination: noPage };
        if (path.includes("proposals_by_group_policy")) {
          return {
            proposals: [
              {
                id: "9",
                group_policy_address: POLICY_A,
                proposers: ["tp1a"],
                submit_time: "2026-07-29T00:00:00Z",
                voting_period_end: "2026-07-29T00:05:00Z",
                group_version: "1",
                group_policy_version: "1",
                status: "PROPOSAL_STATUS_SUBMITTED",
                executor_result: "PROPOSAL_EXECUTOR_RESULT_NOT_RUN",
                final_tally_result: {
                  yes_count: "0",
                  no_count: "0",
                  abstain_count: "0",
                  no_with_veto_count: "0",
                },
                messages: [],
              },
            ],
            pagination: noPage,
          };
        }
        for (const [prefix, body] of Object.entries(fullRoutes)) {
          if (path.startsWith(prefix)) return body;
        }
        throw new Error(`no route for ${path}`);
      },
    };
    const batch = await collectWindow(
      eventSource([
        {
          hash: "AABB",
          height: 120n,
          events: [ev(GROUP_EVENT.submitProposal, { proposal_id: '"9"', msg_index: "0" })],
        },
      ]),
      source,
      CONTRACT,
      { from: 1n, to: 500n },
    );
    // Recovery is a fallback, not a second read on the happy path — one extra
    // pinned read per proposal per window would be a real cost.
    expect(attempted).toEqual([]);
    expect(batch.proposals).toHaveLength(2);
    expect(batch.recoveredProposals).toEqual([]);
  });

  it("collects submit, exec and prune facts from the tx plane", async () => {
    const source = policySource({
      routes: {
        ...fullRoutes,
        "cosmos/group/v1/proposals_by_group_policy/": { proposals: [], pagination: noPage },
      },
    });
    const batch = await collectWindow(
      eventSource([
        {
          hash: "AABB",
          height: 5n,
          events: [
            ev(GROUP_EVENT.submitProposal, { proposal_id: '"9"', msg_index: "0" }),
            ev(GROUP_EVENT.exec, {
              proposal_id: '"9"',
              result: '"PROPOSAL_EXECUTOR_RESULT_SUCCESS"',
              msg_index: "0",
            }),
            ev(GROUP_EVENT.proposalPruned, {
              proposal_id: '"9"',
              status: '"PROPOSAL_STATUS_ACCEPTED"',
              tally_result:
                '{"yes_count":"2","abstain_count":"0","no_count":"0","no_with_veto_count":"0"}',
              msg_index: "0",
            }),
          ],
        },
      ]),
      source,
      CONTRACT,
      { from: 1n, to: 10n },
    );
    expect(batch.submits).toHaveLength(1);
    expect(batch.execResults[0]!.result).toBe("SUCCESS");
    expect(batch.prunes[0]!.status).toBe("ACCEPTED");
    expect(batch.prunes[0]!.tally!.yes).toBe("2");
    // Submitted, executed and pruned inside one window: the proposal is absent
    // from the sweep, so the events are the ONLY record it ever existed.
    expect(batch.proposals).toEqual([]);
  });
});
