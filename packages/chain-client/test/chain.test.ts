import { describe, expect, it } from "vitest";
import {
  GroupClient,
  parseDecisionPolicy,
  parseGroupInfo,
  parseProposal,
  parseTallyResult,
  parseVote,
} from "../src/group.ts";
import { StakingClient } from "../src/staking.ts";
import { LcdClient, LcdError, type FetchLike } from "../src/lcd.ts";
import { expectArray, expectObject } from "../src/amounts.ts";
import { fixture } from "./fixtures.ts";

function lcdServing(body: unknown): LcdClient {
  const fetchImpl: FetchLike = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(body),
  });
  return new LcdClient("http://lcd", { fetchImpl });
}

describe("staking decoders against the devnet corpus", () => {
  it("decodes the validator set (tokens as bigint)", async () => {
    const r = await new StakingClient(lcdServing(fixture("queries/staking/validators.json"))).validators();
    expect(r.validators.length).toBeGreaterThan(0);
    for (const v of r.validators) {
      expect(typeof v.tokens).toBe("bigint");
      expect(v.operatorAddress).toMatch(/^tpvaloper1/);
    }
    // pagination total decodes to the exact value the corpus carries
    const rawTotal = expectObject(expectObject(fixture("queries/staking/validators.json"))["pagination"])["total"];
    expect(r.pagination.total).toBe(BigInt(rawTotal as string));
  });

  it("decodes the contract's program delegations", async () => {
    const r = await new StakingClient(lcdServing(fixture("queries/staking/delegations.json"))).delegations("tp1contract");
    expect(r.delegations.length).toBeGreaterThan(0);
    const d = r.delegations[0]!;
    expect(d.balance.denom).toBe("nhash");
    expect(typeof d.balance.amount).toBe("bigint");
  });
});

describe("group decoders against the devnet corpus", () => {
  // The 2026-07-14 corpus captured an EMPTY groups list, because the devnet had
  // no x/group substrate at all. The
  // 2026-07-29 capture bootstrapped one, so this file now
  // pins real groups. The module was always served; only the devnet was bare.
  it("decodes the groups list and its pagination envelope", async () => {
    const r = await new GroupClient(lcdServing(fixture("queries/group/groups.json"))).groups();
    expect(r.groups.length).toBeGreaterThan(0);
    expect(r.pagination.total).toBe(BigInt(r.groups.length));
    for (const g of r.groups) {
      expect(typeof g.id).toBe("bigint");
      expect(typeof g.version).toBe("bigint");
      // total_weight is a WEIGHT SUM, not a token amount: unbounded, and kept
      // as a canonical string rather than coerced.
      expect(g.totalWeight).toMatch(/^(0|[1-9][0-9]*)$/);
    }
  });

  it("decodes a populated group info", () => {
    const g = parseGroupInfo({
      id: "1",
      admin: "tp1admin",
      metadata: "nvHASH admin group",
      version: "2",
      total_weight: "3",
      created_at: "2026-07-14T00:00:00Z",
    });
    expect(g.id).toBe(1n);
    expect(g.version).toBe(2n);
  });

  it("decodes group members through the nested `member` envelope", async () => {
    const r = await new GroupClient(lcdServing(fixture("queries/group/group-members.json"))).groupMembers(1n);
    expect(r.members.length).toBeGreaterThan(0);
    for (const m of r.members) {
      expect(m.address).toMatch(/^tp1/);
      expect(m.weight).toMatch(/^(0|[1-9][0-9]*)$/);
    }
  });

  it("decodes a policy's decision policy INLINE (no second read)", async () => {
    const info = await new GroupClient(
      lcdServing(fixture("queries/group/group-policy-info.json")),
    ).groupPolicyInfo("tp1policy");
    expect(info.decisionPolicy.kind).toBe("threshold");
    if (info.decisionPolicy.kind !== "threshold") throw new Error("unreachable");
    expect(info.decisionPolicy.threshold).toMatch(/^[1-9][0-9]*$/);
    expect(info.decisionPolicy.votingPeriod).toMatch(/s$/);
    expect(typeof info.groupId).toBe("bigint");
  });

  // Set-valued discovery (/ decision D1): the corpus deliberately
  // carries MORE THAN ONE policy on the group, so a decoder that silently took
  // the first element could not pass this.
  it("decodes the policy SET on a group, not a single policy", async () => {
    const r = await new GroupClient(
      lcdServing(fixture("queries/group/group-policies-by-group.json")),
    ).groupPoliciesByGroup(1n);
    expect(r.policies.length).toBeGreaterThan(1);
    expect(new Set(r.policies.map((p) => p.address)).size).toBe(r.policies.length);
    for (const p of r.policies) expect(p.groupId).toBe(r.policies[0]!.groupId);
  });

  it("decodes policies by admin (the other discovery leg)", async () => {
    const r = await new GroupClient(
      lcdServing(fixture("queries/group/group-policies-by-admin.json")),
    ).groupPoliciesByAdmin("tp1admin");
    expect(r.policies.length).toBeGreaterThan(0);
  });

  it("decodes a proposal, keeping tally counts as strings and messages verbatim", async () => {
    const raw = fixture("queries/group/proposal-accepted-not-run.json") as {
      proposal: Record<string, unknown>;
    };
    const p = parseProposal(raw.proposal);
    expect(p.status).toBe("ACCEPTED");
    // The pair `status` alone cannot express, and the reason executorResult is
    // stored beside it: this proposal PASSED and has not been executed.
    expect(p.executorResult).toBe("NOT_RUN");
    expect(p.finalTallyResult.yesCount).toMatch(/^(0|[1-9][0-9]*)$/);
    expect(typeof p.finalTallyResult.yesCount).toBe("string");
    expect(p.proposers.length).toBeGreaterThan(0);
    // Verbatim: the decoded messages must be REFERENTIALLY the corpus payload,
    // because 7.4's guard re-encodes them byte-for-byte.
    expect(p.messages).toEqual(raw.proposal["messages"]);
    expect(typeof p.groupVersion).toBe("bigint");
    expect(typeof p.groupPolicyVersion).toBe("bigint");
  });

  it("decodes ACCEPTED + FAILURE — a passed proposal whose messages failed", async () => {
    const raw = fixture("queries/group/proposal-exec-failure.json") as {
      proposal: Record<string, unknown>;
    };
    const p = parseProposal(raw.proposal);
    expect(p.status).toBe("ACCEPTED");
    expect(p.executorResult).toBe("FAILURE");
  });

  it("decodes REJECTED at voting-period end", async () => {
    const raw = fixture("queries/group/proposal-rejected.json") as {
      proposal: Record<string, unknown>;
    };
    const p = parseProposal(raw.proposal);
    expect(p.status).toBe("REJECTED");
    expect(p.executorResult).toBe("NOT_RUN");
  });

  // Pagination follow, against a REAL two-page read. A sweep that stops at page
  // one is indistinguishable from a prune and would corrupt the mirror
  // (SECURITY.md: all chain reads paginate).
  it("follows pagination to exhaustion across a real two-page read", async () => {
    const page1 = fixture("queries/group/proposals-page-1.json") as {
      proposals: unknown[];
      pagination: { next_key: string | null };
    };
    const page2 = fixture("queries/group/proposals-page-2.json") as { proposals: unknown[] };
    expect(page1.pagination.next_key).toBeTruthy();

    const pages = [page1, page2];
    let call = 0;
    const fetchImpl: FetchLike = async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(pages[Math.min(call++, pages.length - 1)]),
    });
    const client = new GroupClient(new LcdClient("http://lcd", { fetchImpl }));

    const seen: bigint[] = [];
    let key: string | null = null;
    do {
      const r = await client.proposalsByGroupPolicy(
        "tp1policy",
        key === null ? { "pagination.limit": "2" } : { "pagination.limit": "2", "pagination.key": key },
      );
      seen.push(...r.proposals.map((p) => p.id));
      key = r.pagination.nextKey;
    } while (key !== null && call < pages.length);

    expect(seen.length).toBeGreaterThan(page1.proposals.length);
    expect(new Set(seen.map(String)).size).toBe(seen.length);
  });

  // Votes: a CLOSED proposal answers 200 with an empty list, because the module
  // deletes votes at the tally. An empty read therefore never means "nobody
  // voted", and the mirror must never overwrite recorded votes with it.
  it("decodes an empty vote list for a proposal whose tally is final", async () => {
    const r = await new GroupClient(
      lcdServing(fixture("queries/group/votes-by-proposal-closed.json")),
    ).votesByProposal(17n);
    expect(r.votes).toEqual([]);
    expect(r.pagination.total).toBe(0n);
  });

  it("decodes a vote, which carries NO weight field", () => {
    const v = parseVote({
      proposal_id: "8",
      voter: "tp1voter",
      option: "VOTE_OPTION_NO_WITH_VETO",
      metadata: "veto rationale",
      submit_time: "2026-07-29T22:47:17Z",
    });
    expect(v.proposalId).toBe(8n);
    expect(v.option).toBe("NO_WITH_VETO");
    // Asserted as an ABSENCE on purpose: a weight invented here would be a lie
    // about a tally line, so the type must not have somewhere to put one.
    expect(Object.keys(v)).not.toContain("weight");
  });

  // The live tally read. It exists because a proposal's
  // `final_tally_result` is zeros for the whole voting period — the module writes
  // it only when it tallies — so the state plane cannot say where an OPEN
  // proposal stands, and rendering those zeros would assert "nobody has voted".
  // The corpus predates this read, so BOTH response envelopes are accepted; the
  // tally shape itself is the corpus-pinned `TallyResult`.
  it("reads the module's tally through either response envelope", async () => {
    const counts = {
      yes_count: "2",
      abstain_count: "0",
      no_count: "1",
      no_with_veto_count: "0",
    };
    for (const body of [{ tally: counts }, counts]) {
      const r = await new GroupClient(lcdServing(body)).tallyResult(8n);
      expect(r.yesCount).toBe("2");
      expect(r.noCount).toBe("1");
      // Strings, not numbers: unbounded weight sums (2^53 corrupts silently).
      expect(typeof r.yesCount).toBe("string");
    }
  });

  it("the open proposals in the corpus carry a ZERO final tally", () => {
    // The fact the read above exists for. Every SUBMITTED proposal the drill
    // captured has an all-zero `final_tally_result`; if a later build starts
    // maintaining a running tally in state, this test fails and the live tally
    // read becomes redundant rather than silently duplicated.
    const sweep = fixture("queries/group/proposals-by-group-policy.json") as {
      proposals: Record<string, unknown>[];
    };
    const open = sweep.proposals
      .map((raw) => parseProposal(raw))
      .filter((p) => p.status === "SUBMITTED");
    expect(open.length).toBeGreaterThan(0);
    for (const p of open) {
      expect(p.finalTallyResult).toEqual({
        yesCount: "0",
        abstainCount: "0",
        noCount: "0",
        noWithVetoCount: "0",
      });
    }
  });

  it("tags an unrecognized decision policy instead of throwing", () => {
    // An enum or policy type a later chain upgrade adds must not stall an
    // indexer window mid-sweep (invariant 8). The raw payload is kept so
    // the surface can say what it does not understand.
    const dp = parseDecisionPolicy({ "@type": "/cosmos.group.v1.FutureDecisionPolicy", magic: 7 });
    expect(dp.kind).toBe("unknown");
    if (dp.kind !== "unknown") throw new Error("unreachable");
    expect(dp.typeUrl).toBe("/cosmos.group.v1.FutureDecisionPolicy");
    expect(dp.raw).toEqual({ "@type": "/cosmos.group.v1.FutureDecisionPolicy", magic: 7 });
  });

  it("maps an unknown status or vote option to UNSPECIFIED, never throwing", () => {
    const p = parseProposal({
      id: "1",
      group_policy_address: "tp1policy",
      proposers: ["tp1a"],
      submit_time: "2026-07-29T00:00:00Z",
      group_version: "1",
      group_policy_version: "1",
      status: "PROPOSAL_STATUS_SOMETHING_NEW",
      final_tally_result: { yes_count: "0", abstain_count: "0", no_count: "0", no_with_veto_count: "0" },
      voting_period_end: "2026-07-29T00:01:00Z",
      executor_result: "PROPOSAL_EXECUTOR_RESULT_WAT",
      messages: [],
    });
    expect(p.status).toBe("UNSPECIFIED");
    expect(p.executorResult).toBe("UNSPECIFIED");
  });

  it("rejects a non-canonical tally count rather than coercing it", () => {
    expect(() =>
      parseTallyResult({ yes_count: "1.5", abstain_count: "0", no_count: "0", no_with_veto_count: "0" }),
    ).toThrow(/canonical unsigned integer/);
    expect(() =>
      parseTallyResult({ yes_count: 2, abstain_count: "0", no_count: "0", no_with_veto_count: "0" }),
    ).toThrow();
  });

  // The single most consequential shape in this family, and the one that
  // contradicted the plan: a missing proposal is a 500 whose body is identical
  // for a pruned and a never-existing id. `proposal()` must SURFACE that as an
  // error, so no caller can mistake a read failure for a prune.
  it("surfaces a missing proposal as an error, not as an empty result", async () => {
    const body = fixture("queries/group/proposal-not-found.json");
    const fetchImpl: FetchLike = async () => ({
      ok: false,
      status: 500,
      text: async () => JSON.stringify(body),
    });
    const client = new GroupClient(new LcdClient("http://lcd", { fetchImpl }));
    await expect(client.proposal(999_999_999n)).rejects.toThrow();
    // And the corpus proves the status is NOT 404, so nothing downstream may
    // key prune detection on one.
    expect(JSON.stringify(body)).toContain("not found");
  });
});

describe("LcdClient error surface", () => {
  it("throws LcdError with status and body on non-2xx", async () => {
    const fetchImpl: FetchLike = async () => ({
      ok: false,
      status: 501,
      text: async () => '{"code":12,"message":"Not Implemented"}',
    });
    const lcd = new LcdClient("http://lcd", { fetchImpl });
    await expect(lcd.get("vault/v1/nope")).rejects.toThrow(LcdError);
  });

  it("skips undefined query params and serializes bigint", async () => {
    const urls: string[] = [];
    const fetchImpl: FetchLike = async (url) => {
      urls.push(url);
      return { ok: true, status: 200, text: async () => "{}" };
    };
    const lcd = new LcdClient("http://lcd/", { fetchImpl });
    await lcd.get("x", { shares: 10n, redeem_denom: undefined });
    expect(urls[0]).toBe("http://lcd/x?shares=10");
  });
});

describe("corpus manifest stays provisional until the formal vault release", () => {
  it("manifest carries the provisional marker and the feature-probe result", () => {
    const m = expectObject(fixture("manifest.json"));
    expect(String(m["status"])).toContain("PROVISIONAL");
    const probe = expectObject(m["feature_probe"]);
    expect(probe["name"]).toBe("AcceptAsset");
    expect(probe["result"]).toBe("present");
    expect(expectArray(m["pinned_facts"]).length).toBeGreaterThan(0);
  });
});
