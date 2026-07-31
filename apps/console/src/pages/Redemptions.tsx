// Redemptions (spec §8.4). Ranking (DESIGN-NOTES §4): 1) reserve need vs liquidity ->
// 2) per-request funded/maturity -> 3) service action -> 4) depositor framing (L4, not a hero).
import { useSwapOuts, useVault, useStore } from "@/data/store";
import { useWallet } from "@/tx/wallet";
import { useTx } from "@/tx/execute";
import { msg } from "@/tx/messages";
import { Panel, Pill, GuardButton, ProportionBar, Cell, AddressChip } from "@/components/ui";
import { hash, shares, humanDuration, ratio, toBig } from "@/lib/format";
import { computeReserve } from "@/lib/derived";
import { guardServiceRedemptions } from "@/lib/guards";

export function Redemptions() {
  const swap = useSwapOuts();
  const vault = useVault();
  const wallet = useWallet();
  const { nowSecs, stale, role, refresh } = useStore();
  const tx = useTx();

  return (
    <div className="stack">
      <div>
        <h1 className="page-title">Redemptions</h1>
        <p className="page-sub">
          The pending swap-out queue, funded state, and reserve math, provable against chain.
        </p>
      </div>

      <Cell cell={swap}>
        {(queue) => {
          const liquid = toBig(vault.data?.principal_liquid_nhash ?? "0");
          const reserve = computeReserve(queue, liquid);
          const delay = vault.data?.withdrawal_delay_seconds ?? 60 * 86400;
          // own rows pinned first (spec §8.4)
          const ordered = [...queue].sort((a, b) => {
            const ao = a.owner === wallet.address ? 0 : 1;
            const bo = b.owner === wallet.address ? 0 : 1;
            return ao - bo;
          });
          const coverage = ratio(reserve.liquid, reserve.need);

          return (
            <>
              {/* Rank 1: reserve */}
              <Panel title="Reserve">
                <div className="grid-2" style={{ alignItems: "center" }}>
                  <div className="row" style={{ gap: 32 }}>
                    <div>
                      <div className="tile__label">reserve need (Σ estimate × 1.005)</div>
                      <div className="tile__value tnum">{hash(reserve.need)} HASH</div>
                    </div>
                    <div>
                      <div className="tile__label">principal-marker liquid</div>
                      <div className="tile__value tnum">{hash(reserve.liquid)} HASH</div>
                    </div>
                  </div>
                  <div>
                    <ProportionBar frac={coverage} tone={coverage >= 1 ? "good" : "warning"} />
                    <div className="muted-3" style={{ fontSize: 12, marginTop: 8 }}>
                      Funded requests release early on the next service pass; safety is the{" "}
                      {humanDuration(delay)} delay (contract §8).
                    </div>
                  </div>
                </div>
              </Panel>

              {/* Rank 2: queue */}
              <Panel title="Queue">
                {queue.length === 0 ? (
                  <p className="muted">No pending swap-outs.</p>
                ) : (
                  <div className="table-wrap">
                    <table className="data">
                      <thead>
                        <tr>
                          <th className="num">id</th>
                          <th>owner</th>
                          <th className="num">shares</th>
                          <th className="num">estimate</th>
                          <th className="num">maturity</th>
                          <th>funded</th>
                        </tr>
                      </thead>
                      <tbody>
                        {ordered.map((r) => {
                          const mature = r.matures_at_seconds;
                          const own = r.owner === wallet.address;
                          return (
                            <tr key={r.id} className={own ? "own" : undefined}>
                              <td className="num tnum">{r.id}</td>
                              <td>
                                {own ? (
                                  <Pill tone="good">you</Pill>
                                ) : (
                                  <AddressChip addr={r.owner} />
                                )}
                              </td>
                              <td className="num tnum">{shares(r.shares)} nvHASH</td>
                              <td className="num tnum">{hash(r.estimate_nhash)} HASH</td>
                              <td className="num tnum">
                                {nowSecs >= mature ? "matured" : humanDuration(mature - nowSecs)}
                              </td>
                              <td>
                                {reserve.funded.has(r.id) ? (
                                  <Pill tone="good">funded</Pill>
                                ) : (
                                  <Pill tone="warning">unfunded</Pill>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </Panel>

              {/* Rank 3: action */}
              <Panel title="Service">
                <GuardButton
                  guard={guardServiceRedemptions({
                    role,
                    stale,
                    nowSecs,
                    config: null,
                    epoch: null,
                  })}
                  variant="primary"
                  onClick={() =>
                    tx.submit({
                      title: "Service redemptions",
                      message: msg.serviceRedemptions(),
                      onDone: () => refresh(["swapOuts", "vault", "epoch"]),
                    })
                  }
                >
                  Service redemptions
                </GuardButton>
              </Panel>

              {/* Rank 4: framing */}
              <div className="callout callout--info">
                Redemptions swap directly with the vault and appear here. The {humanDuration(delay)}{" "}
                delay is the guarantee; funded requests are expedited on the next service pass.
                Payouts re-price at maturity NAV.
              </div>
            </>
          );
        }}
      </Cell>
    </div>
  );
}
