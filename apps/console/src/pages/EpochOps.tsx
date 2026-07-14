// Epoch & Operations (spec §8.3). Keeper cockpit. Ranking (DESIGN-NOTES §3):
// 1) cranks + guard preflight -> 2) lifecycle (phase, pending queues) -> 3) last-snapshot
// decomposition + identity pass/fail -> 4) program parameters (read-only).
import type { ReactNode } from "react";
import { useConfig, useEpoch, useSnapshot, useStore } from "@/data/store";
import { useTx } from "@/tx/execute";
import { msg } from "@/tx/messages";
import { Panel, Pill, GuardButton, Cell, AddressChip } from "@/components/ui";
import { hash, humanDuration, pct } from "@/lib/format";
import { epochIdentity, nextRunAt } from "@/lib/derived";
import {
  guardRunEpoch,
  guardClaimRewards,
  guardServiceRedemptions,
  guardCaptureUptime,
  type GuardInputs,
} from "@/lib/guards";

export function EpochOps() {
  const epoch = useEpoch();
  const cfg = useConfig();
  const snap = useSnapshot();
  const { nowSecs, stale, role, refresh } = useStore();
  const tx = useTx();
  const onDone = () => refresh(["epoch", "snapshot", "apr", "validators"]);

  const gi: GuardInputs = { role, stale, nowSecs, config: cfg.data, epoch: epoch.data };

  return (
    <div className="stack">
      <div>
        <h1 className="page-title">Epoch &amp; Operations</h1>
        <p className="page-sub">Drive the four permissionless cranks with honest guard state; read the last epoch leg by leg.</p>
      </div>

      {/* Rank 1: the cranks */}
      <Panel title="Cranks">
        <div className="row" style={{ alignItems: "flex-start", gap: 16 }}>
          <GuardButton guard={guardClaimRewards(gi)} variant="secondary" onClick={() => tx.submit({ title: "Claim rewards", message: msg.claimRewards(), onDone })}>
            Claim rewards
          </GuardButton>
          <div className="callout callout--info" style={{ alignSelf: "center", maxWidth: 260 }}>
            Claim before Run so the epoch's deposit includes current rewards (contract §11.2).
          </div>
          <GuardButton guard={guardRunEpoch(gi)} variant="primary" onClick={() => tx.submit({ title: "Run epoch", message: msg.runEpoch(), onDone })}>
            Run epoch
          </GuardButton>
          <GuardButton guard={guardServiceRedemptions(gi)} variant="secondary" onClick={() => tx.submit({ title: "Service redemptions", message: msg.serviceRedemptions(), onDone })}>
            Service redemptions
          </GuardButton>
          <GuardButton guard={guardCaptureUptime(gi)} variant="secondary" onClick={() => tx.submit({ title: "Capture uptime signal", message: msg.captureUptime(), onDone })}>
            Capture uptime
          </GuardButton>
        </div>
      </Panel>

      {/* Rank 2: lifecycle */}
      <Panel title="Lifecycle">
        <Cell cell={epoch}>
          {(e) => {
            const releasing = e.phase === "Releasing";
            const nextAt = cfg.data ? nextRunAt(e.last_run_seconds, cfg.data.min_run_interval_secs) : 0;
            return (
              <div className="stack" style={{ gap: 12 }}>
                <div className="row" style={{ gap: 8, alignItems: "center" }}>
                  <Pill tone={e.halted ? "critical" : releasing ? "warning" : "good"}>{e.halted ? "Halted" : e.phase}</Pill>
                  <span className="muted">
                    {releasing ? "Releasing: a deploy leg is draining continuation queues." : "Idle: no epoch in flight."}
                  </span>
                  <Pill tone="neutral">last run {humanDuration(nowSecs - e.last_run_seconds)} ago</Pill>
                  <Pill tone={nowSecs >= nextAt ? "good" : "neutral"}>
                    next {nowSecs >= nextAt ? "eligible now" : `in ${humanDuration(nextAt - nowSecs)}`}
                  </Pill>
                  <Pill tone="neutral">receipt_minted {hash(e.receipt_minted)} HASH</Pill>
                </div>
                {releasing && (
                  <div className="callout callout--info">
                    Continuation pending: RunEpoch may be called now to continue (interval guard bypassed, contract §11.2).
                  </div>
                )}
                <div className="grid-2">
                  <div>
                    <div className="muted" style={{ marginBottom: 6 }}>pending delegations</div>
                    {e.pending_delegations.length === 0 ? (
                      <p className="muted-3">none</p>
                    ) : (
                      <table className="data">
                        <thead><tr><th>valoper</th><th className="num">amount</th></tr></thead>
                        <tbody>
                          {e.pending_delegations.map((p) => (
                            <tr key={p.valoper}><td><AddressChip addr={p.valoper} /></td><td className="num tnum">{hash(p.amount)} HASH</td></tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </div>
                  <div>
                    <div className="muted" style={{ marginBottom: 6 }}>pending redelegations</div>
                    {e.pending_redelegations.length === 0 ? (
                      <p className="muted-3">none</p>
                    ) : (
                      <table className="data">
                        <thead><tr><th>src → dst</th><th className="num">amount</th></tr></thead>
                        <tbody>
                          {e.pending_redelegations.map((p, i) => (
                            <tr key={i}><td className="mono" style={{ fontSize: 12 }}>{p.src.slice(0, 10)}…→{p.dst.slice(0, 10)}…</td><td className="num tnum">{hash(p.amount)} HASH</td></tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </div>
                </div>
              </div>
            );
          }}
        </Cell>
      </Panel>

      {/* Rank 3: last snapshot decomposition + identity */}
      <Panel title="Last epoch snapshot">
        <Cell cell={snap} empty={<p className="muted">No epoch has run yet (snapshot is None before the first crank).</p>}>
          {(s) => {
            const ok = epochIdentity(s);
            const leg = (label: string, v: string) => (
              <div style={{ display: "flex", justifyContent: "space-between", gap: 16, padding: "3px 0" }}>
                <span className="muted">{label}</span>
                <span className="tnum">{hash(v)} HASH</span>
              </div>
            );
            return (
              <div className="stack" style={{ gap: 12 }}>
                <div className="row" style={{ alignItems: "center", gap: 12 }}>
                  <Pill tone="neutral">epoch #{s.epoch_index}</Pill>
                  <Pill tone={ok ? "good" : "critical"}>identity {ok ? "pass" : "FAIL"}</Pill>
                  <span className="muted-3" style={{ fontSize: 12 }}>tvv_after == tvv_before + rewards_deposited − write_down</span>
                </div>
                <div className="grid-2">
                  <div>
                    <div className="muted" style={{ fontWeight: 600, marginBottom: 4 }}>value legs</div>
                    {leg("rewards deposited", s.rewards_deposited)}
                    {leg("settled", s.settled)}
                    {leg("write-down", s.write_down)}
                    {leg("deployed", s.deployed)}
                    {leg("rebalanced", s.rebalanced)}
                  </div>
                  <div>
                    <div className="muted" style={{ fontWeight: 600, marginBottom: 4 }}>redemption &amp; ops legs</div>
                    {leg("unbonded for redemptions", s.unbonded_for_redemptions)}
                    <div style={{ display: "flex", justifyContent: "space-between", padding: "3px 0" }}><span className="muted">redemptions expedited</span><span className="tnum">{s.redemptions_expedited}</span></div>
                    <div style={{ display: "flex", justifyContent: "space-between", padding: "3px 0" }}><span className="muted">validators purged</span><span className="tnum">{s.validators_purged}</span></div>
                    <div style={{ display: "flex", justifyContent: "space-between", padding: "3px 0" }}><span className="muted">eligible count</span><span className="tnum">{s.eligible_count}</span></div>
                    {leg("AUM fee estimate", s.aum_fee_estimate)}
                  </div>
                </div>
              </div>
            );
          }}
        </Cell>
      </Panel>

      {/* Rank 4: parameters */}
      <Panel title="Program parameters">
        <Cell cell={cfg}>
          {(c) => (
            <div className="table-wrap">
              <table className="data">
                <tbody>
                  <ParamRow k="admin" v={<AddressChip addr={c.admin} />} />
                  <ParamRow k="vault" v={<AddressChip addr={c.vault_address} />} />
                  <ParamRow k="min run interval" v={humanDuration(c.min_run_interval_secs)} />
                  <ParamRow k="max delegations / run" v={String(c.max_delegations_per_run)} />
                  <ParamRow k="AUM fee" v={`${pct(c.aum_fee_bps)} (mirror, not measurement)`} />
                  <ParamRow k="performance threshold" v={pct(c.performance_threshold_bps)} />
                  <ParamRow k="commission" v={pct(c.commission_bps)} />
                  <ParamRow k="jail unbond delay" v={humanDuration(c.jail_unbond_delay_secs)} />
                </tbody>
              </table>
            </div>
          )}
        </Cell>
      </Panel>
    </div>
  );
}

// Small helper kept outside the component body.
function ParamRow({ k, v }: { k: string; v: ReactNode }) {
  return (
    <tr>
      <td className="muted">{k}</td>
      <td className="num">{v}</td>
    </tr>
  );
}
