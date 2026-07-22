// Fixture-decode: the validator status, jail reports, x/staking moniker, and
// program-delegation shapes match the captured corpus (packages/fixtures). A
// contract/chain interface change breaks THIS test, not production (§9.2).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  deriveFailingReasons,
  epochIndexOf,
  parseJailReports,
  parseMonikers,
  parseProgramDelegations,
  parseValidators,
  type ValidatorStatus,
} from "../../src/workers/validator-sampler/decode.ts";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const CORPUS = join(REPO, "packages", "fixtures", "fixtures");

function load(rel: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(CORPUS, rel), "utf8")) as Record<string, unknown>;
}

describe("validator-sampler decode against the fixture corpus", () => {
  it("decodes contract validators() economics", () => {
    const data = load("queries/contract/validators.json")["data"];
    const vals = parseValidators(data);
    expect(vals).toHaveLength(1);
    expect(vals[0]).toMatchObject({
      valoper: "tpvaloper1l39wu7cht0zcycc5rkcd90sdd4ksjmxwjqvnjp",
      operator: "tp1l39wu7cht0zcycc5rkcd90sdd4ksjmxwdf388y",
      enrolledAtSeconds: 1784045040n,
      uptimeBps: 10000,
      jailed: false,
      eligible: true,
      commissionAccrued: 50693444n,
      commissionPaid: 5068167514n,
      commissionDue: 44045121n,
      headroom: 25000000000000n,
    });
  });

  it("decodes empty jail reports", () => {
    expect(parseJailReports(load("queries/contract/jail-reports.json")["data"])).toEqual([]);
  });

  it("builds a valoper -> moniker map from x/staking validators", () => {
    const monikers = parseMonikers(load("queries/staking/validators.json"));
    expect(monikers.get("tpvaloper1p99fgefe4yfhg792j9nyz380pznujq5hd6ffzy")).toBe("drill-anchor");
  });

  it("builds a valoper -> program-delegation map from x/staking delegations", () => {
    const dels = parseProgramDelegations(load("queries/staking/delegations.json"));
    expect(dels.get("tpvaloper1l39wu7cht0zcycc5rkcd90sdd4ksjmxwjqvnjp")).toBe(315350396951n);
  });

  it("reads the closed-epoch index from an epoch_snapshot payload", () => {
    expect(epochIndexOf(load("queries/contract/epoch-snapshot.json")["data"])).toBe(8n);
  });

  it("derives failing reasons from status flags", () => {
    const base: ValidatorStatus = {
      valoper: "v",
      operator: "o",
      enrolledAtSeconds: 0n,
      uptimeBps: 10000,
      jailed: false,
      tombstoned: false,
      inArrears: false,
      eligible: true,
      tipEpoch: 0n,
      commissionAccrued: 0n,
      commissionPaid: 0n,
      commissionDue: 0n,
      headroom: 1n,
    };
    expect(deriveFailingReasons(base)).toEqual([]);
    expect(deriveFailingReasons({ ...base, jailed: true, eligible: false })).toEqual(["jailed"]);
    expect(deriveFailingReasons({ ...base, inArrears: true, headroom: 0n, eligible: false })).toEqual([
      "arrears",
      "no_concentration_headroom",
    ]);
    // eligible=false with no explaining flag → generic "ineligible".
    expect(deriveFailingReasons({ ...base, eligible: false })).toEqual(["ineligible"]);
  });
});
