// The §10.2 transaction lifecycle as a typed reducer (app plan PR 5.2 §3):
//
//   idle → building → blocked(reasons[]) | ready → simulating → confirm
//        → signing → broadcasting → pending → confirmed | failed
//
// Structural guarantees the tests pin (test/tx-lifecycle.test.ts):
//   * transitions are TOTAL: every (state, event) pair is defined — an
//     event that is illegal in a state is ignored (state returned
//     unchanged), never a throw mid-flow and never a silent skip forward;
//   * `signing` is unreachable except through `confirm` via
//     CONFIRM_ACCEPTED — no event path bypasses the §10.2 step-4 gate;
//   * `confirmed` is unreachable except from `pending` via an INCLUDED
//     event with code 0 — the UI cannot render success before chain
//     inclusion (SECURITY.md: never lie about state);
//   * every `blocked` state carries machine-readable reasons (the console
//     R1 rule: disabled controls always say why).
//
// The reducer is pure and dependency-free; the driver (5.3's pages) owns
// side effects and dispatches events.

import type { TxIntent, TxPlan } from "./build";

/** Machine-readable preflight block reasons (i18n keys map 1:1 in 5.3). */
export type PreflightReason =
  | { code: "vault-paused"; detail: string }
  | { code: "swaps-disabled" }
  | { code: "below-minimum"; minimum: string }
  | { code: "above-maximum"; maximum: string }
  | { code: "insufficient-balance"; balance: string; required: string }
  | { code: "vesting-locked"; spendable: string }
  | { code: "amount-invalid" }
  | { code: "account-missing" }
  | { code: "chain-unavailable" }
  // ── M6.4 operator flows (§2.4). Every one of these restates a predicate the
  // CONTRACT enforces; preflight is convenience only (§12.1), so a reason
  // here is a courtesy and never the thing keeping the action safe.
  | { code: "not-validator-operator" }
  | { code: "validator-not-found" }
  | { code: "already-enrolled" }
  | { code: "not-enrolled" }
  | { code: "validator-not-jailed" }
  | { code: "no-jail-report" }
  | { code: "purge-cooldown"; readyAtIso: string }
  | { code: "program-halted" };

export type FailureStage = "simulate" | "sign" | "broadcast" | "execute";

export interface PendingRow {
  /** Always rendered with an explicit pending label — never as history. */
  txhash: string;
  intent: TxIntent;
  submittedAtIso: string;
}

export type TxState =
  | { phase: "idle" }
  | { phase: "building"; intent: TxIntent }
  | { phase: "blocked"; intent: TxIntent; reasons: PreflightReason[] }
  | { phase: "ready"; intent: TxIntent }
  | { phase: "simulating"; intent: TxIntent }
  | { phase: "confirm"; plan: TxPlan }
  | { phase: "signing"; plan: TxPlan }
  | { phase: "broadcasting"; plan: TxPlan; signatureBase64: string }
  | { phase: "pending"; plan: TxPlan; row: PendingRow }
  | { phase: "reconciling"; plan: TxPlan; row: PendingRow; height: string }
  | { phase: "confirmed"; txhash: string; height: string }
  | { phase: "failed"; stage: FailureStage; txhash: string | null; detail: string };

export type TxEvent =
  | { type: "START"; intent: TxIntent }
  | { type: "PREFLIGHT_BLOCKED"; reasons: PreflightReason[] }
  | { type: "PREFLIGHT_READY" }
  | { type: "SIMULATE" }
  | { type: "SIMULATED"; plan: TxPlan }
  | { type: "SIMULATE_FAILED"; detail: string }
  | { type: "CONFIRM_ACCEPTED" }
  | { type: "CONFIRM_CANCELLED" }
  | { type: "SIGNED"; signatureBase64: string }
  | { type: "SIGN_FAILED"; detail: string }
  | { type: "BROADCAST_ACCEPTED"; txhash: string; submittedAtIso: string }
  | { type: "BROADCAST_FAILED"; detail: string }
  | { type: "INCLUDED"; height: string; code: number; rawLog: string }
  | { type: "RECONCILED" }
  | { type: "RESET" };

export const INITIAL_TX_STATE: TxState = { phase: "idle" };

export function txReducer(state: TxState, event: TxEvent): TxState {
  // RESET is legal everywhere except mid-broadcast (funds may be in flight;
  // the flow must resolve to pending/failed before the UI can discard it).
  if (event.type === "RESET") {
    return state.phase === "broadcasting" || state.phase === "signing" ? state : INITIAL_TX_STATE;
  }

  switch (state.phase) {
    case "idle":
      return event.type === "START" ? { phase: "building", intent: event.intent } : state;

    case "building":
      if (event.type === "PREFLIGHT_BLOCKED")
        return { phase: "blocked", intent: state.intent, reasons: event.reasons };
      if (event.type === "PREFLIGHT_READY") return { phase: "ready", intent: state.intent };
      return state;

    case "blocked":
      // Re-running preflight after the user edits input starts over.
      return event.type === "START" ? { phase: "building", intent: event.intent } : state;

    case "ready":
      if (event.type === "SIMULATE") return { phase: "simulating", intent: state.intent };
      if (event.type === "START") return { phase: "building", intent: event.intent };
      return state;

    case "simulating":
      if (event.type === "SIMULATED") return { phase: "confirm", plan: event.plan };
      if (event.type === "SIMULATE_FAILED")
        return { phase: "failed", stage: "simulate", txhash: null, detail: event.detail };
      return state;

    case "confirm":
      // The ONLY doorway into signing (§10.2 step 4).
      if (event.type === "CONFIRM_ACCEPTED") return { phase: "signing", plan: state.plan };
      if (event.type === "CONFIRM_CANCELLED") return INITIAL_TX_STATE;
      return state;

    case "signing":
      if (event.type === "SIGNED")
        return { phase: "broadcasting", plan: state.plan, signatureBase64: event.signatureBase64 };
      if (event.type === "SIGN_FAILED")
        return { phase: "failed", stage: "sign", txhash: null, detail: event.detail };
      return state;

    case "broadcasting":
      if (event.type === "BROADCAST_ACCEPTED")
        return {
          phase: "pending",
          plan: state.plan,
          row: {
            txhash: event.txhash,
            intent: state.plan.intent,
            submittedAtIso: event.submittedAtIso,
          },
        };
      if (event.type === "BROADCAST_FAILED")
        return { phase: "failed", stage: "broadcast", txhash: null, detail: event.detail };
      return state;

    case "pending":
      if (event.type === "INCLUDED") {
        // Execution failed on chain: an honest failure, never a retry loop
        // and never a fabricated success (§10.2 step 5; SECURITY.md).
        if (event.code !== 0)
          return {
            phase: "failed",
            stage: "execute",
            txhash: state.row.txhash,
            detail: event.rawLog,
          };
        return { phase: "reconciling", plan: state.plan, row: state.row, height: event.height };
      }
      return state;

    case "reconciling":
      // The optimistic row survives until the indexer's row lands, then drops.
      if (event.type === "RECONCILED")
        return { phase: "confirmed", txhash: state.row.txhash, height: state.height };
      return state;

    case "confirmed":
    case "failed":
      return event.type === "START" ? { phase: "building", intent: event.intent } : state;
  }
}

/** The optimistic pending row to render, if any (always labeled pending). */
export function pendingRow(state: TxState): PendingRow | null {
  return state.phase === "pending" || state.phase === "reconciling" ? state.row : null;
}
