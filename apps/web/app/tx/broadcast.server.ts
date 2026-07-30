// The guarded broadcast relay (app plan PR 5.2 §2.3; app-spec §12.3
// amendment, decided 2026-07-23): the web tier relays a FULLY-SIGNED
// transaction to the chain, and nothing else. The server cannot alter a
// signed tx without invalidating its signature — the relay adds no signing
// or custody capability. The guards below are enforced mechanisms, each
// with a case in test/broadcast-guard.test.ts:
//
//   1. session required                        → 401 (route layer)
//   2. size cap (SIZE_CAP_BYTES)               → 413
//   3. decodes as TxRaw, one signature         → 400
//   4. every msg type ∈ the closed allowlist   → 400
//  4b. MsgExecuteContract ONLY: the M6.4 §2.5 deep guard — configured
//      contract, one of six operator variants, per-variant body, funds
//      discipline, canonical bytes → 400
//  4c. cosmos.group.v1 ONLY (M7.3–7.4 §2.2): the governance guards — the
//      structural one for MsgVote/MsgExec, the six-condition one for
//      MsgSubmitProposal, both ending in canonical bytes → 400
//   5. every vault msg's vault == configured vault → 400
//   6. every msg's owner/sender == session address → 403
//   7. SOLE signer pubkey derives session addr → 403 (cryptographic
//      binding: the pubkey that signed IS the session's address)
//   8. rate limit per session address          → 429
//
// The chain re-checks everything again (the contract is the enforcement
// boundary); these guards keep the relay from being a general tx submission
// service for anyone with a session.
//
// WHY THIS IS ASYNC AS OF M7.3–7.4. `guardSubmitProposal`'s condition 3 asks
// whether a proposal's `group_policy_address` is one of the DISCOVERED program
// policies, and policy discovery is set-valued (D1: `Config.admin` → policy →
// group → all policies on that group), so it is a live chain read. Keeping the
// guard synchronous would have meant hardcoding a policy address — the exact
// topology assumption SECURITY.md forbids — or moving condition 3 out of the
// guard into the route, which would split a guard whose conditions are ordered
// and non-negotiable. The read happens ONLY for a transaction that actually
// carries a `MsgSubmitProposal`, so swaps and operator actions gain no hop.

import { LcdClient, TxClient, type FetchLike } from "@nvhash/chain-client";

import { loadLiveGovernance } from "~/lib/services/governance.server";
import { pubkeyToBech32, bech32Prefix } from "~/lib/adr36-verify.server";
import type { WebConfig } from "~/config/config.server";
import {
  ALLOWED_MSG_TYPE_URLS,
  decodeTxRaw,
  guardGovernanceMsg,
  guardOperatorExecute,
  guardSubmitProposal,
  MSG_EXECUTE_CONTRACT,
  MSG_GOV_EXEC,
  MSG_GOV_SUBMIT_PROPOSAL,
  MSG_GOV_VOTE,
} from "./build";

export const SIZE_CAP_BYTES = 16 * 1024;
/** Broadcasts per session address per window (a user action, not a bot API). */
export const RATE_LIMIT_PER_MINUTE = 6;

export type RelayVerdict =
  | { ok: true }
  | { ok: false; status: 400 | 403 | 413 | 429 | 503; reason: string };

/**
 * Resolve the program's group policies for guard condition 3.
 *
 * Returns null when the live plane could not be resolved AT ALL — an outage, or
 * a deployment with no group. Null must REJECT rather than pass: admitting a
 * proposal whose policy nobody could verify is exactly the hole condition 3
 * exists to close, and "the chain was slow" is not a reason to relay an admin
 * proposal to an unverified account.
 */
export type PolicyResolver = () => Promise<readonly string[] | null>;

async function discoverProgramPolicies(
  config: WebConfig,
  fetchImpl?: FetchLike,
): Promise<readonly string[] | null> {
  const live = await loadLiveGovernance(config, fetchImpl ? { fetchImpl } : {});
  if (live.state !== "governed") return null;
  // A TRUNCATED policy sweep is not a complete set. Relaying a proposal for a
  // policy that a capped sweep happened to include, while another was dropped,
  // would make the guard's verdict depend on pagination — so a truncated sweep
  // is treated as unresolvable rather than as a smaller set.
  if (live.policiesTruncated) return null;
  return live.policies.map((policy) => policy.address);
}

interface RateWindow {
  windowStartMs: number;
  count: number;
}
const rateWindows = new Map<string, RateWindow>();

/** Test seam. */
export function resetRelayRateLimitForTests(): void {
  rateWindows.clear();
}

function checkRate(address: string, nowMs: number): boolean {
  const window = rateWindows.get(address);
  if (window === undefined || nowMs - window.windowStartMs >= 60_000) {
    rateWindows.set(address, { windowStartMs: nowMs, count: 1 });
    return true;
  }
  window.count += 1;
  return window.count <= RATE_LIMIT_PER_MINUTE;
}

export interface RelayGuardDeps {
  nowMs?: number;
  fetchImpl?: FetchLike;
  /** Test seam AND the injection point for guard condition 3's live read. */
  resolvePolicies?: PolicyResolver;
}

/**
 * Run every relay guard over the raw submitted bytes for the SESSION address.
 * Deterministic over its inputs (clock and the policy read are injected) — the
 * route maps the verdict to its HTTP response.
 */
export async function guardSignedTx(
  config: WebConfig,
  sessionAddress: string,
  txRawBytes: Uint8Array,
  deps: RelayGuardDeps = {},
): Promise<RelayVerdict> {
  const nowMs = deps.nowMs ?? Date.now();
  if (txRawBytes.length > SIZE_CAP_BYTES) {
    return { ok: false, status: 413, reason: "transaction too large" };
  }
  if (!checkRate(sessionAddress, nowMs)) {
    return { ok: false, status: 429, reason: "rate limited" };
  }

  let decoded;
  try {
    decoded = decodeTxRaw(txRawBytes);
  } catch {
    return { ok: false, status: 400, reason: "malformed transaction" };
  }

  if (decoded.messages.length === 0 || decoded.signatureCount !== 1 || decoded.signerPubkeys.length !== 1) {
    return { ok: false, status: 400, reason: "expected exactly one signer" };
  }

  // Condition 3's input, resolved ONCE and only when a submission is present.
  // Resolved BEFORE the loop so a multi-message body cannot make the read
  // happen a different number of times depending on message order.
  let policyAddresses: readonly string[] | null = null;
  if (decoded.messages.some((msg) => msg.typeUrl === MSG_GOV_SUBMIT_PROPOSAL)) {
    const resolve =
      deps.resolvePolicies ?? (() => discoverProgramPolicies(config, deps.fetchImpl));
    policyAddresses = await resolve().catch(() => null);
    if (policyAddresses === null || policyAddresses.length === 0) {
      // 503, not 400: the submission may be perfectly well-formed. Saying
      // "we could not verify the policy set right now" is the honest answer,
      // and it is the one that does not invite a retry with different bytes.
      return { ok: false, status: 503, reason: "the program's group policies could not be verified" };
    }
  }

  // GUARD 6 IS PER-SHAPE, NOT PER-MESSAGE-FIELD-1. Through M6.4 every carried
  // message had its signer in field 1 (`owner`/`sender`), so one check outside
  // the dispatch served all of them. The governance messages do NOT: `MsgVote`
  // field 1 is a varint proposal id and `MsgSubmitProposal` field 1 is the
  // policy address. Each governance guard therefore performs its OWN
  // session binding (on `voter`, `signer`, and every entry of `proposers`), and
  // the field-1 check below runs for the shapes it is actually about. Leaving
  // the old check in place for all messages would have bound a vote to a
  // proposal id — which reads as "always rejected", the failure mode that hides
  // a missing check behind a passing test.
  for (const msg of decoded.messages) {
    if (!(ALLOWED_MSG_TYPE_URLS as readonly string[]).includes(msg.typeUrl)) {
      return { ok: false, status: 400, reason: "message type not allowed" };
    }
    if (msg.typeUrl === MSG_GOV_SUBMIT_PROPOSAL) {
      // Guard 4c — the six-condition guard (M7.4 §2.2).
      const verdict = guardSubmitProposal(msg, {
        signerAddress: sessionAddress,
        contractAddress: config.contractAddress,
        policyAddresses: policyAddresses!,
      });
      if (!verdict.ok) return { ok: false, status: 400, reason: verdict.reason };
      continue;
    }
    if (msg.typeUrl === MSG_GOV_VOTE || msg.typeUrl === MSG_GOV_EXEC) {
      // Guard 4c — the structural guard (M7.3 §2.2).
      const verdict = guardGovernanceMsg(msg, { signerAddress: sessionAddress });
      if (!verdict.ok) return { ok: false, status: 400, reason: verdict.reason };
      continue;
    }
    if (msg.typeUrl === MSG_EXECUTE_CONTRACT) {
      // Guard 4b — the M6.4 §2.5 DEEP guard. `MsgExecuteContract` is in the
      // allowlist only because this runs: on its own the type URL would carry
      // any call to any contract. It replaces the vault check (field 2 is the
      // CONTRACT here, not the vault) and is never skipped for it.
      //
      // UNCHANGED BY M7.3–7.4, and that is invariant 8: a DIRECT
      // `MsgExecuteContract` carrying an admin variant is still refused here.
      // Admin ops reach the chain only through governance.
      const verdict = guardOperatorExecute(msg, { contractAddress: config.contractAddress });
      if (!verdict.ok) {
        return { ok: false, status: 400, reason: verdict.reason };
      }
    } else if (msg.vaultAddress !== config.vaultAddress) {
      return { ok: false, status: 400, reason: "unexpected vault address" };
    }
    // Guard 6 applies to BOTH remaining shapes: field 1 is the vault msgs'
    // `owner` and an execute's `sender`, so an operator action is bound to the
    // session address exactly as a swap is.
    if (msg.owner !== sessionAddress) {
      return { ok: false, status: 403, reason: "owner is not the session address" };
    }
  }

  // Guard 7 — the cryptographic sole-signer binding: the pubkey inside
  // auth_info must derive the session's own bech32 address. The chain
  // verifies the signature against this pubkey, so a tx passing this guard
  // was signed by the session address's key and no other.
  const prefix = bech32Prefix(sessionAddress);
  let derived: string;
  try {
    derived = pubkeyToBech32(decoded.signerPubkeys[0]!, prefix);
  } catch {
    return { ok: false, status: 400, reason: "malformed transaction" };
  }
  if (derived !== sessionAddress) {
    return { ok: false, status: 403, reason: "signer is not the session address" };
  }

  return { ok: true };
}

/** Relay the (already-guarded) bytes to the chain. */
export async function relayBroadcast(
  config: WebConfig,
  txRawBytes: Uint8Array,
  deps: { fetchImpl?: FetchLike } = {},
): Promise<{ txhash: string; code: number; rawLog: string }> {
  const lcd = new LcdClient(config.lcdUrl, deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {});
  return new TxClient(lcd).broadcast(Buffer.from(txRawBytes).toString("base64"));
}
