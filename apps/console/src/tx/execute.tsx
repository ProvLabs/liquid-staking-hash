// Transaction lifecycle (spec §10.2) + tiered confirmation (§10.4) + toasts.
// The confirm sheet always shows the human action, the exact message JSON behind a
// disclosure, and the fee: "the console never signs anything it did not render" (§12).
import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import { config } from "@/config";
import { useWallet } from "@/tx/wallet";
import type { ExecuteMsg } from "@/tx/messages";

export type ConfirmTier = "standard" | "warning" | "danger";

export interface SubmitOpts {
  title: string;
  message: ExecuteMsg;
  funds?: { denom: string; amount: string }[];
  tier?: ConfirmTier;
  consequence?: string; // shown for warning/danger
  onDone?: () => void; // targeted refresh of affected queries (spec §9.1)
}

interface Toast {
  id: number;
  title: string;
  status: "pending" | "success" | "failed";
  detail?: string;
  txhash?: string;
}

interface TxState {
  submit: (opts: SubmitOpts) => void;
}
const TxCtx = createContext<TxState | null>(null);

export function TxProvider({ children }: { children: ReactNode }) {
  const wallet = useWallet();
  const [pending, setPending] = useState<SubmitOpts | null>(null);
  const [typed, setTyped] = useState("");
  const [ack, setAck] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  let toastSeq = 0;

  const pushToast = (t: Omit<Toast, "id">): number => {
    const id = ++toastSeq + toasts.length + 1;
    setToasts((cur) => [...cur, { ...t, id }]);
    return id;
  };
  const patchToast = (id: number, patch: Partial<Toast>) =>
    setToasts((cur) => cur.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  const dropToast = (id: number) => setToasts((cur) => cur.filter((t) => t.id !== id));

  const submit = useCallback((opts: SubmitOpts) => {
    setTyped("");
    setAck(false);
    setPending(opts);
  }, []);

  const close = () => setPending(null);

  const confirm = async () => {
    if (!pending) return;
    const opts = pending;
    setPending(null);
    const id = pushToast({ title: opts.title, status: "pending" });
    try {
      const txhash = await wallet.signAndBroadcast(opts.message, opts.funds);
      patchToast(id, { status: "success", txhash });
      opts.onDone?.();
    } catch (e) {
      patchToast(id, { status: "failed", detail: e instanceof Error ? e.message : String(e) });
    }
  };

  const tier = pending?.tier ?? "standard";
  const needsAck = tier === "warning";
  const needsTyped = tier === "danger";
  const typedOk = !needsTyped || typed.trim() === pending?.title;
  const ackOk = !needsAck || ack;

  return (
    <TxCtx.Provider value={{ submit }}>
      {children}
      {pending && (
        // biome-ignore lint/a11y/useKeyWithClickEvents: click-outside is a pointer-only convenience; the sheet's Cancel button is the keyboard dismissal path.
        <div className="sheet-overlay" role="dialog" aria-modal="true" onClick={close}>
          {/* biome-ignore lint/a11y/useKeyWithClickEvents: stopPropagation only; the sheet adds no interaction of its own. */}
          {/* biome-ignore lint/a11y/noStaticElementInteractions: as above — this handler exists to NOT dismiss. */}
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <div className="sheet__title">{pending.title}</div>
            {pending.consequence && (
              <div
                className={tier === "danger" ? "callout callout--serious" : "callout callout--info"}
              >
                {pending.consequence}
              </div>
            )}
            {/* §17 honesty: this said "simulated at gas × 1905nhash (×1.3)" —
                a fee that was never computed (no simulate runs here), on a
                basis the chain rejects. Under Provenance flat fees the cost is
                a deterministic per-message amount the chain's own Simulate
                returns; there is no gas × price math to state. Say what is
                actually true until the §14.1 wallet adapter lands. */}
            <div className="muted" style={{ fontSize: 13 }}>
              Fee: not estimated here. Provenance charges a fixed per-message fee, taken from the
              chain&rsquo;s simulate result when signing is wired (§14.1).
              {config.mock ? " Mock mode does not broadcast." : ""}
            </div>
            <details className="disclosure">
              <summary className="muted" style={{ cursor: "pointer" }}>
                message JSON
              </summary>
              <pre>{JSON.stringify(pending.message, null, 2)}</pre>
            </details>
            {needsAck && (
              <label style={{ display: "flex", gap: 8, fontSize: 13 }}>
                <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />I
                understand this action is non-refundable / long-lived.
              </label>
            )}
            {needsTyped && (
              <label className="field">
                Type the action name to confirm: <span className="mono">{pending.title}</span>
                <input className="input" value={typed} onChange={(e) => setTyped(e.target.value)} />
              </label>
            )}
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button type="button" className="btn btn--secondary" onClick={close}>
                Cancel
              </button>
              <button
                type="button"
                className={`btn ${tier === "danger" ? "btn--danger" : tier === "warning" ? "btn--warning" : "btn--primary"}`}
                disabled={!typedOk || !ackOk}
                onClick={confirm}
              >
                Confirm
              </button>
            </div>
          </div>
        </div>
      )}
      {toasts.length > 0 && (
        <div className="toaststack">
          {toasts.map((t) => (
            <div key={t.id} className="toast">
              <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                <strong>{t.title}</strong>
                <span
                  className={
                    "pill " +
                    (t.status === "success"
                      ? "pill--good"
                      : t.status === "failed"
                        ? "pill--critical"
                        : "pill--neutral")
                  }
                >
                  <span className="pill__dot" />
                  {t.status}
                </span>
              </div>
              {t.txhash && (
                <div className="mono muted" style={{ fontSize: 11, marginTop: 4 }}>
                  {t.txhash}
                </div>
              )}
              {t.detail && (
                <details className="disclosure" style={{ marginTop: 6 }}>
                  <summary className="muted">details</summary>
                  <pre>{t.detail}</pre>
                </details>
              )}
              {t.status !== "pending" && (
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  style={{ marginTop: 6 }}
                  onClick={() => dropToast(t.id)}
                >
                  dismiss
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </TxCtx.Provider>
  );
}

export function useTx(): TxState {
  const c = useContext(TxCtx);
  if (!c) throw new Error("useTx outside TxProvider");
  return c;
}
