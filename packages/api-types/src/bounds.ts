// Wire bounds — declared ONCE, imported by both sides (M7.1 §4b C2).
//
// WHY THIS FILE EXISTS. PR #19 shipped this exact defect: `yield_by_epoch` was
// uncapped server-side against a `.max(2_000)` Zod cap in the web tier, and the
// whole derived read nulled out because the producer could legitimately emit more
// rows than the consumer would accept. The fix added a constant. It did not add a
// mechanism — `rows.ts` went on coupling the two sides in a COMMENT ("most recent
// MAX_YIELD_POINTS kept"), with nothing importing or testing the pairing, so the
// next new payload was free to reproduce the bug.
//
// A bound that exists on both sides of a component boundary is therefore ONE
// declaration here, and `test/bounds.test.ts` asserts for every registered pair
// that the producer's cap is inside the consumer's. Two numbers that happen to
// agree today is not a mechanism; an import both sides share is.
//
// The two roles are deliberately named:
//   producer — the largest count `services/api` will ever serialize;
//   consumer — the largest count `apps/web`'s Zod schema will accept.
// Producer ≤ consumer, always, with headroom so a producer-side bump is not
// instantly a wire break.

/** A bound that crosses the API↔web boundary. */
export interface WireBound {
  /** The payload field this bounds, as it appears on the wire. */
  readonly field: string;
  /** Max count `services/api` will serialize. */
  readonly producer: number;
  /** Max count `apps/web`'s schema will accept. */
  readonly consumer: number;
}

// --- governance (PR 7.1) ---------------------------------------------------

/** `GET /governance/proposals` → `proposals[]`. Proposals per policy are in the
 * tens on any real program, so this is generous rather than tight. */
export const MAX_GOV_PROPOSALS_PAGE = 200;
export const MAX_GOV_PROPOSALS_PAGE_WIRE = 500;

/**
 * `GET /governance/proposal` → `votes[]`.
 *
 * The one bound in this family that is NOT page-controlled by the caller: the
 * detail endpoint returns a proposal's whole vote set, so its size is a property
 * of the GROUP, not of the request. The server must therefore trim and FLAG
 * (`votes_truncated`) rather than rely on the group being small — an x/group
 * group has no membership ceiling, and "we assumed it was small" is how an
 * uncapped read becomes an incident.
 */
export const MAX_GOV_VOTES_PER_PROPOSAL = 500;
export const MAX_GOV_VOTES_PER_PROPOSAL_WIRE = 1_000;

/** `GovProposalRow.messages[]`. An over-limit proposal is served FLAGGED
 * (`messages_truncated`), never silently truncated — a governance proposal whose
 * payload is quietly shortened would be a lie about what is being voted on. */
export const MAX_GOV_PROPOSAL_MESSAGES = 32;
export const MAX_GOV_PROPOSAL_MESSAGES_WIRE = 64;

/** `GET /governance/policies` → `policies[]`. The program has 1..n policies (the
 * admin/ops split is open); this bounds the historical set, not the live one. */
export const MAX_GOV_POLICIES = 32;
export const MAX_GOV_POLICIES_WIRE = 64;

/** `GovProposalRow.proposers[]`. x/group permits several, with no ceiling. */
export const MAX_GOV_PROPOSERS = 32;
export const MAX_GOV_PROPOSERS_WIRE = 64;

// String-length bounds, shared the same way. Addresses follow the bech32 ceiling
// the query schemas already use; free-form on-chain text is bounded because it is
// USER-AUTHORED on a permissionless chain — an unbounded title would let a
// proposer decide the size of every governance response.
export const MAX_BECH32_LENGTH = 90;
export const MAX_TXHASH_LENGTH = 64;
export const MAX_GOV_TITLE_LENGTH = 512;
export const MAX_GOV_SUMMARY_LENGTH = 4_096;
export const MAX_GOV_METADATA_LENGTH = 4_096;

// --- governance WRITE path (PR 7.3–7.4) ------------------------------------
//
// The bounds above bound what `services/api` SERIALIZES and what `apps/web`
// ACCEPTS. These bound what the App will COMPOSE and what its relay guard will
// CARRY — the other half of the same pairing, and the half that decides whether
// a proposal the App submits can be read back by the App at all.
//
// The rule is `write <= read`, asserted by `WRITE_READ_BOUNDS` in
// `test/bounds.test.ts`. A composed proposal that exceeded a read bound would
// be mirrored TRUNCATED-and-flagged, so the App would have submitted something
// it can only render incompletely — the same class of defect as PR #19's, one
// boundary further along.
//
// §4b C2 is explicit that a guard bound written as a literal in `build.ts` is a
// review failure: the composer, the guard and the reader must not be able to
// disagree about the same limit, so each of these has exactly one declaration.

/**
 * `MsgSubmitProposal.messages[]` — the relay guard's PER-PROPOSAL element cap.
 *
 * x/group itself puts NO ceiling here (§4b C1), so this is the App's, and an
 * over-cap proposal is REJECTED, never truncated: a governance payload quietly
 * shortened on its way to the chain would be a lie about what is being voted
 * on. v1 composes exactly one template per proposal (§7 Q4, confirmed
 * 2026-07-30); the cap is above one so a multi-message proposal built elsewhere
 * is still relayable and still validated element-wise.
 */
export const MAX_PROPOSAL_MESSAGES = 8;

/** `MsgSubmitProposal.metadata` — the composer's optional public rationale
 * (§7 Q3, confirmed 2026-07-30: offered on proposals, ABSENT on votes). */
export const MAX_PROPOSAL_METADATA_LEN = 1_024;

/** `MsgSubmitProposal.title` / `.summary` — the SDK ≥ 0.50 proposal fields
 * 7.2 renders. Written narrower than the read caps so a proposal composed here
 * always round-trips through `GET /governance/proposal` intact. */
export const MAX_PROPOSAL_TITLE_LEN = 256;
export const MAX_PROPOSAL_SUMMARY_LEN = 2_048;

/** A write bound and the read bound it must fit inside. */
export interface WriteReadBound {
  readonly field: string;
  /** Max the App will compose / its relay will carry. */
  readonly write: number;
  /** Max `services/api` will serialize back / `apps/web` will accept. */
  readonly read: number;
}

export const WRITE_READ_BOUNDS: readonly WriteReadBound[] = [
  { field: "MsgSubmitProposal.messages", write: MAX_PROPOSAL_MESSAGES, read: MAX_GOV_PROPOSAL_MESSAGES },
  { field: "MsgSubmitProposal.metadata", write: MAX_PROPOSAL_METADATA_LEN, read: MAX_GOV_METADATA_LENGTH },
  { field: "MsgSubmitProposal.title", write: MAX_PROPOSAL_TITLE_LEN, read: MAX_GOV_TITLE_LENGTH },
  { field: "MsgSubmitProposal.summary", write: MAX_PROPOSAL_SUMMARY_LEN, read: MAX_GOV_SUMMARY_LENGTH },
];

// --- adopted from M6.1 (the pairs PR #19's fix left coupled by comment) ----
//
// These were already correct, but only by inspection. Registering them here is
// what makes them mechanically correct, and it is why `MAX_ACCRUAL_POINTS` and
// friends now have a single home instead of living in the producer and being
// described in a consumer comment.

/** `PortfolioMetrics.accrual[]`. */
export const MAX_ACCRUAL_POINTS = 2_000;
export const MAX_ACCRUAL_POINTS_WIRE = 20_000;
/** `PortfolioMetrics.yield_by_epoch[]`. */
export const MAX_YIELD_POINTS = 2_000;
export const MAX_YIELD_POINTS_WIRE = 20_000;
/** `PortfolioMetrics.accrual_markers[]`. */
export const MARKER_CAP = 200;
export const MARKER_CAP_WIRE = 2_000;

/**
 * The registry the pairing test walks. A bounded field that crosses the boundary
 * and is NOT in here is invisible to the gate, which is the whole failure mode —
 * so the test also asserts that every governance payload field it knows about is
 * represented.
 *
 * NOT YET COVERED, and recorded rather than implied: the pre-7.1 collection
 * bounds on `/validators` (500), `/portfolio.active_redemptions` (500),
 * `/market.depth_bands` (32) and `.bridged_supply` (64), plus
 * `ValidatorRow.failing_reasons` (32), still live only in the web Zod schema with
 * no declared producer cap. Adopting them means giving each a producer-side
 * constant, which is a change to those endpoints rather than to this one.
 */
export const WIRE_BOUNDS: readonly WireBound[] = [
  { field: "governance/proposals.proposals", producer: MAX_GOV_PROPOSALS_PAGE, consumer: MAX_GOV_PROPOSALS_PAGE_WIRE },
  { field: "governance/proposal.votes", producer: MAX_GOV_VOTES_PER_PROPOSAL, consumer: MAX_GOV_VOTES_PER_PROPOSAL_WIRE },
  { field: "GovProposalRow.messages", producer: MAX_GOV_PROPOSAL_MESSAGES, consumer: MAX_GOV_PROPOSAL_MESSAGES_WIRE },
  { field: "GovProposalRow.proposers", producer: MAX_GOV_PROPOSERS, consumer: MAX_GOV_PROPOSERS_WIRE },
  { field: "governance/policies.policies", producer: MAX_GOV_POLICIES, consumer: MAX_GOV_POLICIES_WIRE },
  { field: "PortfolioMetrics.accrual", producer: MAX_ACCRUAL_POINTS, consumer: MAX_ACCRUAL_POINTS_WIRE },
  { field: "PortfolioMetrics.yield_by_epoch", producer: MAX_YIELD_POINTS, consumer: MAX_YIELD_POINTS_WIRE },
  { field: "PortfolioMetrics.accrual_markers", producer: MARKER_CAP, consumer: MARKER_CAP_WIRE },
];

/** Every governance collection field that must appear in `WIRE_BOUNDS`. The test
 * cross-checks this list, so adding a bounded governance array without declaring
 * its pair fails CI rather than shipping a half-coupled bound. */
export const GOVERNANCE_BOUNDED_FIELDS: readonly string[] = [
  "governance/proposals.proposals",
  "governance/proposal.votes",
  "GovProposalRow.messages",
  "GovProposalRow.proposers",
  "governance/policies.policies",
];
