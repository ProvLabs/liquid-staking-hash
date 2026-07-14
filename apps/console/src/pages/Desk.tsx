// Validator Desk (spec §8.5, wallet required). Ranking (DESIGN-NOTES §5): 1) own eligibility
// ITEMIZED -> 2) arrears (exact clear amount + consequence) -> 3) TIP/priority -> 4) enroll.
import { useState } from "react";
import { useConfig, useValidators, useStore } from "@/data/store";
import { useWallet } from "@/tx/wallet";
import { useTx } from "@/tx/execute";
import { msg } from "@/tx/messages";
import { Panel, Pill, Cell } from "@/components/ui";
import { hash, pct } from "@/lib/format";
import { toBig } from "@/lib/format";
import type { ValidatorStatus } from "@/lib/types";

export function Desk() {
  const vals = useValidators();
  const cfg = useConfig();
  const wallet = useWallet();
  const { refresh } = useStore();
  const tx = useTx();
  const [valoper, setValoper] = useState("");

  if (!wallet.address) {
    return (
      <div className="stack">
        <h1 className="page-title">Validator Desk</h1>
        <div className="callout callout--info">Connect a wallet to manage your validator. This surface is operator-scoped.</div>
      </div>
    );
  }

  const threshold = cfg.data?.performance_threshold_bps ?? 9500;

  return (
    <div className="stack">
      <div>
        <h1 className="page-title">Validator Desk</h1>
        <p className="page-sub">Your validator: eligibility, obligations, and priority.</p>
      </div>

      <Cell cell={vals}>
        {(data) => {
          const mine = data.validators.filter((v) => v.operator === wallet.address);
          if (mine.length === 0) {
            return (
              <Panel title="Enroll a validator">
                <div className="row" style={{ alignItems: "flex-end", gap: 12 }}>
                  <label className="field" style={{ flex: 1 }}>
                    valoper address
                    <input className="input" placeholder="pbvaloper1…" value={valoper} onChange={(e) => setValoper(e.target.value)} />
                  </label>
                  <button
                    className="btn btn--primary"
                    disabled={!valoper.startsWith("pbvaloper1")}
                    onClick={() => tx.submit({ title: "Register participation", message: msg.register(valoper), onDone: () => refresh(["validators"]) })}
                  >
                    Register participation
                  </button>
                </div>
                <p className="muted-3" style={{ fontSize: 12, marginTop: 8 }}>
                  The caller must be the valoper's operator (same key payload); the validator must exist on chain.
                </p>
              </Panel>
            );
          }
          return <>{mine.map((v) => <OwnValidator key={v.valoper} v={v} threshold={threshold} />)}</>;
        }}
      </Cell>
    </div>
  );

  function OwnValidator({ v, threshold }: { v: ValidatorStatus; threshold: number }) {
    const due = toBig(v.commission_due) - toBig(v.commission_paid);
    const reasons: { label: string; ok: boolean }[] = [
      { label: "bonded, not jailed", ok: !v.jailed && !v.tombstoned },
      { label: `uptime ≥ ${(threshold / 100).toFixed(0)}%`, ok: v.uptime_bps !== null && v.uptime_bps >= threshold },
      { label: "commission current", ok: !v.in_arrears },
    ];
    return (
      <div className="stack" style={{ gap: 16 }}>
        {/* Rank 1: itemized eligibility */}
        <Panel title="Eligibility" actions={<Pill tone={v.eligible ? "good" : "serious"}>{v.eligible ? "eligible" : "ineligible"}</Pill>}>
          <div className="row" style={{ gap: 12 }}>
            {reasons.map((r) => (
              <Pill key={r.label} tone={r.ok ? "good" : "serious"}>
                {r.ok ? "✓" : "✕"} {r.label}
              </Pill>
            ))}
          </div>
          <div className="row" style={{ gap: 24, marginTop: 12 }}>
            <span className="muted">uptime {v.uptime_bps === null ? "no data" : pct(v.uptime_bps)} (threshold {pct(threshold)})</span>
            <span className="muted">headroom {hash(v.headroom)} HASH</span>
            <span className="muted">tip this epoch {hash(v.tip_epoch)} HASH</span>
          </div>
        </Panel>

        {/* Rank 2: commission */}
        <Panel title="Commission">
          <div className="row" style={{ gap: 24 }}>
            <span className="muted">accrued {hash(v.commission_accrued)} HASH</span>
            <span className="muted">paid {hash(v.commission_paid)} HASH</span>
            <span className="muted">due {hash(v.commission_due)} HASH</span>
          </div>
          {v.in_arrears && (
            <div className="callout callout--serious" style={{ marginTop: 12 }}>
              In arrears: pay {hash(due.toString())} HASH to clear. Ineligible until paid (one-epoch grace exceeded).
            </div>
          )}
          <button
            className="btn btn--secondary"
            style={{ marginTop: 12 }}
            onClick={() =>
              tx.submit({
                title: "Pay commission",
                message: msg.payCommission(v.valoper),
                funds: [{ denom: "nhash", amount: (due > 0n ? due : 0n).toString() }],
                tier: "warning",
                consequence: "Non-refundable. Overpayment prepays future accrual. Sweeps into vault principal at the next epoch.",
                onDone: () => refresh(["validators"]),
              })
            }
          >
            Pay commission…
          </button>
        </Panel>

        {/* Rank 3: TIP */}
        <Panel title="TIP &amp; priority">
          <p className="muted">Current-epoch TIP {hash(v.tip_epoch)} HASH. TIP is the primary priority key and resets every epoch.</p>
          <button
            className="btn btn--secondary"
            style={{ marginTop: 12 }}
            onClick={() =>
              tx.submit({
                title: "Pay tip",
                message: msg.payTip(v.valoper),
                funds: [{ denom: "nhash", amount: "0" }],
                tier: "warning",
                consequence: "Per-epoch TIP; resets at every epoch completion. Non-refundable.",
                onDone: () => refresh(["validators"]),
              })
            }
          >
            Pay tip…
          </button>
        </Panel>

        {/* Rank 4: unregister */}
        <Panel title="Participation">
          <button
            className="btn btn--warning"
            onClick={() =>
              tx.submit({
                title: "Unregister participation",
                message: msg.unregister(v.valoper),
                tier: "warning",
                consequence: "Program stake is redelegated away at the next epoch; the enrollment record is removed.",
                onDone: () => refresh(["validators"]),
              })
            }
          >
            Unregister…
          </button>
        </Panel>
      </div>
    );
  }
}
