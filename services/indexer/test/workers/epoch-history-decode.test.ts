// Fixture-decode: the epoch snapshot / APR smart-query shapes and the run_epoch
// crank detection match the captured corpus (packages/fixtures). A contract
// interface change breaks THIS test, not production (app-spec §9.2). Corpus is
// provisional against the pre-release vault, re-vetted.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { RawEvent } from "../../src/decode/attributes.ts";
import { parseApr, parseEpochSnapshot } from "../../src/workers/epoch-history/decode.ts";
import { findCranks } from "../../src/workers/epoch-history/boundaries.ts";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const CORPUS = join(REPO, "packages", "fixtures", "fixtures");
const CONTRACT = "tp14hj2tavq8fpesdwxxcu44rty3hh90vhujrvcmstl4zr3txmfvw9s96lrg8";

function load(rel: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(CORPUS, rel), "utf8")) as Record<string, unknown>;
}

/** A tx-search-shaped tx from a run-epoch fixture (hash/height/events). */
function txOf(fixture: Record<string, unknown>): { hash: string; height: bigint; events: RawEvent[] } {
  const resp = fixture["tx_response"] as Record<string, unknown>;
  return {
    hash: String(resp["txhash"]),
    height: BigInt(String(resp["height"])),
    events: resp["events"] as RawEvent[],
  };
}

describe("epoch-history decode against the fixture corpus", () => {
  it("decodes the epoch snapshot (data.snapshot)", () => {
    const data = load("queries/contract/epoch-snapshot.json")["data"] as Record<string, unknown>;
    const snap = parseEpochSnapshot(data["snapshot"]);
    expect(snap).toMatchObject({
      epochIndex: 8n,
      endHeight: 7811n,
      startedAtSeconds: 1784045477n,
      tvvBefore: 315350573874n,
      tvvAfter: 315397887113n,
      totalShares: 309963777029000000n,
      rewardsDeposited: 47313239n,
      deployed: 35210660n,
    });
    // net_deposits is signed (Int128) and always decodes to a bigint.
    expect(typeof snap.netDeposits).toBe("bigint");
  });

  it("decodes the APR payload (data)", () => {
    const data = load("queries/contract/apr.json")["data"];
    expect(parseApr(data)).toEqual({ epochIndex: 8n, grossAprBps: 4844, netAprBps: 4844 });
  });

  it("detects a run_epoch crank for our contract", () => {
    const tx = txOf(load("run-epoch/deploy-settlement.json"));
    expect(findCranks([tx], CONTRACT)).toEqual([{ height: 7811n, txhash: tx.hash }]);
  });

  it("ignores a non-run_epoch crank (service_redemptions) and other contracts", () => {
    const expedite = txOf(load("run-epoch/expedite.json")); // action = service_redemptions
    expect(findCranks([expedite], CONTRACT)).toEqual([]);

    const crankTx = txOf(load("run-epoch/deploy-settlement.json"));
    expect(findCranks([crankTx], "tp1someothercontract")).toEqual([]);
  });
});
