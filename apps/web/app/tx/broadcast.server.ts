// The guarded broadcast relay (app-spec §12.3
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
// 4b. MsgExecuteContract ONLY: the deep guard — configured
//      contract, one of six operator variants, per-variant body, funds
//      discipline, canonical bytes → 400
//  4c. cosmos.group.v1 ONLY: the governance guard — signer ↔
//      session binding, closed field set, the `exec` pin, canonical bytes → 400
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
// WHAT THE GOVERNANCE GUARDS DELIBERATELY DO NOT DO (§12.3 amendment). They do
// not inspect a proposal's inner messages, and they do not check that a vote's
// or a proposal's policy belongs to this program. Doing either — a closed
// template set, a per-inner-message canonical re-encode, a live policy sweep
// that would make this whole function async — buys nothing, and the argument
// for it (that carrying `messages []Any` bound for the policy account is
// "strictly worse" than an unguarded `MsgExecuteContract`) is backwards.
//
// An unguarded
// `MsgExecuteContract` executes ON INCLUSION under the signer's own authority.
// A `MsgSubmitProposal` executes NOTHING until the group's decision policy is
// satisfied by other members voting — so the THRESHOLD is the enforcement
// boundary, and what protects members from a hostile proposal is being able to
// read it before they vote (`app/governance/decode.ts`, delivered at 7.2).
// Restricting what may be proposed bought no authority reduction and cost a
// chain read on every submission, a 503 failure mode, and a template registry
// the relay had to keep in lockstep with the contract.

import { LcdClient, TxClient, type FetchLike } from "@nvhash/chain-client";

import { pubkeyToBech32, bech32Prefix } from "~/lib/adr36-verify.server";
import type { WebConfig } from "~/config/config.server";
import {
  ALLOWED_MSG_TYPE_URLS,
  decodeTxRaw,
  GOVERNANCE_MSG_TYPE_URLS,
  guardGovernanceMsg,
  guardOperatorExecute,
  MSG_EXECUTE_CONTRACT,
} from "./build";

export const SIZE_CAP_BYTES = 16 * 1024;
/** Broadcasts per session address per window (a user action, not a bot API). */
export const RATE_LIMIT_PER_MINUTE = 6;

export type RelayVerdict =
  | { ok: true }
  | { ok: false; status: 400 | 403 | 413 | 429; reason: string };

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

/**
 * Run every relay guard over the raw submitted bytes for the SESSION address.
 * Pure over its inputs (clock injected) — the route maps the verdict to its
 * HTTP response.
 */
export function guardSignedTx(
  config: WebConfig,
  sessionAddress: string,
  txRawBytes: Uint8Array,
  nowMs: number = Date.now(),
): RelayVerdict {
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

  if (
    decoded.messages.length === 0 ||
    decoded.signatureCount !== 1 ||
    decoded.signerPubkeys.length !== 1
  ) {
    return { ok: false, status: 400, reason: "expected exactly one signer" };
  }

  // GUARD 6 IS PER-SHAPE, NOT PER-MESSAGE-FIELD-1. The vault and operator
  // messages carry their signer in field 1 (`owner`/`sender`), so one check
  // outside the dispatch serves all of them. The governance messages do NOT: `MsgVote`
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
    if ((GOVERNANCE_MSG_TYPE_URLS as readonly string[]).includes(msg.typeUrl)) {
      // Guard 4c — the structural governance guard.
      const verdict = guardGovernanceMsg(msg, { signerAddress: sessionAddress });
      if (!verdict.ok) return { ok: false, status: 400, reason: verdict.reason };
      continue;
    }
    if (msg.typeUrl === MSG_EXECUTE_CONTRACT) {
      // Guard 4b — the DEEP guard. `MsgExecuteContract` is in the
      // allowlist only because this runs: on its own the type URL would carry
      // any call to any contract. It replaces the vault check (field 2 is the
      // CONTRACT here, not the vault) and is never skipped for it.
      //
      // UNCHANGED by the governance guards, and that is invariant 8: a DIRECT
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
