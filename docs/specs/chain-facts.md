# Chain facts

Protocol behaviors that were **measured against a running chain**, not read from
module documentation. Each one constrains implementation in more than one tier,
so it is recorded once here and cited from code rather than restated.

A fact belongs here when all three hold: it is observable on chain, it is
surprising enough that a reader would otherwise "correct" the code that respects
it, and it is pinned by a fixture or a test. Where this document and a plan
disagree, the pinned fixture is authority.

Citation form in source: `chain-facts §<section> <n>`.

---

## §flatfees — Provenance fee model

**1. `Simulate` returns the fee amount, not gas consumed.** Under Provenance's
flat-fee model (`x/flatfees` `CalculateMsgCost`) the required fee is a
deterministic per-message cost, unrelated to gas consumed, and `Simulate`
reports that fee amount in the **gas-wanted** field. The antewrapper then
substitutes a real gas limit for execution (provenance
`internal/antewrapper/utils.go`, `GetGasWanted`).

Consequences:

- The gas price is **1nhash and is not a tunable**. A tx priced off the
  `price × gas estimate` model is *rejected* by the protocol — deliberately, to
  stop clients re-importing that assumption. It is a defect, not an
  overpayment.
- There is **no adjustment buffer**. Padding a deterministic cost by 30% buys
  no out-of-gas headroom, because the number is not gas.
- `gas_limit` and the fee `amount` are therefore the same number. Captured
  devnet txs show `fee: 2nhash`, `gas_limit: "2"`, against ~201k gas actually
  consumed.

Pinned by `apps/web/test/tx-fee.test.ts`. Reference implementation:
`apps/web/app/tx/simulate.server.ts`.

---

## §events — Event attribute encoding

**1. Attribute values carry an extra JSON-string quoting layer for strings and
are bare for integers.** `proposal_id: "6"`, `status`, `result` arrive quoted;
`msg_index` arrives as `0`. One decoding idiom handles both
(`services/indexer/src/decode/attributes.ts`, `dequote`). Pinned in
`packages/fixtures/fixtures/manifest.json`.

**2. A contract's `wasm` event type belongs to every contract on chain.** The
`_contract_address` attribute is the only thing that makes an event ours;
decoding must scope on it.

**3. Events are appended in execution order**, and a sub-message's funds
transfer is emitted immediately before that sub-call's own `wasm` event. Pairing
a payment to its transfer is therefore k-th-to-k-th *within a `msg_index`
bucket*, never positional across the tx.

---

## §x/group — Governance module behavior

Measured on devnet 2026-07-29 by `contracts/drills/gov-drill.sh`; pinned in
`packages/fixtures/fixtures/manifest.json`.

**1. A successfully executed proposal is pruned in its own transaction.** So
`ACCEPTED` + `SUCCESS` is a pair that **no state read can ever return**.
`EventExec.result` plus `EventProposalPruned` — which carries the terminal
status *and* the full tally — are its only record. This is why the tx plane is
load-bearing rather than provenance-only.

**2. Votes are deleted at the voting-period-end tally**, even for a proposal
that passes; only `final_tally_result` survives. Therefore:

- `votes_by_proposal` recovers votes only while a proposal is `SUBMITTED`;
- per-voter history for anything closed exists solely in tx history;
- an empty vote read must **never** delete stored rows.

**3. A missing proposal answers HTTP 500, not 404** — with a body identical for
a pruned id and one that never existed. An LCD outage answers 500 too. A prune
is therefore never inferred from a status code: only from absence in a
**successful** paginated sweep, or an observed `EventProposalPruned`. A partial
sweep is not a weaker prune signal; it is none at all.

**4. Voting-period-end transitions are eventless.** There is no tally event in
`finalize_block_events`, so a height-pinned state sweep is their only observer.
`EventProposalPruned` is the *one* x/group EndBlocker event on this build (295
heights scanned).

**5. `EventVote` carries only `proposal_id` + `msg_index`.** Voter and option
come from the `MsgVote` body, paired by `msg_index` — never positionally, and
never by txhash, since one tx may carry several votes for different proposals.
The `Vote` payload has no weight; weight comes from `group_members` at the
height, or stays null.

**6. A second `MsgVote` from the same voter is rejected by the chain**, so
`(proposalId, voter)` is a sound natural key.

**7. `final_tally_result` is zeros until the module tallies.** An open
proposal's live tally must come from x/group's own `TallyResult` query, never
from the state read — rendering those zeros would assert "nobody has voted".

**8. A plain-account admin is a valid, non-governed state.** `groupPolicyInfo`
throws for a plain-account admin *and* for an unreachable node. Only an
`LcdError` with status 404 reads as "not a policy"; every other failure is
`unavailable`. `not-governed` and `unavailable` are different answers.

**9. A group has no membership ceiling and no proposal ceiling.** Every read
paginates to exhaustion under an explicit cap, and hitting the cap is reported
as `truncated` — never silently dropped, and never treated as a prune.

**10. Tally counts and weights are unbounded weight sums, not token amounts.**
They exceed 2^53 and are stored `Decimal(39,0)`; a JS number corrupts them.

---

## §contract — nvHASH contract behavior

Verified against `contracts/src/validators.rs`.

**1. Program commission is cumulative and an overpayment carries forward
indefinitely; TIP resets at every epoch rollover.** So a commission position has
three states — in-arrears, current, and **prepaid** — and the prepaid credit is
derivable only from the live plane (`commission_paid − commission_accrued`),
because `pay_commission`'s `outstanding` attribute saturates at 0.

**2. `is_operator` compares the decoded bech32 payloads of caller and valoper.**
Operator authorization needs no chain read; a local bech32 payload comparison
restates the contract's own rule exactly.

**3. `pay_tip`'s event carries only the epoch-cumulative `tip_epoch`, never the
payment's own amount.** Amount and payer come from the bank `transfer` at the
same `msg_index` with the contract as recipient — the attached funds, bounded to
one coin by `cw_utils::must_pay`.

**4. Paying is permissionless.** Anyone may `PayTip` for any validator, so
`operator_payments` row count is bounded by nobody and every reader of it must
be sized for that, not for the validator cap.

**5. The contract retains only the latest epoch snapshot.** History is
reconstructed by height-pinned smart query at each `run_epoch` crank height.

---

## §lcd — Node and LCD behavior

**1. Provenance has instant finality**, so the default confirmation depth is 0.

**2. `estimate_swap_in` is gRPC-only** and is not reachable from the REST/LCD
plane the app tiers use.

**3. A height-pinned read below a pruning node's retention horizon fails.** That
failure recovers nothing and is **not** a prune signal.

## §testnet — Public-testnet facts (pilot provenance)

Every entry here is MEASURED on `pio-testnet-1` and carries its provenance
(date, height, endpoint). This section exists from PR 8.4 with its recording
obligations OPEN — the scripts that produce each fact are authored and the
first pilot run fills the values in; an unfilled row is a pilot-blocking
[VERIFY], never an assumed value:

**1. [VERIFY — `probe-accept-asset.sh`, the D27 go/no-go] Vault module
version.** Whether the public testnet build carries `provlabs/vault` at
v1.2.4+ and serves `/vault/v1` on the LCD. Fail ⇒ the pilot WAITS on
upstream (D27; no program-operated fallback exists). The probe prints the
exact block to append here.

**2. [VERIFY — `testnet-deploy.sh` step 4] Testnet `unbonding_time`** and the
derived vault `withdrawal_delay_seconds` (3/2 × unbonding).

**3. [VERIFY — `testnet-deploy.sh` step 6, CO-29] `MsgStoreCode` gas** for the
~639 KB artifact, plus the testnet per-tx gas cap — the mainnet-cap
comparison that must land before the S1 audit freezes the contract
(recorded in `contracts/IMPLEMENTATION-STATUS.md` §3 with
date/chain/height/txhash/size/sha256).

**4. [VERIFY — commit C preflight] The public LCD host** for the pilot
(`lcd.test.provenance.io` vs `api.test.provenance.io` — the console's
committed `.env.testnet` note says the former does not resolve; measure,
don't assume) **and its CORS posture** for the console's browser-side reads.
