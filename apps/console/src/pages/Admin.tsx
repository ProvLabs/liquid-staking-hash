// Admin (spec §8.7, admin only). Ranking (DESIGN-NOTES §7): 1) understand-before-sign
// (diff + JSON + blast radius) -> 2) config editor (diff, changed-only) -> 3) halt/pause ->
// 4) recovery. Uniformly high-friction: consequence maximal, so friction is correct here.
import { useState } from "react";
import { useConfig, useVault, useStore } from "@/data/store";
import { useTx } from "@/tx/execute";
import { msg, type UpdateConfigFields } from "@/tx/messages";
import { Panel, Pill, Cell } from "@/components/ui";
import { pct } from "@/lib/format";
import type { ConfigResponse } from "@/lib/types";

export function Admin() {
  const cfg = useConfig();
  const vault = useVault();
  const { role, refresh } = useStore();
  const tx = useTx();

  if (role !== "admin") {
    return (
      <div className="stack">
        <h1 className="page-title">Admin</h1>
        <div className="callout callout--info">
          Admin only. Connect the address equal to <span className="mono">Config.admin</span> to see these controls. This is
          "not for you," not "broken."
        </div>
      </div>
    );
  }

  return (
    <div className="stack">
      <div>
        <h1 className="page-title">Admin</h1>
        <p className="page-sub">Every action is danger- or warning-styled and confirm-gated.</p>
      </div>

      <div className="callout callout--info">
        Authority is the <span className="mono">x/group</span> policy: the console builds the message; the group process
        executes it. The exact message JSON is shown before signing.
      </div>

      <Cell cell={cfg}>{(c) => <ConfigEditor c={c} onSubmit={submitConfig} />}</Cell>

      {/* Rank 3: halt / pause */}
      <Panel title="Halt / resume">
        <p className="muted" style={{ marginBottom: 12 }}>Blast radius: stops RunEpoch, continuations, ServiceRedemptions, and purge.</p>
        <div className="row" style={{ gap: 8 }}>
          <button className="btn btn--danger" onClick={() => submitDanger("Set halted", msg.setHalted(true))}>Halt contract</button>
          <button className="btn btn--secondary" onClick={() => submitDanger("Resume contract", msg.setHalted(false))}>Resume contract</button>
        </div>
      </Panel>

      <Panel title="Vault pause / unpause" actions={<Pill tone={vault.data?.paused ? "serious" : "good"}>{vault.data?.paused ? "paused" : "active"}</Pill>}>
        <PauseControls onPause={(reason) => submitDanger("Pause vault", msg.pauseVault(reason))} onUnpause={() => submitDanger("Unpause vault", msg.unpauseVault())} />
      </Panel>

      {/* Rank 4: recovery */}
      <Panel title="Recovery">
        <p className="muted" style={{ marginBottom: 12 }}>
          ClearPendingDelegations is safe: withdrawn nhash stays in the contract; the next epoch's return settlement
          reconciles the receipt (contract §9.9).
        </p>
        <button className="btn btn--danger" onClick={() => submitDanger("Clear pending delegations", msg.clearPending())}>
          Clear pending delegations
        </button>
      </Panel>
    </div>
  );

  function submitConfig(fields: UpdateConfigFields) {
    tx.submit({
      title: "Update config",
      message: msg.updateConfig(fields),
      tier: "danger",
      consequence: "Only the changed fields are submitted. Review the diff and message JSON before signing.",
      onDone: () => refresh(["config"]),
    });
  }
  function submitDanger(title: string, message: Parameters<typeof tx.submit>[0]["message"]) {
    tx.submit({ title, message, tier: "danger", consequence: "Irreversible / high-impact admin action. Type the action name to confirm.", onDone: () => refresh(["config", "epoch", "vault"]) });
  }
}

function ConfigEditor({ c, onSubmit }: { c: ConfigResponse; onSubmit: (f: UpdateConfigFields) => void }) {
  const [aum, setAum] = useState(String(c.aum_fee_bps));
  const [threshold, setThreshold] = useState(String(c.performance_threshold_bps));
  const [commission, setCommission] = useState(String(c.commission_bps));

  const changed: UpdateConfigFields = {};
  if (Number(aum) !== c.aum_fee_bps) changed.aum_fee_bps = Number(aum);
  if (Number(threshold) !== c.performance_threshold_bps) changed.performance_threshold_bps = Number(threshold);
  if (Number(commission) !== c.commission_bps) changed.commission_bps = Number(commission);
  const changedKeys = Object.keys(changed);

  const bpsField = (label: string, val: string, set: (s: string) => void, orig: number) => (
    <label className="field">
      {label} <span className="muted-3">({pct(Number(val || "0"))}, was {pct(orig)})</span>
      <input className="input" inputMode="numeric" value={val} onChange={(e) => set(e.target.value)} />
    </label>
  );

  return (
    <Panel title="Config editor" actions={<span className="muted-3" style={{ fontSize: 12 }}>bps fields show % live</span>}>
      <div className="grid-2">
        {bpsField("AUM fee (bps)", aum, setAum, c.aum_fee_bps)}
        {bpsField("Performance threshold (bps)", threshold, setThreshold, c.performance_threshold_bps)}
        {bpsField("Commission (bps)", commission, setCommission, c.commission_bps)}
      </div>
      <div style={{ marginTop: 12 }}>
        {changedKeys.length === 0 ? (
          <span className="muted">No changes.</span>
        ) : (
          <div className="callout callout--info">
            diff: {changedKeys.map((k) => `${k}=${(changed as Record<string, number>)[k]}`).join(", ")}
          </div>
        )}
      </div>
      <button className="btn btn--danger" style={{ marginTop: 12 }} disabled={changedKeys.length === 0} onClick={() => onSubmit(changed)}>
        Submit config change…
      </button>
    </Panel>
  );
}

function PauseControls({ onPause, onUnpause }: { onPause: (reason: string) => void; onUnpause: () => void }) {
  const [reason, setReason] = useState("");
  return (
    <div className="row" style={{ alignItems: "flex-end", gap: 12 }}>
      <label className="field" style={{ flex: 1 }}>
        pause reason
        <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="reason shown in the paused banner" />
      </label>
      <button className="btn btn--danger" disabled={!reason} onClick={() => onPause(reason)}>Pause vault</button>
      <button className="btn btn--secondary" onClick={onUnpause}>Unpause vault</button>
    </div>
  );
}
