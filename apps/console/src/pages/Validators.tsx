// Validators (spec §8.2). Priority-ordered participation table. Ranking (DESIGN-NOTES §2):
// 1) who is eligible and WHY (itemized) -> 2) priority/drain order -> 3) arrears -> 4) uptime
// -> 5) row actions (subordinate, behind expansion). Filters never re-sort or recolor.
import { Fragment, useState } from "react";
import { useConfig, useValidators } from "@/data/store";
import { useRole } from "@/data/store";
import { useTx } from "@/tx/execute";
import { msg } from "@/tx/messages";
import { StatTile, Pill, Panel, AddressChip, Cell, type Tone } from "@/components/ui";
import { DotStrip } from "@/charts/charts";
import { hash, pct, absTime } from "@/lib/format";
import type { ValidatorStatus } from "@/lib/types";

function monikerOf(valoper: string): string {
  const m = valoper.replace(/^pbvaloper1/, "").match(/^[a-z]+/);
  return m ? m[0].slice(0, 8) : valoper.slice(0, 8);
}

function eligibilityReasons(v: ValidatorStatus, thresholdBps: number): string[] {
  if (v.eligible) return [];
  const out: string[] = [];
  if (v.jailed) out.push("jailed");
  if (v.tombstoned) out.push("tombstoned");
  if (v.in_arrears) out.push("in arrears");
  if (v.uptime_bps !== null && v.uptime_bps < thresholdBps) out.push(`uptime ${(v.uptime_bps / 100).toFixed(1)}% < ${(thresholdBps / 100).toFixed(0)}%`);
  if (v.uptime_bps === null) out.push("no uptime data");
  return out;
}

type Filter = "all" | "eligible" | "ineligible";

export function Validators() {
  const vals = useValidators();
  const cfg = useConfig();
  const role = useRole();
  const tx = useTx();
  const [filter, setFilter] = useState<Filter>("all");
  const [q, setQ] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);

  const threshold = cfg.data?.performance_threshold_bps ?? 9500;

  return (
    <div className="stack">
      <div>
        <h1 className="page-title">Validators</h1>
        <p className="page-sub">Enrolled validators in program-priority order (rank 1 = highest priority = last drained).</p>
      </div>

      <Cell cell={vals}>
        {(data) => {
          const all = data.validators; // authoritative order; NEVER re-sorted by the UI
          const view = all.filter((v) => {
            if (filter === "eligible" && !v.eligible) return false;
            if (filter === "ineligible" && v.eligible) return false;
            if (q && !v.valoper.toLowerCase().includes(q.toLowerCase()) && !monikerOf(v.valoper).includes(q.toLowerCase()))
              return false;
            return true;
          });
          const eligible = all.filter((v) => v.eligible).length;
          const arrears = all.filter((v) => v.in_arrears).length;
          const jailed = all.filter((v) => v.jailed).length;

          return (
            <>
              <div className="grid-tiles">
                <StatTile label="Enrolled" value={all.length} />
                <StatTile label="Eligible" value={eligible} />
                <StatTile label="In arrears" value={arrears} />
                <StatTile label="Jailed now" value={jailed} />
              </div>

              <Panel
                title="Participation"
                actions={
                  <>
                    <div role="group" aria-label="eligibility filter" style={{ display: "flex", gap: 2 }}>
                      {(["all", "eligible", "ineligible"] as Filter[]).map((f) => (
                        <button
                          key={f}
                          className={`btn btn--sm ${filter === f ? "btn--secondary" : "btn--ghost"}`}
                          aria-pressed={filter === f}
                          onClick={() => setFilter(f)}
                        >
                          {f}
                        </button>
                      ))}
                    </div>
                    <input className="input" style={{ minHeight: 28 }} placeholder="search" value={q} onChange={(e) => setQ(e.target.value)} aria-label="search validators" />
                  </>
                }
              >
                <div className="table-wrap">
                  <table className="data">
                    <thead>
                      <tr>
                        <th className="num">rank</th>
                        <th>validator</th>
                        <th>status</th>
                        <th className="num">uptime</th>
                        <th className="num">tip</th>
                        <th className="num">commission (paid / due)</th>
                        <th className="num">headroom</th>
                      </tr>
                    </thead>
                    <tbody>
                      {view.map((v) => {
                        const rank = all.indexOf(v) + 1; // rank stays that of the UNFILTERED list
                        const reasons = eligibilityReasons(v, threshold);
                        const isOpen = expanded === v.valoper;
                        return (
                          <Fragment key={v.valoper}>
                            <tr onClick={() => setExpanded(isOpen ? null : v.valoper)} style={{ cursor: "pointer" }}>
                              <td className="num tnum">{rank}</td>
                              <td>
                                <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                                  <strong>{monikerOf(v.valoper)}</strong>
                                  <AddressChip addr={v.valoper} />
                                </div>
                              </td>
                              <td>
                                <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                                  {v.eligible ? (
                                    <Pill tone="good">eligible</Pill>
                                  ) : (
                                    reasons.map((r) => (
                                      <Pill key={r} tone={statusTone(r)}>
                                        {r}
                                      </Pill>
                                    ))
                                  )}
                                </div>
                              </td>
                              <td className="num tnum">{v.uptime_bps === null ? "—" : pct(v.uptime_bps)}</td>
                              <td className="num tnum">{hash(v.tip_epoch)} HASH</td>
                              <td className="num tnum" style={v.in_arrears ? { color: "var(--status-serious)" } : undefined}>
                                {hash(v.commission_paid)} / {hash(v.commission_due)}
                              </td>
                              <td className="num tnum">{hash(v.headroom)} HASH</td>
                            </tr>
                            {isOpen && (
                              <tr>
                                <td colSpan={7} style={{ background: "var(--page)" }}>
                                  <div style={{ display: "flex", flexWrap: "wrap", gap: 24, padding: "8px 4px", fontSize: 13 }}>
                                    <span className="muted">operator <AddressChip addr={v.operator} /></span>
                                    <span className="muted">enrolled {absTime(v.enrolled_at_seconds)}</span>
                                    <span className="muted">captures {v.uptime_capture_count}</span>
                                    {v.in_arrears && (
                                      <span style={{ color: "var(--status-serious)" }}>
                                        arrears: pay {hash(toDue(v))} HASH to clear (ineligible until paid)
                                      </span>
                                    )}
                                    <span style={{ display: "flex", gap: 8 }}>
                                      <button className="btn btn--secondary btn--sm" onClick={(e) => { e.stopPropagation(); payCommission(v); }}>
                                        Pay commission…
                                      </button>
                                      <button className="btn btn--secondary btn--sm" onClick={(e) => { e.stopPropagation(); payTip(v); }}>
                                        Pay tip…
                                      </button>
                                      {v.jailed && (
                                        <button className="btn btn--warning btn--sm" onClick={(e) => { e.stopPropagation(); reportJailed(v); }}>
                                          Report jailed
                                        </button>
                                      )}
                                    </span>
                                  </div>
                                </td>
                              </tr>
                            )}
                          </Fragment>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <p className="muted-3" style={{ fontSize: 12, marginTop: 12 }}>
                  Redemption unbonding drains from the bottom of this list upward (contract §10.2).
                </p>
              </Panel>

              <Panel title="Uptime vs threshold">
                <DotStrip
                  rows={all.map((v) => ({ label: monikerOf(v.valoper), uptimeBps: v.uptime_bps, eligible: v.eligible }))}
                  thresholdBps={threshold}
                />
              </Panel>
            </>
          );
        }}
      </Cell>
    </div>
  );

  function toDue(v: ValidatorStatus): string {
    return (BigInt(v.commission_due) - BigInt(v.commission_paid)).toString();
  }
  function payCommission(v: ValidatorStatus) {
    tx.submit({
      title: "Pay commission",
      message: msg.payCommission(v.valoper),
      funds: [{ denom: "nhash", amount: toDue(v) }],
      tier: "warning",
      consequence: "Non-refundable. Funds sweep into vault principal at the next epoch's deposit leg (raising NAV).",
    });
  }
  function payTip(v: ValidatorStatus) {
    tx.submit({
      title: "Pay tip",
      message: msg.payTip(v.valoper),
      funds: [{ denom: "nhash", amount: "0" }],
      tier: "warning",
      consequence: "Per-epoch TIP; resets at every epoch completion. Non-refundable.",
    });
  }
  function reportJailed(v: ValidatorStatus) {
    if (role === "observer") return;
    tx.submit({ title: "Report jailed validator", message: msg.reportJailed(v.valoper), tier: "standard" });
  }
}

function statusTone(reason: string): Tone {
  if (reason.startsWith("jailed")) return "serious";
  if (reason.startsWith("tombstoned")) return "critical";
  if (reason.startsWith("in arrears")) return "warning";
  return "serious";
}
