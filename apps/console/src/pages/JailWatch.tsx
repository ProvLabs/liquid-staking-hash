// Jail Watch (spec §8.6). Ranking (DESIGN-NOTES §6): 1) open reports + purge-ready ->
// 2) two-phase rule explained -> 3) report newly-jailed -> 4) purge (with/without claimant).
import { useState } from "react";
import { useJail, useValidators, useStore } from "@/data/store";
import { useWallet } from "@/tx/wallet";
import { useTx } from "@/tx/execute";
import { msg } from "@/tx/messages";
import { Panel, Pill, GuardButton, Countdown, Cell, AddressChip } from "@/components/ui";
import { hash, absTime } from "@/lib/format";
import { guardReportJailed, guardPurge } from "@/lib/guards";

export function JailWatch() {
  const jail = useJail();
  const vals = useValidators();
  const wallet = useWallet();
  const { nowSecs, stale, role, refresh } = useStore();
  const tx = useTx();
  const [claimant, setClaimant] = useState<Record<string, string>>({});

  const validators = vals.data?.validators ?? [];
  const jailedNow = (valoper: string) => validators.find((v) => v.valoper === valoper)?.jailed ?? false;
  const myEligible = validators.filter((v) => v.operator === wallet.address && v.eligible);

  return (
    <div className="stack">
      <div>
        <h1 className="page-title">Jail Watch</h1>
        <p className="page-sub">Open jail reports, purge countdowns, and the two-phase purge action.</p>
      </div>

      {/* Rank 2: rule (placed high because it prevents a wrong action) */}
      <div className="callout callout--info">
        Two-phase (contract §9.8): a report starts the cooldown; purge requires the target still jailed at execution. An
        unjailed validator's report clears on the next report/purge.
      </div>

      {/* Rank 1: open reports */}
      <Panel title="Open reports">
        <Cell cell={jail} empty={<p className="muted">No open jail reports.</p>}>
          {(data) =>
            data.reports.length === 0 ? (
              <p className="muted">No open jail reports.</p>
            ) : (
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr>
                      <th>validator</th>
                      <th>reported</th>
                      <th className="num">purge-ready</th>
                      <th>live</th>
                      <th>purge</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.reports.map((rep) => {
                      const live = jailedNow(rep.valoper);
                      const g = guardPurge({
                        role,
                        stale,
                        nowSecs,
                        config: null,
                        epoch: null,
                        reportExists: true,
                        purgeReadyAt: rep.purge_ready_at_seconds,
                        jailedNow: live,
                        claimantEligibleAndMine: claimant[rep.valoper] ? myEligible.some((v) => v.valoper === claimant[rep.valoper]) : undefined,
                      });
                      return (
                        <tr key={rep.valoper}>
                          <td><AddressChip addr={rep.valoper} /></td>
                          <td>{absTime(rep.reported_at_seconds)}</td>
                          <td className="num tnum">
                            <Countdown target={rep.purge_ready_at_seconds} readyLabel="ready" />
                          </td>
                          <td>{live ? <Pill tone="serious">jailed</Pill> : <Pill tone="good">unjailed</Pill>}</td>
                          <td>
                            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                              <select
                                className="input"
                                style={{ minHeight: 28 }}
                                aria-label="claimant"
                                value={claimant[rep.valoper] ?? ""}
                                onChange={(e) => setClaimant((c) => ({ ...c, [rep.valoper]: e.target.value }))}
                              >
                                <option value="">no claimant (unbond full)</option>
                                {myEligible.map((v) => (
                                  <option key={v.valoper} value={v.valoper}>
                                    {v.valoper.slice(0, 14)}… (headroom {hash(v.headroom)})
                                  </option>
                                ))}
                              </select>
                              <GuardButton
                                guard={g}
                                variant={claimant[rep.valoper] ? "secondary" : "warning"}
                                onClick={() =>
                                  tx.submit({
                                    title: claimant[rep.valoper] ? "Purge to claimant" : "Unbond full program stake",
                                    message: msg.purgeJailed(rep.valoper, claimant[rep.valoper] || null),
                                    tier: "warning",
                                    consequence: claimant[rep.valoper]
                                      ? "Redelegates up to the claimant's headroom; unbonds the remainder (~21 days)."
                                      : "Unbonds the full program stake for ~21 days.",
                                    onDone: () => refresh(["jail", "validators", "epoch"]),
                                  })
                                }
                              >
                                {claimant[rep.valoper] ? "Purge" : "Unbond full"}
                              </GuardButton>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )
          }
        </Cell>
      </Panel>

      {/* Rank 3: report newly-jailed */}
      <Panel title="Report a jailed validator">
        {validators.filter((v) => v.jailed).length === 0 ? (
          <p className="muted">No enrolled validator is currently jailed.</p>
        ) : (
          <div className="row" style={{ gap: 8 }}>
            {validators
              .filter((v) => v.jailed)
              .map((v) => (
                <GuardButton
                  key={v.valoper}
                  guard={guardReportJailed(true)}
                  variant="secondary"
                  onClick={() => tx.submit({ title: "Report jailed validator", message: msg.reportJailed(v.valoper), onDone: () => refresh(["jail"]) })}
                >
                  Report {v.valoper.slice(0, 14)}…
                </GuardButton>
              ))}
          </div>
        )}
      </Panel>
    </div>
  );
}
