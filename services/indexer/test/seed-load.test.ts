// Gates for the load seeder's contract (8.2 §3.1, invariant 1): determinism
// by seed, synthetic-only addresses (derivation shape + disjointness from the
// captured fixture corpus), the fail-closed devnet guard, and the declared
// profile counts/skew. Pure — the generator is imported, no database.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertDevTarget,
  BECH32_CHARSET,
  createGenerator,
  PROFILES,
  syntheticAddress,
  mulberry32,
} from "../scripts/seed-load.ts";

const ADDRESS_SHAPE = /^[a-z]{1,10}1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{6,83}$/;
const VALOPER_SHAPE = /^[a-z]{1,10}valoper1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{6,83}$/;

function firstBatch(profile: "smoke", seed: number) {
  const gen = createGenerator(profile, seed);
  return {
    holders: gen.holders,
    valopers: gen.valopers,
    transactions: gen.transactionBatches(1_000).next().value ?? [],
    payments: gen.operatorPaymentBatches(1_000).next().value ?? [],
    epochs: gen.epochSnapshots(),
  };
}

describe("determinism by seed", () => {
  it("the same seed produces byte-identical rows; a different seed does not", () => {
    const stringify = (value: unknown): string =>
      JSON.stringify(value, (_k, v: unknown) => (typeof v === "bigint" ? `${v}n` : v));
    const a = firstBatch("smoke", 42);
    const b = firstBatch("smoke", 42);
    expect(stringify(a)).toBe(stringify(b));

    const c = firstBatch("smoke", 43);
    expect(stringify(a.holders)).not.toBe(stringify(c.holders));
  });
});

describe("synthetic-only addresses (SECURITY.md data minimization)", () => {
  it("every generated address and valoper is valid-shape for the API's zod schemas", () => {
    const gen = createGenerator("smoke", 7);
    for (const address of gen.holders) expect(address).toMatch(ADDRESS_SHAPE);
    for (const valoper of gen.valopers) expect(valoper).toMatch(VALOPER_SHAPE);
    for (const operator of gen.operators) expect(operator).toMatch(ADDRESS_SHAPE);
  });

  it("addresses derive from the PRNG over the bech32 charset alone", () => {
    const rng = mulberry32(1);
    const address = syntheticAddress(rng);
    expect(address.startsWith("pb1")).toBe(true);
    for (const ch of address.slice(3)) expect(BECH32_CHARSET.includes(ch)).toBe(true);
  });

  it("no generated address appears in the captured fixture corpus", () => {
    // The executable half of "never sourced from real chain history": the
    // fixture corpus is the repo's only captured real-devnet data, so
    // disjointness from it is checkable. Scans every capture file's text.
    const fixturesDir = resolve(__dirname, "../../../packages/fixtures/fixtures");
    const corpus: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (name.endsWith(".json")) corpus.push(readFileSync(path, "utf8"));
      }
    };
    walk(fixturesDir);
    const blob = corpus.join("\n");
    const gen = createGenerator("smoke", 1);
    for (const address of [...gen.holders.slice(0, 50), ...gen.valopers.slice(0, 10)]) {
      expect(blob.includes(address), `${address} appears in the fixture corpus`).toBe(false);
    }
  });
});

describe("devnet-only guard (fail closed)", () => {
  it("accepts the dev-stack URL shapes", () => {
    expect(
      assertDevTarget("postgresql://indexer_writer:x@postgres:5432/nvhash?schema=indexed", {}),
    ).toContain("nvhash");
    expect(assertDevTarget("postgresql://u:p@localhost:5433/nvhash", {})).toContain("5433");
  });

  it("refuses a non-dev URL shape without the explicit override", () => {
    const real = "postgresql://writer:pw@db.example.com:5432/production";
    expect(() => assertDevTarget(real, {})).toThrow(/refusing/);
    expect(() => assertDevTarget(undefined, {})).toThrow(/not set/);
    // The override is explicit and spelled exactly.
    expect(assertDevTarget(real, { SEED_LOAD_I_KNOW: "1" } as NodeJS.ProcessEnv)).toBe(real);
  });
});

describe("declared profile counts and skew", () => {
  it("the profiles carry the recorded measured depths", () => {
    expect(PROFILES.depth1).toMatchObject({ transactions: 400_000, holders: 40_000 });
    expect(PROFILES.depth2).toMatchObject({ transactions: 1_200_000, holders: 120_000 });
    // The skew conditions from the recorded measurements: one valoper holds
    // ~300 k payments; a heavy holder carries a six-digit history.
    expect(PROFILES.depth1.heavyValoperPayments).toBe(300_000);
    expect(PROFILES.depth2.heavyValoperPayments).toBe(300_000);
    expect(PROFILES.depth2.heavyHolderTransactions).toBeGreaterThanOrEqual(100_000);
  });

  it("smoke generates exactly its declared counts, with the declared skew", () => {
    const gen = createGenerator("smoke", 5);
    let txTotal = 0;
    let heavyHolderTx = 0;
    const heavyHolder = gen.holders[0]!;
    const firstKindByHolder = new Map<string, string>();
    for (const batch of gen.transactionBatches(1_000)) {
      for (const row of batch) {
        txTotal += 1;
        if (row["address"] === heavyHolder) heavyHolderTx += 1;
        if (!firstKindByHolder.has(row["address"] as string)) {
          firstKindByHolder.set(row["address"] as string, row["kind"] as string);
        }
      }
    }
    expect(txTotal).toBe(PROFILES.smoke.transactions);
    expect(heavyHolderTx).toBe(PROFILES.smoke.heavyHolderTransactions);
    // Every holder's FIRST event is swap_in (the lifecycle fold's anchor).
    for (const [, kind] of firstKindByHolder) expect(kind).toBe("swap_in");

    let payTotal = 0;
    let heavyValoperPay = 0;
    const heavyValoper = gen.valopers[0]!;
    const keys = new Set<string>();
    for (const batch of gen.operatorPaymentBatches(1_000)) {
      for (const row of batch) {
        payTotal += 1;
        if (row["valoper"] === heavyValoper) heavyValoperPay += 1;
        keys.add(`${row["txhash"]}|${row["msgIndex"]}|${row["ordinal"]}`);
      }
    }
    expect(payTotal).toBe(PROFILES.smoke.heavyValoperPayments + PROFILES.smoke.otherPayments);
    expect(heavyValoperPay).toBe(PROFILES.smoke.heavyValoperPayments);
    // C1: sequential synthetic txhashes make natural-key collisions
    // impossible by construction — asserted, not assumed.
    expect(keys.size).toBe(payTotal);
  });
});
