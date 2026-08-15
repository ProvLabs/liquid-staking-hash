// Governance (spec §8.0 /governance; PR 8.4b §2.2). The live plane ONLY — the
// console has no backend, which is precisely its value next to the App's
// indexed mirror: "what does the chain hold RIGHT NOW", raw JSON behind every
// derived figure (§9.6). Read-only; proposal composition stays §17.3 deferred.
import { Fragment, useState } from "react";
import { useGovProposals, useGovTopology, useNow } from "@/data/store";
import { AddressChip, Cell, Panel, Pill, StatTile } from "@/components/ui";
import { anchorMissNotice } from "@/lib/anchors";
import { useAnchor } from "@/lib/use-anchor";
import {
  PRUNING_CAVEAT,
  secondsUntil,
  tallyCellFor,
  thresholdProgress,
  type GovProposalRow,
  type GovTopology,
} from "@/lib/governance";
import { humanDuration } from "@/lib/format";
import type { ProposalStatus } from "@/lib/types";

const STATUS_LABEL: Record<ProposalStatus, string> = {
  PROPOSAL_STATUS_SUBMITTED: "open",
  PROPOSAL_STATUS_ACCEPTED: "accepted",
  PROPOSAL_STATUS_REJECTED: "rejected",
  PROPOSAL_STATUS_ABORTED: "aborted",
  PROPOSAL_STATUS_WITHDRAWN: "withdrawn",
};

export function Governance() {
  const topo = useGovTopology();
  const proposals = useGovProposals();
  const now = useNow();
  const [expanded, setExpanded] = useState<string | null>(null);
  const { anchor, state: anchorState } = useAnchor(
    "proposal",
    proposals.data !== null && proposals.error === null,
    (a) => (proposals.data?.rows ?? []).some((r) => r.proposal.id === a.id),
    (a) => setExpanded(a.id),
  );

  return (
    <div className="stack">
      <div>
        <h1 className="page-title">Governance</h1>
        <p className="page-sub">
          What the chain holds right now: the policy topology behind{" "}
          <span className="mono">Config.admin</span> and every live proposal, raw JSON behind each
          figure.
        </p>
      </div>

      {anchorState === "missing" && anchor && (
        <div className="callout callout--info" role="status">
          {anchorMissNotice(anchor)}
        </div>
      )}

      {/* Header: governed / no group / could not check — never conflated. */}
      {topo.error !== null && topo.data === null ? (
        <div className="callout callout--serious" role="status">
          Could not check the governance topology ({topo.error}). This says nothing about whether a
          group exists — it is a failed read, not a fact.
        </div>
      ) : topo.data?.state === "no-group" ? (
        <div className="callout callout--info" role="status">
          This deployment has no group behind it: <span className="mono">Config.admin</span> is a
          plain account, the pre-governance devnet shape. A valid state, not an error.
        </div>
      ) : topo.data?.state === "governed" ? (
        <GovernedTopology topo={topo.data} />
      ) : (
        <p className="muted">Loading topology…</p>
      )}

      <Cell cell={proposals}>
        {(p) => (
          <Panel title="Proposals">
            {p.truncated && (
              <div className="callout callout--info" role="status">
                Truncated at the page cap — this list is a prefix of the chain's proposal set, not
                evidence any proposal is absent.
              </div>
            )}
            {p.rows.length === 0 ? (
              <p className="muted">No live proposals on the discovered policies.</p>
            ) : (
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr>
                      <th className="num">id</th>
                      <th>status</th>
                      <th>policy</th>
                      <th>tally</th>
                      <th className="num">voting ends</th>
                    </tr>
                  </thead>
                  <tbody>
                    {p.rows.map((row) => (
                      <ProposalRow
                        key={row.proposal.id}
                        row={row}
                        topo={topo.data}
                        now={now}
                        open={expanded === row.proposal.id}
                        onToggle={() =>
                          setExpanded(expanded === row.proposal.id ? null : row.proposal.id)
                        }
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="muted-3" style={{ fontSize: 12, marginTop: 12 }}>
              {PRUNING_CAVEAT}
            </p>
          </Panel>
        )}
      </Cell>
    </div>
  );
}

function GovernedTopology({ topo }: { topo: Extract<GovTopology, { state: "governed" }> }) {
  return (
    <>
      <div className="grid-tiles">
        <StatTile label="Group" value={`#${topo.groupId}`} />
        <StatTile
          label="Total weight"
          value={topo.group ? topo.group.total_weight : "—"}
          caption={topo.group ? undefined : "group_info could not be read"}
        />
        <StatTile
          label="Policies"
          value={topo.policies.items.length}
          caption={topo.policies.truncated ? "truncated at the page cap" : "as discovered (1..n)"}
        />
        <StatTile
          label="Members"
          value={topo.members.items.length}
          caption={topo.members.truncated ? "truncated at the page cap" : undefined}
        />
      </div>
      <Panel title="Policies">
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>address</th>
                <th>metadata</th>
                <th className="num">threshold</th>
                <th className="num">voting period</th>
              </tr>
            </thead>
            <tbody>
              {topo.policies.items.map((p) => (
                <tr key={p.address}>
                  <td>
                    <AddressChip addr={p.address} />
                  </td>
                  <td>{p.metadata || <span className="muted">—</span>}</td>
                  <td className="num tnum">{p.decision_policy?.threshold ?? "—"}</td>
                  <td className="num tnum">{p.decision_policy?.windows?.voting_period ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
      <Panel title="Members">
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>address</th>
                <th className="num">weight</th>
              </tr>
            </thead>
            <tbody>
              {topo.members.items.map((m) => (
                <tr key={m.member.address}>
                  <td>
                    <AddressChip addr={m.member.address} />
                  </td>
                  <td className="num tnum">{m.member.weight}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </>
  );
}

function ProposalRow({
  row,
  topo,
  now,
  open,
  onToggle,
}: {
  row: GovProposalRow;
  topo: GovTopology | null;
  now: number;
  open: boolean;
  onToggle: () => void;
}) {
  const { proposal } = row;
  const tally = tallyCellFor(proposal, row.liveTally, row.liveTallyError);
  const policy =
    topo?.state === "governed"
      ? topo.policies.items.find((p) => p.address === row.policyAddress)
      : undefined;
  const endsIn =
    proposal.status === "PROPOSAL_STATUS_SUBMITTED"
      ? secondsUntil(proposal.voting_period_end, now)
      : null;
  const statusTone =
    proposal.status === "PROPOSAL_STATUS_SUBMITTED"
      ? "neutral"
      : proposal.status === "PROPOSAL_STATUS_ACCEPTED"
        ? "good"
        : "warning";

  return (
    <Fragment>
      <tr id={`prop-${proposal.id}`} onClick={onToggle} style={{ cursor: "pointer" }}>
        <td className="num tnum">#{proposal.id}</td>
        <td>
          <Pill tone={statusTone}>{STATUS_LABEL[proposal.status] ?? proposal.status}</Pill>
        </td>
        <td>
          <AddressChip addr={row.policyAddress} />
        </td>
        <td>
          {tally.state === "unavailable" ? (
            <span className="muted">tally unavailable ({tally.reason})</span>
          ) : (
            <TallyText
              tally={tally.tally}
              live={tally.state === "live"}
              progress={thresholdProgress(tally.tally, policy)}
            />
          )}
        </td>
        <td className="num tnum">
          {endsIn === null ? "—" : endsIn <= 0 ? "ended" : humanDuration(endsIn)}
        </td>
      </tr>
      {open && (
        <tr>
          <td colSpan={5} style={{ background: "var(--page)" }}>
            <div className="stack" style={{ padding: "8px 4px", fontSize: 13, gap: 8 }}>
              {proposal.metadata && <div>{proposal.metadata}</div>}
              <span className="muted">
                proposers:{" "}
                {proposal.proposers.map((a) => (
                  <AddressChip key={a} addr={a} />
                ))}
              </span>
              {row.votes && (
                <div>
                  <div className="muted">
                    votes ({row.votes.items.length}
                    {row.votes.truncated ? ", truncated at the page cap" : ""})
                  </div>
                  {row.votes.items.map((v) => (
                    <div key={v.voter} className="mono" style={{ fontSize: 12 }}>
                      {v.voter} · {v.option.replace("VOTE_OPTION_", "").toLowerCase()}
                    </div>
                  ))}
                </div>
              )}
              <details className="disclosure">
                <summary className="muted" style={{ cursor: "pointer" }}>
                  raw proposal JSON
                </summary>
                <pre>{JSON.stringify(proposal, null, 2)}</pre>
              </details>
            </div>
          </td>
        </tr>
      )}
    </Fragment>
  );
}

function TallyText({
  tally,
  live,
  progress,
}: {
  tally: { yes_count: string; no_count: string; abstain_count: string; no_with_veto_count: string };
  live: boolean;
  progress: { yes: string; threshold: string } | null;
}) {
  return (
    <span className="tnum">
      {tally.yes_count} yes / {tally.no_count} no / {tally.abstain_count} abstain
      {progress && <span className="muted"> · threshold {progress.threshold}</span>}
      <span className="muted"> · {live ? "live tally" : "final"}</span>
    </span>
  );
}
