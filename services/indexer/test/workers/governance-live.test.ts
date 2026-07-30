// LIVE devnet check for the governance collector (App PR 7.1 commit B).
//
// Skips cleanly unless `GOV_LIVE_LCD` is set, following the `e2e-live`
// convention: it needs a running devnet with the x/group substrate bootstrapped
// and `contracts/drills/gov-drill.sh` already run, so it belongs to the stack
// schedule rather than the offline CI lane.
//
//   V=$(docker exec dev-node provenanced q vault list -t --home /provenance/nodedev -o json \
//        | jq -r '.vaults[]?|select(.total_shares.denom=="nvhash")|.base_account.address' | head -1)
//   C=$(docker exec dev-node provenanced q vault get "$V" -t --home /provenance/nodedev -o json \
//        | jq -r '.vault.asset_manager')
//   docker compose -f infra/dev/compose.yaml run --rm \
//     -e GOV_LIVE_LCD=http://dev-node:1317 -e GOV_LIVE_RPC=http://dev-node:26657 \
//     -e GOV_LIVE_CONTRACT="$C" \
//     tools corepack pnpm --filter @nvhash/indexer exec vitest run test/workers/governance-live.test.ts
//
// WHY IT EXISTS beyond the fixture and property suites. Those pin decode shapes
// and writer semantics against captured data; neither exercises the real
// transport, the real pagination, or the real interaction between the three
// planes. This does, and on the 2026-07-29 governed devnet it reproduced all six
// drill findings in one pass — most importantly that proposals which executed
// SUCCESSFULLY are absent from chain state while their outcome is still
// recoverable, which is the single claim the mirror's existence rests on.
//
// This test is an ADDITION beyond the M7.1 §3.2 file table, recorded as such.

import { describe, expect, it } from "vitest";
import { PinnedLcdClient, RpcClient } from "../../src/transport/rpc.ts";
import { collectWindow } from "../../src/workers/governance/sources.ts";

const LCD = process.env["GOV_LIVE_LCD"];
const RPC = process.env["GOV_LIVE_RPC"] ?? "http://dev-node:26657";
const CONTRACT = process.env["GOV_LIVE_CONTRACT"];

describe.skipIf(!LCD || !CONTRACT)("governance collector against a live governed devnet", () => {
  it("discovers the policy SET and merges all three planes", async () => {
    const rpc = new RpcClient(RPC);
    const pinned = new PinnedLcdClient(LCD!);
    const head = await rpc.latestHeight();

    const batch = await collectWindow(
      {
        txSearch: (q, p, pp) => rpc.txSearch(q, p, pp),
        blockResults: (h) => rpc.blockResults(h),
        blockTime: (h) => rpc.blockTime(h),
        txMessages: async (txhash) => {
          const res = await fetch(`${LCD}/cosmos/tx/v1beta1/txs/${txhash}`);
          if (!res.ok) throw new Error(`LCD tx fetch failed: ${res.status}`);
          const body = (await res.json()) as { tx?: { body?: { messages?: unknown[] } } };
          return body.tx?.body?.messages ?? [];
        },
      },
      {
        smartAtHeight: (c, q, h) => pinned.smartAtHeight(c, q, h),
        getAtHeight: (p, params, h) => pinned.getAtHeight(p, params, h),
      },
      CONTRACT!,
      { from: 1n, to: head },
    );

    // The substrate bootstraps TWO policies on one group precisely so this cannot
    // pass by taking the first element (decision D1).
    expect(batch.policies.length).toBeGreaterThan(1);
    expect(batch.sweepOk).toBe(true);

    // The tx plane found proposals; the state plane holds only some of them.
    expect(batch.submits.length).toBeGreaterThan(0);
    expect(batch.txVotes.length).toBeGreaterThan(0);

    // Voter and option really did come from the message BODY — `EventVote` carries
    // neither, so a decoder that read only events would produce nothing here.
    for (const vote of batch.txVotes) {
      expect(vote.voter).toMatch(/^tp1/);
      expect(vote.option).not.toBe("UNSPECIFIED");
      expect(vote.txhash).toMatch(/^[A-F0-9]{64}$/);
    }

    // THE CLAIM THE MIRROR RESTS ON: a proposal that executed successfully is
    // gone from chain state, and its outcome survives only in the tx plane.
    const succeeded = batch.execResults.filter((e) => e.result === "SUCCESS");
    const onChain = new Set(batch.proposals.map((p) => p.proposalId.toString()));
    const recovered = new Set(batch.recoveredProposals.map((r) => r.snapshot.proposalId.toString()));
    for (const exec of succeeded) {
      expect(onChain.has(exec.proposalId.toString())).toBe(false);
      // …and the prune event carried its terminal status, so the row is still
      // reconstructible.
      expect(batch.prunes.some((p) => p.proposalId === exec.proposalId)).toBe(true);
    }

    // PR #23's P1, against real chain data. This whole window covers every
    // proposal's full lifecycle, so before the recovery pass the successfully
    // executed ones were absent from the sweep AND had no base row — the writer's
    // event-derived UPDATEs affected nothing and they vanished from the mirror.
    // Every proposal an event proved existed must now be reachable through one of
    // the two paths.
    for (const id of new Set([...batch.submits.map((s) => s.proposalId.toString())])) {
      expect(
        onChain.has(id) || recovered.has(id),
        `proposal ${id} was seen submitted but is in neither the sweep nor the recovery set`,
      ).toBe(true);
    }
    // And on this corpus the recovery path is genuinely exercised, not merely
    // available: the drill executed and withdrew proposals, all of which pruned.
    expect(batch.recoveredProposals.length).toBeGreaterThan(0);
    for (const r of batch.recoveredProposals) {
      // A recovered row carries its own AS-OF, strictly below the window's end.
      expect(r.observedHeight).toBeLessThan(batch.observedHeight);
      expect(r.snapshot.groupPolicyAddress).toMatch(/^tp1/);
      expect(Array.isArray(r.snapshot.messages)).toBe(true);
    }

    // A failed execution, by contrast, leaves the proposal in state.
    for (const failed of batch.execResults.filter((e) => e.result === "FAILURE")) {
      const row = batch.proposals.find((p) => p.proposalId === failed.proposalId);
      if (row !== undefined) expect(row.executorResult).toBe("FAILURE");
    }

    // Every proposal the sweep returned decoded into the closed status set with a
    // real tally and a verbatim message array.
    for (const p of batch.proposals) {
      expect(p.status).not.toBe("UNSPECIFIED");
      expect(p.tally.yes).toMatch(/^(0|[1-9][0-9]*)$/);
      expect(Array.isArray(p.messages)).toBe(true);
      expect(p.votingPeriodEnd.getTime()).toBeGreaterThan(p.submitTime.getTime());
    }
  }, 600_000);
});
