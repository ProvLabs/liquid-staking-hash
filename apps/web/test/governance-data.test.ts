// Governance-center degradation + honesty matrix — invariants 5, 6, 7,
// 9 and 10, and the plane-precedence table walked cell by cell.
//
// This is the `operator-data.test.ts` idiom applied to governance, and the same
// reason applies twice over: this page is where a member decides how to vote. A
// mirrored tally shown as current, today's members shown as a past electorate,
// or a pruned proposal rendered as live are each a decision made on a false
// premise, and each is one row below.
//
// Chain reads come from the fixture corpus via MSW; API envelopes are built with
// the same `@nvhash/api-types` producer the real service uses.
//
// NOTE on the corpus (R1): its contract admin is a PLAIN ACCOUNT, so
// the default MSW world has no group behind the program and the live plane
// resolves to `not-governed`. The governed world is built explicitly by
// `governedWorld()` below — which is also what makes the two states testably
// different rather than two names for one failure.

import { envelope } from "@nvhash/api-types";
import { http, HttpResponse } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { loadConfig } from "~/config/config.server";
import {
  buildMemberStatus,
  buildProposalSummary,
  loadGovernanceListData,
  loadGovernanceProposalData,
  mergeVotes,
} from "~/governance/governance.server";
import {
  FIXTURE_CHAIN_ID,
  FIXTURE_CONTRACT_ADDRESS,
  FIXTURE_VAULT_ADDRESS,
} from "~/mocks/handlers";
import { server } from "~/mocks/node";

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const config = loadConfig({
  APP_ENV: "development",
  CHAIN_ID: FIXTURE_CHAIN_ID,
  LCD_URL: "http://lcd.mock:1317",
  CONTRACT_ADDRESS: FIXTURE_CONTRACT_ADDRESS,
  VAULT_ADDRESS: FIXTURE_VAULT_ADDRESS,
  CONSOLE_URL: "https://console.example",
  CONSOLE_CHAIN_ID: FIXTURE_CHAIN_ID,
  API_URL: "http://api.mock:8787",
} as NodeJS.ProcessEnv);

const POLICY = "tp1dlszg2sst9r69my4f84l3mj66zxcf3umcgujys30t84srg95dgvst74vwc";
const MEMBER_A = "tp1rxvcuzkn0zk4nwgclw2nf2wcc5pym3fjc7y4s0";
const MEMBER_B = "tp18kkn20p7dphkal2x84t30cv7z6v9rf9cvykjhk";
const NOW = Date.parse("2026-07-30T00:00:00.000Z");

function proposalRow(over: Record<string, unknown> = {}) {
  return {
    proposal_id: "8",
    group_policy_address: POLICY,
    group_id: "1",
    proposers: [MEMBER_B],
    status: "submitted",
    executor_result: "not_run",
    title: "drill-twin-a",
    summary: "drill-twin-a",
    metadata: null,
    tally: { yes: "0", no: "0", abstain: "0", no_with_veto: "0" },
    decision_policy: {
      kind: "threshold",
      threshold: "2",
      voting_period: "40s",
      min_execution_period: "0s",
    },
    submit_time: "2026-07-29T23:31:45.281Z",
    voting_period_end: "2026-07-30T01:00:00.000Z",
    group_version: "2",
    group_policy_version: "1",
    observed_height: 302,
    observed_at: "2026-07-29T23:32:10.000Z",
    height: null,
    txhash: null,
    pruned_at_height: null,
    messages_truncated: false,
    proposers_truncated: false,
    messages: [],
    ...over,
  };
}

/** The API's list endpoint, with the rows a case needs. */
function mirrorList(rows: Record<string, unknown>[], indexedFrom: number | null = 1) {
  return http.get("*/api/v1/governance/proposals", () =>
    HttpResponse.json(
      envelope({ proposals: rows, indexed_from_height: indexedFrom }, { source: "indexed" }),
    ),
  );
}

function mirrorDetail(row: Record<string, unknown>, votes: Record<string, unknown>[] = []) {
  return http.get("*/api/v1/governance/proposal", () =>
    HttpResponse.json(
      envelope({ proposal: row, votes, votes_truncated: false }, { source: "indexed" }),
    ),
  );
}

/**
 * Make the live plane GOVERNED: the contract's admin resolves to a group policy.
 * The corpus cannot do this on its own (its contract predates its group), so the
 * `Config {}` smart query is overridden to name the policy address.
 */
function governedWorld() {
  return [
    http.get("*/cosmwasm/wasm/v1/contract/:address/smart/:query", ({ params }) => {
      const decoded = Buffer.from(String(params["query"]), "base64").toString("utf8");
      const key = Object.keys(JSON.parse(decoded) as Record<string, unknown>)[0];
      if (key !== "config") return HttpResponse.json({ data: {} });
      return HttpResponse.json({
        data: {
          admin: POLICY,
          vault_address: FIXTURE_VAULT_ADDRESS,
          underlying_denom: "nhash",
          receipt_denom: "nvhash.staked",
          max_delegations_per_run: 0,
          aum_fee_bps: 0,
          performance_threshold_bps: 0,
          min_capture_interval_secs: 0,
          max_concentration_multiple_bps: 55000,
          min_bonded_cap_bps: 500,
          max_bonded_cap_bps: 10000,
          concentration_safety_offset_bps: 0,
          commission_bps: 1000,
          jail_unbond_delay_secs: 28800,
        },
      });
    }),
  ];
}

/** Fail every x/group read with a 5xx — a node outage, NOT a missing policy. */
function liveDown() {
  return http.get("*/cosmos/group/v1/*", () =>
    HttpResponse.json({ code: 2, message: "node down", details: [] }, { status: 503 }),
  );
}

describe("live plane: `not-governed` and `unavailable` are different answers (§3.4 R2)", () => {
  it("a plain-account admin reports not-governed, and still renders the mirror", async () => {
    server.use(mirrorList([proposalRow()]));
    const data = await loadGovernanceListData(config, { now: () => NOW });
    expect(data.state).toBe("not-governed");
    // Honest-empty on the LIVE set while the mirror still renders: an unbuilt
    // governance topology must not blank the durable history (D15, invariant 10).
    expect(data.policies.every((p) => !p.live)).toBe(true);
    expect(data.proposals).toHaveLength(1);
    expect(data.indexedAvailable).toBe(true);
  });

  it("a failed chain read reports unavailable — never `not-governed`", async () => {
    // The conservative direction. Claiming "this deployment has no group" from a
    // read failure would state a fact about the DEPLOYMENT from evidence about
    // the REQUEST.
    server.use(
      http.get("*/cosmwasm/wasm/v1/contract/:address/smart/:query", () =>
        HttpResponse.json({ code: 2, message: "node down", details: [] }, { status: 503 }),
      ),
      mirrorList([proposalRow()]),
    );
    const data = await loadGovernanceListData(config, { now: () => NOW });
    expect(data.state).toBe("unavailable");
    expect(data.group).toBeNull();
  });

  it("a governed deployment resolves the whole policy SET, not one policy", async () => {
    // D1: the corpus deliberately carries TWO policies on one group, so a
    // discovery that took "the" policy could not pass this.
    server.use(...governedWorld(), mirrorList([]));
    const data = await loadGovernanceListData(config, { now: () => NOW });
    expect(data.state).toBe("governed");
    expect(data.policies.filter((p) => p.live).length).toBeGreaterThan(1);
    expect(data.group?.memberCount).toBe(3);
    expect(data.group?.totalWeight).toBe("3");
  });
});

describe("plane precedence, cell by cell", () => {
  it("open + live ok → LIVE status and tally, no stale badge", async () => {
    server.use(...governedWorld(), mirrorList([proposalRow()]));
    const data = await loadGovernanceListData(config, { now: () => NOW });
    const proposal = data.proposals[0]!;
    expect(proposal.plane).toBe("live");
    expect(proposal.observedHeight).toBeNull();
  });

  it("open + live DOWN → the mirror, badged with the height it was observed at", async () => {
    // The stale-registry hazard in this page's shape: the danger is not an empty
    // value, it is a successful-looking one.
    server.use(
      ...governedWorld(),
      liveDown(),
      mirrorList([proposalRow({ tally: { yes: "1", no: "0", abstain: "0", no_with_veto: "0" } })]),
    );
    const data = await loadGovernanceListData(config, { now: () => NOW });
    const proposal = data.proposals[0]!;
    expect(proposal.plane).toBe("indexed-fallback");
    expect(proposal.observedHeight).toBe(302);
    // Never blank: the mirrored figure is shown, labeled.
    expect(proposal.tally.yes).toBe("1");
  });

  it("closed → the mirror is CANONICAL even when the chain is readable", async () => {
    // A successful exec prunes in its own transaction, so the happy path leaves
    // nothing on chain — the mirror is the record, not a fallback.
    server.use(
      ...governedWorld(),
      mirrorList([
        proposalRow({
          proposal_id: "4",
          status: "accepted",
          tally: { yes: "2", no: "0", abstain: "0", no_with_veto: "0" },
        }),
      ]),
    );
    const data = await loadGovernanceListData(config, { now: () => NOW });
    expect(data.proposals[0]!.plane).toBe("indexed");
    expect(data.proposals[0]!.tally.yes).toBe("2");
  });

  it("pruned → labeled, and never live-read", async () => {
    server.use(
      ...governedWorld(),
      mirrorList([proposalRow({ proposal_id: "7", status: "withdrawn", pruned_at_height: 288 })]),
    );
    const data = await loadGovernanceListData(config, { now: () => NOW });
    expect(data.proposals[0]!.plane).toBe("pruned");
    expect(data.proposals[0]!.pruned).toBe(true);
  });

  it("both planes down → the tally is n/a, never 0 and never blank", () => {
    const vm = buildProposalSummary({
      indexed: null,
      live: {
        id: 11n,
        groupPolicyAddress: POLICY,
        metadata: "",
        proposers: [MEMBER_B],
        submitTime: "2026-07-30T00:00:00.000Z",
        groupVersion: 2n,
        groupPolicyVersion: 1n,
        status: "SUBMITTED",
        finalTallyResult: { yesCount: "0", abstainCount: "0", noCount: "0", noWithVetoCount: "0" },
        votingPeriodEnd: "2026-07-30T01:00:00.000Z",
        executorResult: "NOT_RUN",
        messages: [],
        title: "fresh",
        summary: "",
      },
      liveTally: null,
      totalWeight: "3",
      currentGroupVersion: "2",
      nowMs: NOW,
    });
    expect(vm.plane).toBe("live-only");
    // The load-bearing assertion: `final_tally_result` is ZEROS until the module
    // tallies, so standing it in would assert "nobody has voted" about a
    // proposal that may have votes.
    expect(vm.tally.yes).toBeNull();
    expect(vm.tally.meets).toBeNull();
  });

  it("a mirrored row whose live read fails is NOT concluded to be pruned", async () => {
    // The LCD answers 500 for a pruned id, a never-existing id and an outage
    // alike, so a live failure carries no prune information at all.
    server.use(...governedWorld(), liveDown(), mirrorList([proposalRow()]));
    const data = await loadGovernanceListData(config, { now: () => NOW });
    expect(data.proposals[0]!.pruned).toBe(false);
    expect(data.proposals[0]!.plane).toBe("indexed-fallback");
  });
});

describe("membership drift is stated, not papered over (invariant 6)", () => {
  it("a proposal at an older group version shows recorded votes only", () => {
    const status = buildMemberStatus({
      members: [
        { address: MEMBER_A, weight: "1", metadata: "" },
        { address: MEMBER_B, weight: "1", metadata: "" },
      ],
      votes: [],
      proposalGroupVersion: "1",
      currentGroupVersion: "2",
      sessionAddress: null,
    });
    expect(status.kind).toBe("membership-changed");
    if (status.kind !== "membership-changed") throw new Error("unreachable");
    expect(status.proposalGroupVersion).toBe("1");
    expect(status.currentGroupVersion).toBe("2");
  });

  it("a matching group version renders the member set with who has not voted", () => {
    const status = buildMemberStatus({
      members: [
        { address: MEMBER_A, weight: "1", metadata: "" },
        { address: MEMBER_B, weight: "2", metadata: "" },
      ],
      votes: [
        {
          voter: MEMBER_A,
          option: "yes",
          weight: "1",
          submitTime: "2026-07-29T23:31:50.000Z",
          height: 300,
          txhash: "AA",
          liveOnly: false,
        },
      ],
      proposalGroupVersion: "2",
      currentGroupVersion: "2",
      sessionAddress: null,
    });
    expect(status.kind).toBe("members");
    if (status.kind !== "members") throw new Error("unreachable");
    expect(status.rows.map((r) => r.vote?.option ?? null)).toEqual(["yes", null]);
  });

  it("a failed member read is `not-checked`, not an empty member table", () => {
    // An empty table would read as "this group has no members", which is a
    // different and much stronger claim than "we could not list them".
    expect(
      buildMemberStatus({
        members: null,
        votes: [],
        proposalGroupVersion: "2",
        currentGroupVersion: "2",
        sessionAddress: null,
      }).kind,
    ).toBe("not-checked");
    expect(
      buildMemberStatus({
        members: [],
        votes: [],
        proposalGroupVersion: "2",
        currentGroupVersion: null,
        sessionAddress: null,
      }).kind,
    ).toBe("not-checked");
  });
});

describe("votes: the live read only ever ADDS (§3.4 R6)", () => {
  const recorded = [
    {
      proposal_id: "8",
      voter: MEMBER_A,
      option: "yes" as const,
      metadata: null,
      weight: null,
      submit_time: "2026-07-29T23:31:50.000Z",
      height: 300,
      txhash: "AA",
    },
  ];

  it("an EMPTY live read never blanks recorded votes", () => {
    // x/group deletes votes at the tally, so a closed proposal answers 200 with
    // an empty list — the single most destructive thing a merge could act on.
    const merged = mergeVotes(recorded, [], null);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.voter).toBe(MEMBER_A);
  });

  it("a live vote the mirror has not caught up to is added and LABELED", () => {
    const merged = mergeVotes(
      recorded,
      [
        {
          proposalId: 8n,
          voter: MEMBER_B,
          option: "NO",
          metadata: "",
          submitTime: "2026-07-29T23:31:55.000Z",
        },
      ],
      [{ address: MEMBER_B, weight: "2", metadata: "" }],
    );
    expect(merged).toHaveLength(2);
    const live = merged.find((v) => v.voter === MEMBER_B)!;
    expect(live.liveOnly).toBe(true);
    expect(live.option).toBe("no");
    // Weight resolved from the live member set; provenance stays null because
    // the mirror has none yet — a fabricated height would be worse than none.
    expect(live.weight).toBe("2");
    expect(live.height).toBeNull();
  });

  it("an unrecoverable weight stays NULL — never 0", () => {
    const merged = mergeVotes(recorded, null, null);
    expect(merged[0]!.weight).toBeNull();
  });
});

describe("cardinality the chain permits, not the shapes the drill happened to walk", () => {
  it("several proposers, several messages, and both truncation flags render", async () => {
    server.use(
      mirrorList([
        proposalRow({
          proposers: [MEMBER_A, MEMBER_B],
          proposers_truncated: true,
          messages_truncated: true,
          messages: [{ "@type": "/cosmos.bank.v1beta1.MsgSend" }, { "@type": "/x.Other" }],
        }),
      ]),
    );
    const data = await loadGovernanceListData(config, { now: () => NOW });
    const proposal = data.proposals[0]!;
    expect(proposal.proposers).toHaveLength(2);
    expect(proposal.proposersTruncated).toBe(true);
    expect(proposal.messagesTruncated).toBe(true);
    expect(proposal.messageCount).toBe(2);
  });

  it("zero policies and zero proposals render honest-empty, not an error", async () => {
    // D15 / invariant 10: the nav must never 404, and hiding the page is a
    // different lie than showing an empty one.
    server.use(
      mirrorList([], null),
      http.get("*/api/v1/governance/policies", () =>
        HttpResponse.json(envelope([], { source: "indexed" })),
      ),
    );
    const data = await loadGovernanceListData(config, { now: () => NOW });
    expect(data.policies).toEqual([]);
    expect(data.proposals).toEqual([]);
    expect(data.indexedAvailable).toBe(true);
    expect(data.indexedFromHeight).toBeNull();
  });

  it("a failed mirror read is distinguishable from an empty one", async () => {
    server.use(
      http.get("*/api/v1/governance/proposals", () =>
        HttpResponse.json({ error: "boom" }, { status: 500 }),
      ),
    );
    const data = await loadGovernanceListData(config, { now: () => NOW });
    expect(data.indexedAvailable).toBe(false);
    expect(data.proposals).toEqual([]);
  });

  it("ABORTED renders, though the drilled build could not reach it", async () => {
    // Recorded by 7.1: a mid-vote group change did NOT abort an open proposal on
    // this build, so this status is renderable but unexercised by real data. It
    // is in the module's proto, so the page must not fall over on it.
    server.use(mirrorList([proposalRow({ status: "aborted" })]));
    const data = await loadGovernanceListData(config, { now: () => NOW });
    expect(data.proposals[0]!.status).toBe("aborted");
    expect(data.proposals[0]!.plane).toBe("indexed");
  });

  it("an unrecognized status from a later chain build still renders", async () => {
    server.use(mirrorList([proposalRow({ status: "unspecified" })]));
    const data = await loadGovernanceListData(config, { now: () => NOW });
    expect(data.proposals[0]!.status).toBe("unspecified");
  });
});

describe("the detail route (invariants 5, 7, 9)", () => {
  it("an id neither plane holds is null → the route's 404", async () => {
    server.use(
      http.get("*/api/v1/governance/proposal", () =>
        HttpResponse.json({ error: "not_found" }, { status: 404 }),
      ),
    );
    expect(await loadGovernanceProposalData(config, "999", { now: () => NOW })).toBeNull();
  });

  it("renders fully ANONYMOUSLY — no member row is marked as the session's", async () => {
    // §8.7 is "public read; member write". Session-address highlighting must
    // never become a gate, so the anonymous page is the same page.
    server.use(...governedWorld(), mirrorDetail(proposalRow()));
    const anonymous = await loadGovernanceProposalData(config, "8", { now: () => NOW });
    const connected = await loadGovernanceProposalData(config, "8", {
      sessionAddress: MEMBER_A,
      now: () => NOW,
    });
    expect(anonymous).not.toBeNull();
    expect(anonymous!.proposal.memberStatus.kind).toBe(connected!.proposal.memberStatus.kind);
    if (anonymous!.proposal.memberStatus.kind !== "members") throw new Error("unreachable");
    if (connected!.proposal.memberStatus.kind !== "members") throw new Error("unreachable");
    expect(anonymous!.proposal.memberStatus.rows.some((r) => r.isSession)).toBe(false);
    expect(connected!.proposal.memberStatus.rows.some((r) => r.isSession)).toBe(true);
    // Same rows either way: highlighting decorates, it never filters.
    expect(anonymous!.proposal.memberStatus.rows.length).toBe(
      connected!.proposal.memberStatus.rows.length,
    );
  });

  it("decodes the proposal's messages, and an unknown one says so", async () => {
    server.use(
      ...governedWorld(),
      mirrorDetail(
        proposalRow({
          messages: [
            {
              "@type": "/cosmos.bank.v1beta1.MsgSend",
              from_address: POLICY,
              to_address: MEMBER_A,
              amount: [{ denom: "nhash", amount: "400" }],
            },
            { "@type": "/cosmos.group.v1.MsgUpdateGroupMembers" },
          ],
        }),
      ),
    );
    const data = await loadGovernanceProposalData(config, "8", { now: () => NOW });
    expect(data!.proposal.messages.map((m) => m.kind)).toEqual(["send", "unknown"]);
    // The exact payload rides on both.
    for (const message of data!.proposal.messages) expect(message.json.length).toBeGreaterThan(0);
  });

  it("the decision rule is the proposal's SNAPSHOT, never the live policy", async () => {
    // The live ops-fast policy has threshold 2; this proposal was submitted
    // under a threshold of 3, and scoring it against today's rule would misstate
    // whether it passed.
    server.use(
      ...governedWorld(),
      mirrorDetail(
        proposalRow({
          status: "accepted",
          tally: { yes: "2", no: "0", abstain: "0", no_with_veto: "0" },
          decision_policy: {
            kind: "threshold",
            threshold: "3",
            voting_period: "40s",
            min_execution_period: "0s",
          },
        }),
      ),
    );
    const data = await loadGovernanceProposalData(config, "8", { now: () => NOW });
    expect(data!.proposal.tally.ruleValue).toBe("3");
    expect(data!.proposal.tally.meets).toBe(false);
  });
});
