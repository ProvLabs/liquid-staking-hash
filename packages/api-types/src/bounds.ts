// Wire bounds — declared ONCE, imported by both sides.
//
// WHY THIS FILE EXISTS. A collection bound that is written twice — a cap in the
// producer and a `.max()` in the consumer's Zod schema — fails silently and
// totally: the producer legitimately emits more rows than the consumer accepts,
// and the whole derived read nulls out. Coupling the two sides in a COMMENT is
// not a mechanism; nothing imports or tests a comment, so every new payload is
// free to reproduce the defect.
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

// --- governance ---------------------------------------------------

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

// --- governance WRITE path ------------------------------------------------
//
// The bounds above bound what `services/api` SERIALIZES and what `apps/web`
// ACCEPTS. These bound what the App will COMPOSE and what its relay guard will
// CARRY — the other half of the same pairing, and the half that decides whether
// a proposal the App submits can be read back by the App at all.
//
// The rule is `write <= read`, asserted by `WRITE_READ_BOUNDS` in
// `test/bounds.test.ts`. A composed proposal that exceeded a read bound would
// be mirrored TRUNCATED-and-flagged, so the App would have submitted something
// it can only render incompletely — the same class of defect the read pairs
// exist to prevent, one boundary further along.
//
// A guard bound written as a literal in `build.ts` is a defect: the composer,
// the guard and the reader must not be able to disagree about the same limit,
// so each of these has exactly one declaration.

/**
 * `MsgSubmitProposal.messages[]` — the relay guard's PER-PROPOSAL element cap.
 *
 * x/group itself puts NO ceiling here, so this is the App's, and an
 * over-cap proposal is REJECTED, never truncated: a governance payload quietly
 * shortened on its way to the chain would be a lie about what is being voted
 * on. v1 composes exactly one template per proposal; the cap is above one so a
 * multi-message proposal built elsewhere is still relayable and still validated
 * element-wise.
 */
export const MAX_PROPOSAL_MESSAGES = 8;

/** `MsgSubmitProposal.metadata` — the composer's optional public rationale
 * (offered on proposals, ABSENT on votes). */
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
  {
    field: "MsgSubmitProposal.messages",
    write: MAX_PROPOSAL_MESSAGES,
    read: MAX_GOV_PROPOSAL_MESSAGES,
  },
  {
    field: "MsgSubmitProposal.metadata",
    write: MAX_PROPOSAL_METADATA_LEN,
    read: MAX_GOV_METADATA_LENGTH,
  },
  { field: "MsgSubmitProposal.title", write: MAX_PROPOSAL_TITLE_LEN, read: MAX_GOV_TITLE_LENGTH },
  {
    field: "MsgSubmitProposal.summary",
    write: MAX_PROPOSAL_SUMMARY_LEN,
    read: MAX_GOV_SUMMARY_LENGTH,
  },
];

// --- adopted (pairs previously coupled by comment alone) ----
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

// --- §8.8 admin analytics -------------------------------------------------
//
// Each of these grows WITHOUT OPERATOR ACTION — with epoch count, holder count,
// or incident count — which is exactly the class C2 exists for. The producer
// trims and FLAGS (`*_truncated`); the consumer cap is strictly larger so a
// producer-side bump is not instantly a wire break.

/**
 * `AdminProgramHealth.epochs`, `AdminHolderCohorts.adoption`, and
 * `AdminValidatorCohorts.timeline` — one point per settled epoch.
 *
 * Epochs are calendar-monthly (liquid-staking-spec §9), so 600 points is ~50
 * years. Bounded anyway, and flagged rather than silently trimmed: an
 * unflagged trim would present a partial trend as the whole history, which is
 * the §12.1 lie this cap exists to make impossible.
 */
export const MAX_ADMIN_EPOCH_POINTS = 600;
export const MAX_ADMIN_EPOCH_POINTS_WIRE = 1_200;

/** `AdminHolderCohorts.retention` — one curve per first-deposit epoch, so it
 * grows with epoch count on the same schedule as the series above. */
export const MAX_ADMIN_RETENTION_CURVES = 600;
export const MAX_ADMIN_RETENTION_CURVES_WIRE = 1_200;

/** `AdminUpkeepDistribution.buckets`. Bounded by the bucket schedule, not by
 * history — the reason a distribution is served instead of raw samples. */
export const MAX_ADMIN_UPKEEP_BUCKETS = 16;
export const MAX_ADMIN_UPKEEP_BUCKETS_WIRE = 32;

/** `GET /api/v1/admin/incidents` — paginated under the shared page limit. */
export const MAX_ADMIN_INCIDENTS_PAGE = 200;
export const MAX_ADMIN_INCIDENTS_PAGE_WIRE = 500;

/**
 * How many holder positions the concentration read transfers: exactly the
 * deepest band (`top10_bps`), and NOT one more.
 *
 * It is a band depth, not a bound on the holder set. `AdminConcentration`'s
 * denominator and `holder_count` are aggregated over EVERY positive position in
 * SQL, so this cap can never move a reported share — the two are read in one
 * statement precisely so a deeper band and a wider program cannot drift apart.
 * Borrowing an epoch cap for this (as the first cut did) silently truncated the
 * denominator past that many holders and OVERSTATED every band.
 */
export const CONCENTRATION_BAND_DEPTH = 10;

/**
 * Days of history the §8.8 evaluator-funnel panel covers — the ONE declaration,
 * imported by both tiers.
 *
 * It is shared rather than web-local because the funnel's terminal stage is
 * chain-derived in `services/api` while its upper stages are counter-derived in
 * `apps/web`. Two windows would make the panel's bottom incomparable with its
 * top — a first-deposit total over all history under a caption reading "the last
 * 90 days" — which is the §12.1 lie invariant 15 exists to prevent. One
 * constant, so the mismatch is not expressible.
 */
export const FUNNEL_WINDOW_DAYS = 90;

/**
 * `incident_acks.note` — the optional operator note on an acknowledgment
 * (app-spec §9.1; plan §7.1 Q2). ONE declaration, three consumers: the
 * `POST /admin/incidents/ack` body schema rejects over-length input, the
 * `VarChar(500)` column is the backstop, and the admin UI's input caps at it.
 *
 * It lives here rather than beside the Prisma model because the third consumer
 * is a CLIENT component: importing the bound from a `*.server.ts` module would
 * pull server code into the browser bundle, which the bundle-secret gate exists
 * to prevent.
 */
export const MAX_ACK_NOTE_LENGTH = 500;

/**
 * `FunnelCounter` rows the §8.8 funnel panel can ever read: stages × retention
 * days, both closed sets (§14.10). Stated as the PRODUCT because "bounded by
 * two closed sets" is only reassuring once someone has multiplied it.
 *
 * The funnel panel is the one §8.8 surface with no wire pair to register: its
 * data lives in the `app` schema, which `api_reader` has no grants on, so it
 * never crosses the API boundary at all (ADR-001 Decision 1). The bound is
 * declared here anyway, beside its siblings, so a reader looking for the
 * funnel's cap finds it rather than concluding there is none.
 */
export const MAX_FUNNEL_STAGES = 5;
export const MAX_FUNNEL_RETENTION_DAYS = 400;
export const MAX_FUNNEL_ROWS_TOTAL = MAX_FUNNEL_STAGES * MAX_FUNNEL_RETENTION_DAYS;

/**
 * THE registry the pairing test walks — one list, deliberately. A bounded field
 * that crosses the boundary and is NOT in here is invisible to the gate, which
 * is the whole failure mode, so a second registry alongside it would recreate
 * exactly the blind spot this file exists to close. It is declared at the FOOT
 * of the file for that reason: every bound above it can be referenced, so a new
 * family joins this array rather than starting its own.
 *
 * The test also cross-checks the per-family field lists (`*_BOUNDED_FIELDS`)
 * against it, so "add an array, forget the pair" fails CI.
 *
 * NOT YET COVERED, and recorded rather than implied: the collection bounds on
 * `/validators` (500), `/portfolio.active_redemptions` (500),
 * `/market.depth_bands` (32) and `.bridged_supply` (64), plus
 * `ValidatorRow.failing_reasons` (32), still live only in the web Zod schema with
 * no declared producer cap. Adopting them means giving each a producer-side
 * constant, which is a change to those endpoints rather than to this one.
 */
export const WIRE_BOUNDS: readonly WireBound[] = [
  {
    field: "governance/proposals.proposals",
    producer: MAX_GOV_PROPOSALS_PAGE,
    consumer: MAX_GOV_PROPOSALS_PAGE_WIRE,
  },
  {
    field: "governance/proposal.votes",
    producer: MAX_GOV_VOTES_PER_PROPOSAL,
    consumer: MAX_GOV_VOTES_PER_PROPOSAL_WIRE,
  },
  {
    field: "GovProposalRow.messages",
    producer: MAX_GOV_PROPOSAL_MESSAGES,
    consumer: MAX_GOV_PROPOSAL_MESSAGES_WIRE,
  },
  {
    field: "GovProposalRow.proposers",
    producer: MAX_GOV_PROPOSERS,
    consumer: MAX_GOV_PROPOSERS_WIRE,
  },
  {
    field: "governance/policies.policies",
    producer: MAX_GOV_POLICIES,
    consumer: MAX_GOV_POLICIES_WIRE,
  },
  {
    field: "PortfolioMetrics.accrual",
    producer: MAX_ACCRUAL_POINTS,
    consumer: MAX_ACCRUAL_POINTS_WIRE,
  },
  {
    field: "PortfolioMetrics.yield_by_epoch",
    producer: MAX_YIELD_POINTS,
    consumer: MAX_YIELD_POINTS_WIRE,
  },
  { field: "PortfolioMetrics.accrual_markers", producer: MARKER_CAP, consumer: MARKER_CAP_WIRE },
  {
    field: "admin/program-health.epochs",
    producer: MAX_ADMIN_EPOCH_POINTS,
    consumer: MAX_ADMIN_EPOCH_POINTS_WIRE,
  },
  {
    field: "admin/holder-cohorts.adoption",
    producer: MAX_ADMIN_EPOCH_POINTS,
    consumer: MAX_ADMIN_EPOCH_POINTS_WIRE,
  },
  {
    field: "admin/holder-cohorts.retention",
    producer: MAX_ADMIN_RETENTION_CURVES,
    consumer: MAX_ADMIN_RETENTION_CURVES_WIRE,
  },
  {
    field: "admin/validator-cohorts.timeline",
    producer: MAX_ADMIN_EPOCH_POINTS,
    consumer: MAX_ADMIN_EPOCH_POINTS_WIRE,
  },
  {
    field: "AdminUpkeepDistribution.buckets",
    producer: MAX_ADMIN_UPKEEP_BUCKETS,
    consumer: MAX_ADMIN_UPKEEP_BUCKETS_WIRE,
  },
  {
    field: "admin/incidents.incidents",
    producer: MAX_ADMIN_INCIDENTS_PAGE,
    consumer: MAX_ADMIN_INCIDENTS_PAGE_WIRE,
  },
];

/** Every §8.8 collection field that must appear in `WIRE_BOUNDS` — the
 * governance cross-check, applied to this family for the same reason. */
export const ADMIN_BOUNDED_FIELDS: readonly string[] = [
  "admin/program-health.epochs",
  "admin/holder-cohorts.adoption",
  "admin/holder-cohorts.retention",
  "admin/validator-cohorts.timeline",
  "AdminUpkeepDistribution.buckets",
  "admin/incidents.incidents",
];
