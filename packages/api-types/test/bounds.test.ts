// The C2 gate: every wire bound that crosses the API↔web boundary is ONE
// declaration, and the producer's cap is inside the consumer's.
//
// This suite is mechanical on purpose. The `yield_by_epoch` defect was not a
// hard problem — it was two numbers in two files that nobody compared, and the
// fix that followed added a third number rather than a comparison. Judgment is
// exactly the faculty that failed, so nothing here asks for any.

import { describe, expect, it } from "vitest";
import {
  GOVERNANCE_BOUNDED_FIELDS,
  MARKER_CAP,
  MARKER_CAP_WIRE,
  MAX_ACCRUAL_POINTS,
  MAX_ACCRUAL_POINTS_WIRE,
  MAX_GOV_POLICIES,
  MAX_GOV_PROPOSAL_MESSAGES,
  MAX_GOV_PROPOSALS_PAGE,
  MAX_GOV_PROPOSERS,
  MAX_GOV_VOTES_PER_PROPOSAL,
  MAX_GOV_METADATA_LENGTH,
  MAX_PROPOSAL_MESSAGES,
  MAX_PROPOSAL_METADATA_LEN,
  MAX_YIELD_POINTS,
  MAX_YIELD_POINTS_WIRE,
  WIRE_BOUNDS,
  WRITE_READ_BOUNDS,
} from "../src/bounds.ts";

describe("wire bounds: producer inside consumer", () => {
  it.each(WIRE_BOUNDS)("$field: producer $producer <= consumer $consumer", (bound) => {
    // The pairing itself. A producer that can emit more than the consumer accepts
    // does not degrade — the consumer's schema REJECTS the whole payload, which is
    // how one uncapped list nulled an entire derived read.
    expect(bound.producer).toBeLessThanOrEqual(bound.consumer);
  });

  it.each(WIRE_BOUNDS)("$field: both bounds are positive safe integers", (bound) => {
    for (const value of [bound.producer, bound.consumer]) {
      expect(Number.isSafeInteger(value)).toBe(true);
      expect(value).toBeGreaterThan(0);
    }
  });

  it.each(WIRE_BOUNDS)("$field: the consumer leaves headroom above the producer", (bound) => {
    // Equal bounds pass the pairing above but leave no room: the next
    // producer-side bump is instantly a wire break, and whoever makes it has no
    // signal that a consumer exists. Requiring headroom makes the coupling
    // survivable rather than merely correct today.
    expect(bound.consumer).toBeGreaterThan(bound.producer);
  });

  it("registers every governance bounded field", () => {
    // The gate's own blind spot: a bound that is not in the registry is not
    // checked. So the governance payloads are enumerated independently and
    // cross-checked, which is what makes "add an array, forget the pair" a CI
    // failure rather than a silent regression.
    const registered = new Set(WIRE_BOUNDS.map((b) => b.field));
    for (const field of GOVERNANCE_BOUNDED_FIELDS) {
      expect(registered.has(field)).toBe(true);
    }
  });

  it("has no duplicate field entries", () => {
    // Two rows for one field would let a passing pair mask a failing one.
    const fields = WIRE_BOUNDS.map((b) => b.field);
    expect(new Set(fields).size).toBe(fields.length);
  });
});

describe("governance write bounds sit inside the read bounds (PR 7.3–7.4)", () => {
  it.each(WRITE_READ_BOUNDS)("$field: write $write <= read $read", (bound) => {
    // The write side is what the App composes and its relay carries; the read
    // side is what `services/api` will serialize back. A write bound ABOVE the
    // read bound means the App can submit a proposal it can only ever render
    // truncated — PR #19's defect one boundary further along.
    expect(bound.write).toBeLessThanOrEqual(bound.read);
  });

  it.each(WRITE_READ_BOUNDS)("$field: both bounds are positive safe integers", (bound) => {
    for (const value of [bound.write, bound.read]) {
      expect(Number.isSafeInteger(value)).toBe(true);
      expect(value).toBeGreaterThan(0);
    }
  });

  it("has no duplicate field entries", () => {
    const fields = WRITE_READ_BOUNDS.map((b) => b.field);
    expect(new Set(fields).size).toBe(fields.length);
  });

  it("pins the metadata pair the composer and the reader share", () => {
    // Named explicitly, not only covered by the table: the composer's optional
    // public rationale (§7 Q3) is the one free-text field a PROPOSER controls,
    // and it must survive the round trip through the mirror unshortened.
    expect(MAX_PROPOSAL_METADATA_LEN).toBeLessThanOrEqual(MAX_GOV_METADATA_LENGTH);
  });
});

describe("the M6.1 pairs this file adopted", () => {
  it("keeps the yield_by_epoch pair correct, by import rather than by comment", () => {
    // The literal defect: 2 000 producer against a 20 000 consumer. Correct, and
    // until now correct only because someone checked once.
    expect(MAX_YIELD_POINTS).toBe(2_000);
    expect(MAX_YIELD_POINTS_WIRE).toBe(20_000);
    expect(MAX_ACCRUAL_POINTS).toBeLessThanOrEqual(MAX_ACCRUAL_POINTS_WIRE);
    expect(MARKER_CAP).toBeLessThanOrEqual(MARKER_CAP_WIRE);
  });
});

describe("governance bounds are sized for the producing system, not the happy path", () => {
  it("bounds the vote list even though a group is 'obviously' small", () => {
    // `votes[]` is not page-controlled by the caller — the detail endpoint returns
    // a proposal's whole vote set — and x/group puts no ceiling on group
    // membership. A bound here is the difference between trimming with a flag and
    // an unbounded read.
    expect(MAX_GOV_VOTES_PER_PROPOSAL).toBeGreaterThan(0);
  });

  it("bounds proposers and messages, both of which x/group allows to exceed one", () => {
    // The C1 multiplicities, given wire bounds rather than assumed to be 1.
    expect(MAX_GOV_PROPOSERS).toBeGreaterThan(1);
    expect(MAX_GOV_PROPOSAL_MESSAGES).toBeGreaterThan(1);
  });

  it("bounds the policy set above 1, since the admin/ops split is still open", () => {
    expect(MAX_GOV_POLICIES).toBeGreaterThan(1);
  });

  it("bounds a composed proposal's messages above one but inside the read cap", () => {
    // v1 composes ONE template per proposal, but the guard validates
    // element-wise and the wire permits several, so the cap is a real N>1
    // (§4b C1) rather than a disguised "exactly one".
    expect(MAX_PROPOSAL_MESSAGES).toBeGreaterThan(1);
  });

  it("keeps the proposals page within the shared pagination ceiling", () => {
    // `MAX_PAGE_LIMIT` in services/api/src/query.ts is 200. The list endpoint
    // inherits the shared pagination schema, so a producer cap BELOW that would be
    // unreachable and one above it would be a per-route divergence.
    expect(MAX_GOV_PROPOSALS_PAGE).toBe(200);
  });
});
