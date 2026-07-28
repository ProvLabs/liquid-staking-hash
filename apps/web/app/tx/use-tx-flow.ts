// The client-side lifecycle driver (plan 5.3): wires the 5.2 machinery —
// preflight → simulate → confirm → sign → broadcast → track — into a single
// hook both /stake and /exit dispatch through. The reducer
// (`lifecycle.ts`) owns the state; this hook owns the side effects and
// enforces the ordering the reducer only permits (signing is reachable
// only after CONFIRM_ACCEPTED; the sign call fires exactly once, from the
// confirm handler).
//
// The browser talks only to this server's `/tx/*` resource routes and to
// the wallet adapter — never to the LCD or the API directly (§7, §12.3).

import { useCallback, useReducer } from "react";

import { useWallet } from "~/wallet/provider";
import {
  buildTxPlan,
  encodeTxRaw,
  intentSigner,
  type Fee,
  type OperatorVariant,
  type SignerContext,
  type TxIntent,
} from "./build";
import {
  INITIAL_TX_STATE,
  txReducer,
  type PreflightReason,
  type TxState,
} from "./lifecycle";
import { trackTransaction } from "./track";

/** What the page provides to start a flow — the amount is already parsed to
 * base units and validated (app/lib/amount.ts); owner/vault are filled from
 * session + config server-side, so the client never names them. */
export type FlowIntentInput =
  | { kind: "swap_in"; amount: bigint; denom: string }
  | { kind: "swap_out"; amount: bigint; denom: string; redeemDenom: string }
  /** M6.4 operator actions. The client names the variant, its validator and
   * the amount; the SENDER and the CONTRACT are supplied by the caller from
   * session + config, and re-checked server-side on every hop. */
  | {
      kind: "operator";
      variant: OperatorVariant;
      valoper: string;
      claimantValoper: string | null;
      amount: bigint;
      denom: string;
    };

interface PreflightResponse {
  reasons: PreflightReason[];
  signer: { accountNumber: string; sequence: string; chainId: string } | null;
  balance: string;
  denom: string;
}

interface SimulateResponse {
  gas_used: string;
  fee: { gas_limit: string; amount: string; denom: string };
  signer: { account_number: string; sequence: string; chain_id: string };
}

async function postJson(path: string, body: unknown): Promise<Response> {
  return fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export interface TxFlow {
  state: TxState;
  /** Run preflight → simulate → reach the confirm step (or a blocked/failed
   * state). Safe to call again after an edit; resets any prior terminal. */
  /** `target` is the vault address for swaps, the CONTRACT address for
   * operator actions — both re-checked server-side by the relay guard. */
  begin(input: FlowIntentInput, owner: string, target: string): Promise<void>;
  /** Accept the confirm dialog: sign → broadcast → track. */
  confirm(): Promise<void>;
  /** Cancel the confirm dialog (returns to idle). */
  cancel(): void;
  /** Discard a terminal/blocked state back to idle. */
  reset(): void;
}

export function useTxFlow(): TxFlow {
  const [state, dispatch] = useReducer(txReducer, INITIAL_TX_STATE);
  const { signDirect, pubkeyBase64 } = useWallet();

  const begin = useCallback(
    async (input: FlowIntentInput, owner: string, target: string) => {
      dispatch({ type: "RESET" });
      const intent: TxIntent =
        input.kind === "operator"
          ? {
              kind: "operator",
              variant: input.variant,
              sender: owner,
              contractAddress: target,
              valoper: input.valoper,
              claimantValoper: input.claimantValoper,
              amount: input.amount,
              denom: input.denom,
            }
          : ({ ...input, owner, vaultAddress: target } as TxIntent);
      dispatch({ type: "START", intent });

      // Preflight (server, session-scoped). Reasons block the flow with a
      // machine-readable list; the page maps each to localized copy. A
      // thrown fetch (network down) blocks the same way — the flow must
      // always land in a state the user can restart from, never strand.
      let pf: PreflightResponse;
      try {
        const pfRes = await postJson(
          "/tx/preflight",
          input.kind === "operator"
            ? {
                kind: "operator",
                variant: input.variant,
                valoper: input.valoper,
                claimantValoper: input.claimantValoper,
                amount: input.amount.toString(),
              }
            : { kind: input.kind, amount: input.amount.toString() },
        );
        if (!pfRes.ok) {
          dispatch({ type: "PREFLIGHT_BLOCKED", reasons: [{ code: "chain-unavailable" }] });
          return;
        }
        pf = (await pfRes.json()) as PreflightResponse;
      } catch {
        dispatch({ type: "PREFLIGHT_BLOCKED", reasons: [{ code: "chain-unavailable" }] });
        return;
      }
      if (pf.reasons.length > 0 || pf.signer === null) {
        dispatch({
          type: "PREFLIGHT_BLOCKED",
          reasons: pf.reasons.length > 0 ? pf.reasons : [{ code: "account-missing" }],
        });
        return;
      }
      dispatch({ type: "PREFLIGHT_READY" });

      if (pubkeyBase64 === null) {
        // Live reads passed, but we cannot build a sign doc without the
        // connected pubkey — surface the reconnect need honestly. SIMULATE
        // first: the reducer only accepts SIMULATE_FAILED from `simulating`.
        dispatch({ type: "SIMULATE" });
        dispatch({ type: "SIMULATE_FAILED", detail: "wallet not connected for signing" });
        return;
      }

      // Simulate (server) for the fee.
      dispatch({ type: "SIMULATE" });
      let sim: SimulateResponse;
      try {
        const simRes = await postJson(
          "/tx/simulate",
          input.kind === "operator"
            ? {
                kind: "operator",
                variant: input.variant,
                valoper: input.valoper,
                claimantValoper: input.claimantValoper,
                amount: input.amount.toString(),
                denom: input.denom,
                pubkey: pubkeyBase64,
              }
            : {
                kind: input.kind,
                amount: input.amount.toString(),
                denom: input.denom,
                pubkey: pubkeyBase64,
                redeemDenom: input.kind === "swap_out" ? input.redeemDenom : "",
              },
        );
        if (!simRes.ok) {
          const detail = await simRes.text().catch(() => "simulation failed");
          dispatch({ type: "SIMULATE_FAILED", detail });
          return;
        }
        sim = (await simRes.json()) as SimulateResponse;
      } catch {
        dispatch({ type: "SIMULATE_FAILED", detail: "network error during simulation" });
        return;
      }
      const fee: Fee = {
        gasLimit: BigInt(sim.fee.gas_limit),
        amount: BigInt(sim.fee.amount),
        denom: sim.fee.denom,
      };
      const signer: SignerContext = {
        chainId: sim.signer.chain_id,
        accountNumber: BigInt(sim.signer.account_number),
        sequence: BigInt(sim.signer.sequence),
        pubkeyBase64,
      };
      // buildTxPlan asserts the encoder's funds invariant and throws if the
      // intent violates it. Preflight and the simulate route both reject that
      // case first, so reaching here means a bug — but the flow's contract is
      // to land in a restartable state, never to strand mid-flight.
      try {
        dispatch({ type: "SIMULATED", plan: buildTxPlan(intent, fee, signer) });
      } catch (cause) {
        dispatch({
          type: "SIMULATE_FAILED",
          detail: cause instanceof Error ? cause.message : "could not build the transaction",
        });
      }
    },
    [pubkeyBase64],
  );

  const confirm = useCallback(async () => {
    if (state.phase !== "confirm") return; // reducer would ignore it anyway
    const { plan } = state;
    dispatch({ type: "CONFIRM_ACCEPTED" });

    let signatureBase64: string;
    try {
      const signed = await signDirect(intentSigner(plan.intent), {
        bodyBytesBase64: Buffer.from(plan.bodyBytes).toString("base64"),
        authInfoBytesBase64: Buffer.from(plan.authInfoBytes).toString("base64"),
        chainId: plan.signer.chainId,
        accountNumber: plan.signer.accountNumber.toString(),
      });
      signatureBase64 = signed.signatureBase64;
    } catch (error) {
      dispatch({
        type: "SIGN_FAILED",
        detail: error instanceof Error ? error.message : "signing failed",
      });
      return;
    }
    dispatch({ type: "SIGNED", signatureBase64 });

    const txRaw = encodeTxRaw(plan.bodyBytes, plan.authInfoBytes, [
      Uint8Array.from(Buffer.from(signatureBase64, "base64")),
    ]);
    let txhash: string;
    let code: number;
    let raw_log: string;
    try {
      const bcRes = await postJson("/tx/broadcast", {
        tx_raw: Buffer.from(txRaw).toString("base64"),
      });
      if (!bcRes.ok) {
        const detail = await bcRes.text().catch(() => "broadcast failed");
        dispatch({ type: "BROADCAST_FAILED", detail });
        return;
      }
      ({ txhash, code, raw_log } = (await bcRes.json()) as {
        txhash: string;
        code: number;
        raw_log: string;
      });
    } catch {
      // The response was lost, so delivery is UNKNOWN (the request may have
      // reached the relay) — say so rather than claiming nothing was sent.
      dispatch({
        type: "BROADCAST_FAILED",
        detail: "network error — delivery unknown; check your portfolio before retrying",
      });
      return;
    }
    if (code !== 0) {
      dispatch({ type: "BROADCAST_FAILED", detail: raw_log || `broadcast code ${code}` });
      return;
    }
    dispatch({ type: "BROADCAST_ACCEPTED", txhash, submittedAtIso: new Date().toISOString() });
    // Track inclusion → reconcile. `trackTransaction` dispatches INCLUDED /
    // RECONCILED; the reducer renders failure on a non-zero execution code.
    await trackTransaction(txhash, dispatch);
  }, [state, signDirect]);

  const cancel = useCallback(() => dispatch({ type: "CONFIRM_CANCELLED" }), []);
  const reset = useCallback(() => dispatch({ type: "RESET" }), []);

  return { state, begin, confirm, cancel, reset };
}
