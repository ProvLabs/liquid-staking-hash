// Overview (spec §8.1). Verification dashboard, no write controls. Ranking (DESIGN-NOTES §1):
// 1) headline health numbers -> 2) invariant proof row -> 3) trends -> 4) deployment -> 5) history.
import {
  useApr,
  useDeployment,
  useEpoch,
  useLedger,
  useNow,
  useSnapshot,
  useVault,
  useValidators,
} from "@/data/store";
import { StatTile, Pill, Panel, Cell } from "@/components/ui";
import { StepLine, SignedBars, StackedBar } from "@/charts/charts";
import { hash, shares, pct, humanDuration, relTime, toBig } from "@/lib/format";
import {
  navFromSources,
  tvvFromSources,
  navPerShare,
  aprDisplayable,
  receiptInvariant,
  epochIdentity,
  nextRunAt,
} from "@/lib/derived";

const hashNum = (v: string | bigint) => Number(toBig(v) / 1_000_000n) / 1000; // nhash -> HASH float (layout)

export function Overview() {
  const vault = useVault();
  const apr = useApr();
  const snap = useSnapshot();
  const vals = useValidators();
  const epoch = useEpoch();
  const deploy = useDeployment();
  const ledger = useLedger();
  const now = useNow();

  const nav = navFromSources(vault.data, snap.data);
  const tvv = tvvFromSources(vault.data, snap.data);
  const navSource = vault.data && toBig(vault.data.total_vault_value) > 0n ? "vault" : "snapshot";
  const eligible = vals.data?.validators.filter((v) => v.eligible).length ?? 0;
  const enrolled = vals.data?.validators.length ?? 0;
  const aprOk = aprDisplayable(apr.data);

  return (
    <div className="stack">
      <div>
        <h1 className="page-title">Overview</h1>
        <p className="page-sub">
          Is this instance healthy, and are its invariants holding? Every figure is provable from
          chain.
        </p>
      </div>

      {/* Rank 1: headline numbers */}
      <div className="grid-tiles">
        <StatTile
          label="NAV per share"
          value={nav.toFixed(4)}
          caption={`${navSource} · HASH / nvHASH`}
        />
        <StatTile
          label="Net APR"
          value={aprOk ? pct(apr.data!.net_apr_bps) : "n/a"}
          caption={
            aprOk ? `gross ${pct(apr.data!.gross_apr_bps)}` : "window too short to annualize"
          }
        />
        <StatTile
          label="TVV"
          value={tvv > 0n ? hash(tvv, 2) : "—"}
          caption={vault.data ? `${shares(vault.data.total_shares)} nvHASH` : undefined}
        />
        <StatTile
          label="Validators"
          value={`${eligible} eligible`}
          caption={`of ${enrolled} enrolled`}
        />
      </div>

      {/* Rank 2: proof row - the honesty surface, first-class (spec §17.1) */}
      <Panel title="Proof">
        <div className="row" style={{ alignItems: "center", gap: 12 }}>
          <ProofPills />
        </div>
      </Panel>

      {/* Health strip */}
      <Panel title="Health">
        <Cell cell={epoch}>
          {(e) => {
            const phaseTone = e.halted ? "critical" : e.phase === "Releasing" ? "warning" : "good";
            const nextAt = nextRunAt(e.last_run_seconds);
            return (
              <div className="row" style={{ gap: 8, alignItems: "center" }}>
                <Pill tone="neutral">epoch #{snap.data?.epoch_index ?? "—"}</Pill>
                <Pill tone={phaseTone}>
                  {e.phase === "Releasing" ? "Releasing" : e.halted ? "Halted" : "Idle"}
                </Pill>
                <Pill tone="neutral">last run {relTime(e.last_run_seconds, now)}</Pill>
                <Pill tone={now >= nextAt ? "good" : "neutral"}>
                  next {now >= nextAt ? "eligible now" : `in ${humanDuration(nextAt - now)}`}
                </Pill>
                <Pill tone={vault.data?.paused ? "serious" : "good"}>
                  vault {vault.data?.paused ? "paused" : "active"}
                </Pill>
                <Pill tone={e.halted ? "critical" : "good"}>
                  contract {e.halted ? "halted" : "active"}
                </Pill>
              </div>
            );
          }}
        </Cell>
      </Panel>

      {/* Rank 3: trends */}
      <div className="grid-2">
        <StepLine
          title="NAV over time"
          points={ledger.map((r) => ({
            label: `#${r.epoch_index}`,
            y: navPerShare(toBig(r.tvv_after), toBig(r.total_shares)),
          }))}
          fmt={(y) => y.toFixed(4)}
        />
        <Cell cell={apr}>
          {(a) => (
            <SignedBars
              title="Last epoch value"
              rows={[
                { label: "rewards", value: hashNum(a.rewards_claimed) },
                { label: "commission", value: hashNum(a.commission_received) },
                { label: "tips", value: hashNum(a.tips_received) },
                { label: "AUM est", value: -hashNum(a.aum_fee_estimate) },
                { label: "write-down", value: -hashNum(a.write_down) },
              ]}
              fmt={(v) => `${v >= 0 ? "+" : ""}${v.toFixed(0)} HASH`}
            />
          )}
        </Cell>
      </div>

      {/* Rank 4: deployment split with receipt cross-check */}
      <Cell cell={deploy}>
        {(d) => {
          const inv = receiptInvariant(toBig(epoch.data?.receipt_minted ?? "0"), d);
          return (
            <StackedBar
              title="Deployment split"
              segments={[
                { label: "delegated", value: hashNum(d.delegated) },
                { label: "unbonding", value: hashNum(d.unbonding) },
                { label: "liquid", value: hashNum(d.liquid) },
                { label: "pending", value: hashNum(d.pending) },
              ]}
              fmt={(v) => `${v.toLocaleString()} HASH`}
              caption={
                <>
                  receipt invariant:{" "}
                  {inv.matched
                    ? "backed (backing ≥ receipt_minted)"
                    : `skew ${hash(inv.delta)} HASH (in-flight legs, see Epoch)`}
                </>
              }
            />
          );
        }}
      </Cell>

      {/* Rank 5: epoch history */}
      <Panel title="Epoch history">
        {ledger.length === 0 ? (
          <p className="muted">
            No epochs recorded yet in this browser. History accrues as epochs run.
          </p>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>#</th>
                  <th>window</th>
                  <th className="num">rewards</th>
                  <th className="num">net APR</th>
                  <th className="num">net deposits</th>
                  <th className="num">eligible</th>
                </tr>
              </thead>
              <tbody>
                {[...ledger].reverse().map((r) => (
                  <tr key={r.epoch_index}>
                    <td className="tnum">#{r.epoch_index}</td>
                    <td>{humanDuration(r.ended_at_seconds - r.started_at_seconds)}</td>
                    <td className="num tnum">{hash(r.rewards_claimed)} HASH</td>
                    <td className="num tnum">{pct(r.net_apr_bps)}</td>
                    <td className="num tnum">
                      {toBig(r.net_deposits) < 0n ? "" : "+"}
                      {hash(r.net_deposits)} HASH
                    </td>
                    <td className="num tnum">{r.eligible_count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );

  function ProofPills() {
    const inv =
      deploy.data && epoch.data
        ? receiptInvariant(toBig(epoch.data.receipt_minted), deploy.data)
        : null;
    const identity = snap.data ? epochIdentity(snap.data) : null;
    return (
      <>
        {inv ? (
          <Pill tone={inv.matched ? "good" : "warning"}>
            receipt invariant {inv.matched ? "backed" : "skew"}
          </Pill>
        ) : (
          <Pill tone="neutral">receipt invariant —</Pill>
        )}
        {identity === null ? (
          <Pill tone="neutral">epoch identity —</Pill>
        ) : (
          <Pill tone={identity ? "good" : "critical"}>
            epoch identity {identity ? "pass" : "FAIL"}
          </Pill>
        )}
        <span className="muted-3" style={{ fontSize: 12 }}>
          tvv_after == tvv_before + rewards_deposited − write_down
        </span>
      </>
    );
  }
}
