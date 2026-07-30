// SECURITY.md allowed-fields list for the `indexed` schema.
//
// This is the enumerated allowlist the schema-lint gate enforces
// (test/schema-allowlist.test.ts): every column of every indexed model must
// appear here, and every model must be listed. A column outside this list
// FAILS CI.
//
// This file is the design-review checkpoint SECURITY.md and app-spec §9.1
// require: "adding one is a design-review event, not a migration." Adding a
// column means editing this list, which forces the reviewer to confirm the new
// field is public chain data or minimal operational metadata — never PII, never
// an IP/device identifier. The `indexed` schema takes NONE of the app-schema
// accepted exceptions (push tokens, first/last-seen live in `app`, owned by
// apps/web) — so this list is intentionally free of any identity-adjacent field.
//
// Keep entries in schema declaration order per model for reviewability.

export const ALLOWED_FIELDS: Record<string, readonly string[]> = {
  // Per-address chain movements (public: address is a bech32 account).
  Transaction: [
    "txhash",
    "msgIndex",
    "address",
    "kind",
    "shares",
    "nhash",
    "navAtHeight",
    "height",
    "blockTime",
  ],
  // Redemption lifecycle; owner is a public bech32 account.
  RedemptionRequest: [
    "requestId",
    "owner",
    "shares",
    "estimates",
    "status",
    "enqueuedAt",
    "expeditedAt",
    "maturedAt",
    "refundedAt",
    "lastHeight",
    "lastTxhash",
  ],
  // Program history: the contract §9.10 snapshot decomposition + APR bps.
  EpochSnapshot: [
    "epochIndex",
    "startedAtSeconds",
    "endedAtSeconds",
    "endHeight",
    "tvvBefore",
    "tvvAfter",
    "totalShares",
    "rewardsClaimed",
    "commissionReceived",
    "tipsReceived",
    "rewardsDeposited",
    "settled",
    "writeDown",
    "deployed",
    "rebalanced",
    "unbondedForRedemptions",
    "aumFeeEstimate",
    "netDeposits",
    "redemptionsExpedited",
    "validatorsPurged",
    "eligibleCount",
    "grossAprBps",
    "netAprBps",
    "txhash",
    "height",
    "observedAt",
  ],
  // Validator enrollment; moniker is the operator's public on-chain label.
  ValidatorRegistry: ["valoper", "operator", "moniker", "enrolledAt", "unregisteredAt"],
  // Per-payment PayCommission/PayTip facts — reviewed 2026-07-27.
  // Every column is read straight off a public tx: `payer` is the message
  // sender (a bech32 account, already public in the tx body and its
  // `message.sender` attribute), NOT off-chain identity. `validator_epochs`
  // carries only per-epoch cumulative totals with no txhash, so the §14.11
  // operator CSV's per-payment rows cannot be served without these columns.
  OperatorPayment: [
    "txhash",
    "msgIndex",
    // Sibling discriminator within one (txhash, msgIndex) — an ordinal derived
    // from event order, not user or off-chain data.
    "ordinal",
    "valoper",
    "payer",
    "paymentType",
    "amount",
    "epochIndex",
    "height",
    "occurredAt",
  ],
  // Per-validator, per-epoch economics.
  ValidatorEpoch: [
    "valoper",
    "epochIndex",
    "uptimeBps",
    "eligible",
    "failingReasons",
    "tip",
    "commissionAccrued",
    "commissionPaid",
    "commissionDue",
    "programDelegation",
    "jailedEvents",
    "height",
    "observedAt",
  ],
  // Computed incidents (§9.6). Acknowledgment lives in app-schema incident_acks.
  Incident: ["id", "kind", "severity", "dedupeKey", "openedAt", "closedAt", "openedHeight", "payload"],
  // DEX market observations; venue/pool are public contract addresses.
  MarketSample: ["id", "venue", "pool", "price", "depthBands", "sampledAt"],
  // Remote-chain supply readings.
  BridgeSupplySample: ["id", "chain", "remoteSupply", "sampledAt"],
  // x/group proposal mirror (App). Every column is public chain
  // data: a proposal payload, a tally of member WEIGHTS, a height, a status.
  // Nothing is identity-, device- or IP-shaped.
  //
  // DESIGN-REVIEW EVENT, approved in advance — M7 overview decision D3 and the
  // app-spec §9.1 forward note, which enumerate these columns and why each one
  // has to exist. Two additions go BEYOND that enumeration and are recorded
  // here rather than slipped in:
  //   - `title` / `summary`: SDK >= 0.50 proposal fields observed on the devnet
  //     payload 2026-07-29. Author-supplied public text, and the only
  //     human-readable label a proposal has — a pruned proposal's title exists
  //     nowhere else. Approved by direction (Ira, 2026-07-29).
  //   - `proposer` REMOVED in favour of `proposers`: x/group permits several
  //     proposers, so the scalar was a lie whenever there were two.
  GovProposal: [
    "proposalId",
    "groupPolicyAddress",
    "groupId",
    "proposers",
    "status",
    "executorResult",
    "metadata",
    "title",
    "summary",
    "messages",
    "submitTime",
    "votingPeriodEnd",
    "yesCount",
    "noCount",
    "abstainCount",
    "noWithVetoCount",
    "groupVersion",
    "groupPolicyVersion",
    "decisionPolicy",
    "observedHeight",
    "observedAt",
    "height",
    "txhash",
    "prunedAtHeight",
  ],
  // x/group vote mirror; `voter` is a public member address and `metadata` is the
  // vote's own public on-chain text. `weight` is a member weight, not an amount
  // of anything owned.
  GovVote: ["proposalId", "voter", "option", "metadata", "weight", "submitTime", "height", "txhash"],
  // Worker cursors (operational).
  IndexerCheckpoint: ["stream", "cursorHeight", "cursorPage", "updatedAt"],
  // Reconciler run records (operational reconciliation facts).
  ReconcilerRun: ["id", "ranAt", "chainHeight", "indexedHeight", "deltas", "withinTolerance", "incidentId"],
};

// Substrings that must never appear in an indexed column name — the explicit
// SECURITY.md-named identity/IP/device tokens. Belt-and-suspenders on top of
// the allowlist: even if one of these were mistakenly added to the list above,
// this denylist trips first.
export const FORBIDDEN_FIELD_SUBSTRINGS = [
  "email",
  "phone",
  "ssn",
  "passport",
  "ipaddress",
  "ipaddr",
  "remoteaddr",
  "xforwardedfor",
  "forwardedfor",
  "useragent",
  "user_agent",
  "device",
  "fingerprint",
  "givenname",
  "familyname",
  "fullname",
  "firstname",
  "lastname",
] as const;

// Column-name → declared type expectations for amount-shaped fields: every
// base-unit amount is Decimal(39,0), never a JS-number-backed Float/Int
// (app-spec §5.8). The amount-discipline gate checks these carry
// `@db.Decimal(39, 0)`.
export const AMOUNT_FIELDS: Record<string, readonly string[]> = {
  Transaction: ["shares", "nhash", "navAtHeight"],
  RedemptionRequest: ["shares"],
  EpochSnapshot: [
    "tvvBefore",
    "tvvAfter",
    "totalShares",
    "rewardsClaimed",
    "commissionReceived",
    "tipsReceived",
    "rewardsDeposited",
    "settled",
    "writeDown",
    "deployed",
    "rebalanced",
    "unbondedForRedemptions",
    "aumFeeEstimate",
    "netDeposits",
  ],
  ValidatorEpoch: ["tip", "commissionAccrued", "commissionPaid", "commissionDue", "programDelegation"],
  OperatorPayment: ["amount"],
  MarketSample: ["price"],
  BridgeSupplySample: ["remoteSupply"],
  // x/group tally counts and voter weights (App). Not token amounts —
  // they are sums of member weights — but they join the same discipline for the
  // same reason: they are unbounded chain integers with no protocol ceiling, so a
  // JS-number-backed column would corrupt them silently past 2^53.
  GovProposal: ["yesCount", "noCount", "abstainCount", "noWithVetoCount"],
  GovVote: ["weight"],
};
