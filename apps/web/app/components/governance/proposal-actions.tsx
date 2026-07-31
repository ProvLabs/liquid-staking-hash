// The proposal detail page's WRITE surface (app-spec §8.7).
//
// Vote and execute run through the UNMODIFIED 5.2 lifecycle (`useTxFlow`:
// preflight → simulate → confirm → sign → broadcast → track), exactly as the
// operator flows do. Nothing here signs: the wallet does, and no key
// material is touched.
//
// WHAT THIS COMPONENT DOES NOT DECIDE. Whether a control appears is
// `app/governance/actions.ts`'s answer, computed in the loader from the LIVE
// plane and passed in — not a condition written in JSX. That separation is the
// point: an action panel rendered against a state the action cannot validly
// operate on is the failure this prevents, and it is what happens when the
// decision is made in a component, where no table can drive it. Here every
// affordance is a value with a reason, and `test/governance-flows.test.ts`
// drives one case per row of the state × affordance matrix.
//
// EVERY HIDDEN CONTROL SAYS WHY. There is no silently-absent action and no
// disabled control without an explanation — the console R1 rule.

import { useState } from "react";

import { Button } from "~/components/ui/button";
import { formatInstant } from "~/governance/format";
import type { ExecuteAffordance, VoteAffordance } from "~/governance/actions";
import type { DecodedMessage } from "~/governance/decode";
import { summarizeMessage } from "~/governance/decode";
import { t, type Locale, type MessageKey } from "~/i18n";
import { HASH_EXPONENT } from "~/learn/amounts";
import { GOVERNANCE_VOTE_OPTION_NAMES, type GovernanceVoteOption } from "~/tx/build";
import { TxConfirm } from "~/tx/confirm";
import { FlowStatus, feeDisplay } from "~/tx/flow-status";
import { useTxFlow } from "~/tx/use-tx-flow";

const VOTE_OPTION_KEYS: Record<GovernanceVoteOption, MessageKey> = {
  yes: "governance.vote-yes",
  abstain: "governance.vote-abstain",
  no: "governance.vote-no",
  no_with_veto: "governance.vote-no-with-veto",
};

const VOTE_HIDDEN_KEYS: Record<string, MessageKey> = {
  anonymous: "governance.actions-connect",
  "live-unavailable": "governance.actions-live-down",
  pruned: "governance.plane-pruned",
  "not-open": "tx.reason-proposal-not-open",
  "voting-ended": "tx.reason-proposal-not-open",
  "not-member": "governance.vote-not-member",
  "membership-unknown": "governance.members-not-checked",
  "membership-changed": "governance.vote-membership-changed",
};

const EXECUTE_HIDDEN_KEYS: Record<string, MessageKey> = {
  anonymous: "governance.actions-connect",
  "live-unavailable": "governance.actions-live-down",
  pruned: "governance.plane-pruned",
  "not-passed": "tx.reason-proposal-not-passed",
  "already-executed": "tx.reason-already-executed",
  "execution-failed": "governance.execute-failed-note",
  terminal: "tx.reason-proposal-not-passed",
};

export interface ProposalActionsProps {
  locale: Locale;
  proposalId: string;
  /** The connected session address; null renders the connect prompt only. */
  sessionAddress: string | null;
  vote: VoteAffordance;
  execute: ExecuteAffordance;
  /** The proposal's decoded messages — what `MsgExec` will actually run. */
  messages: DecodedMessage[];
  /** The program contract, passed through to the flow (re-checked server-side). */
  contractAddress: string;
}

export function ProposalActions({
  locale,
  proposalId,
  sessionAddress,
  vote,
  execute,
  messages,
  contractAddress,
}: ProposalActionsProps) {
  const flow = useTxFlow();
  const [option, setOption] = useState<GovernanceVoteOption>("yes");
  const [pending, setPending] = useState<"vote" | "exec" | null>(null);

  const startVote = async () => {
    if (sessionAddress === null) return;
    setPending("vote");
    await flow.begin(
      { kind: "gov_vote", proposalId: BigInt(proposalId), option },
      sessionAddress,
      contractAddress,
    );
  };

  const startExec = async () => {
    if (sessionAddress === null) return;
    setPending("exec");
    await flow.begin(
      { kind: "gov_exec", proposalId: BigInt(proposalId) },
      sessionAddress,
      contractAddress,
    );
  };

  // §2.6 / §17.1: `MsgExec`'s disclosure shows WHAT THE PROPOSAL WILL EXECUTE,
  // not merely "execute proposal 12". A message this build cannot summarize is
  // named as such rather than skipped — a shortened list of consequences would
  // be the one failure that makes a signature uninformed.
  const executeSummaryLines = [
    t(locale, "governance.confirm-exec-1", { id: proposalId }),
    t(locale, "governance.confirm-exec-2"),
    ...messages.map((message) => `• ${summarizeMessage(locale, message)}`),
    ...(messages.some((message) => message.kind === "unknown")
      ? [t(locale, "governance.confirm-exec-unknown")]
      : []),
    t(locale, "governance.confirm-exec-3"),
  ];

  const voteSummaryLines = [
    t(locale, "governance.confirm-vote-1", {
      option: t(locale, VOTE_OPTION_KEYS[option]),
      id: proposalId,
    }),
    t(locale, "governance.confirm-vote-2"),
    // The `exec` pin, stated as a promise to the signer (§2.4).
    t(locale, "governance.confirm-vote-3"),
  ];

  const nothingOffered =
    vote.state !== "offered" && execute.state === "hidden";

  return (
    <section aria-label={t(locale, "governance.actions-title")} className="flex flex-col gap-3">
      <h2 className="text-xl font-semibold">{t(locale, "governance.actions-title")}</h2>

      {vote.state === "offered" ? (
        <div className="flex flex-col gap-3 rounded-lg border bg-card p-4">
          <h3 className="text-sm font-medium">{t(locale, "governance.vote-title")}</h3>
          <fieldset className="flex flex-col gap-2">
            <legend className="text-sm">{t(locale, "governance.vote-option-label")}</legend>
            {GOVERNANCE_VOTE_OPTION_NAMES.map((name) => (
              <label key={name} className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="vote-option"
                  value={name}
                  checked={option === name}
                  onChange={() => setOption(name)}
                />
                <span>{t(locale, VOTE_OPTION_KEYS[name])}</span>
              </label>
            ))}
          </fieldset>
          <p className="text-xs text-muted-foreground">
            {t(locale, "governance.vote-metadata-note")}
          </p>
          <div>
            <Button onClick={() => void startVote()}>{t(locale, "governance.vote-submit")}</Button>
          </div>
        </div>
      ) : vote.reason === "already-voted" ? (
        <p className="rounded-lg border bg-card p-4 text-sm" role="status">
          {t(locale, "governance.vote-already", {
            option: vote.option === undefined ? "" : vote.option,
          })}
        </p>
      ) : vote.reason === "anonymous" ? null : (
        <p className="rounded-lg border bg-card p-4 text-sm text-muted-foreground">
          {t(locale, VOTE_HIDDEN_KEYS[vote.reason] ?? "governance.actions-live-down")}
        </p>
      )}

      {execute.state === "offered" ? (
        <div className="flex flex-col gap-3 rounded-lg border border-[var(--status-critical)] bg-card p-4">
          <h3 className="text-sm font-medium">{t(locale, "governance.execute-title")}</h3>
          <p className="text-xs text-muted-foreground">
            {t(locale, "governance.execute-permissionless")}
          </p>
          <div>
            <Button onClick={() => void startExec()}>
              {t(locale, "governance.execute-submit")}
            </Button>
          </div>
        </div>
      ) : execute.state === "disabled" ? (
        // SHOWN, DISABLED, with the eligible-at time — never hidden. The user
        // needs to know it is coming.
        <div className="flex flex-col gap-2 rounded-lg border bg-card p-4">
          <h3 className="text-sm font-medium">{t(locale, "governance.execute-title")}</h3>
          <Button disabled>{t(locale, "governance.execute-submit")}</Button>
          <p className="text-xs text-muted-foreground" role="status">
            {execute.readyAtIso === null
              ? t(locale, "governance.execute-pending-unknown")
              : t(locale, "governance.execute-pending", {
                  readyAt: formatInstant(execute.readyAtIso) ?? execute.readyAtIso,
                })}
          </p>
        </div>
      ) : execute.reason === "anonymous" || execute.reason === "not-passed" ? null : (
        <p className="rounded-lg border bg-card p-4 text-sm text-muted-foreground">
          {t(locale, EXECUTE_HIDDEN_KEYS[execute.reason] ?? "governance.actions-live-down")}
        </p>
      )}

      {nothingOffered && sessionAddress === null ? (
        <p className="rounded-lg border bg-card p-4 text-sm text-muted-foreground">
          {t(locale, "governance.actions-connect")}
        </p>
      ) : null}

      {flow.state.phase === "confirm" ? (
        <TxConfirm
          locale={locale}
          plan={flow.state.plan}
          summaryLines={pending === "exec" ? executeSummaryLines : voteSummaryLines}
          feeDisplay={feeDisplay(flow.state.plan.fee.amount)}
          // Executing is the danger tier; voting is a warning. §2.6: the tier
          // reflects what the SIGNATURE does, not what the proposal is about.
          tier={pending === "exec" ? "danger" : "warning"}
          onConfirm={() => void flow.confirm()}
          onCancel={flow.cancel}
        />
      ) : (
        <FlowStatus
          locale={locale}
          state={flow.state}
          amountExponent={HASH_EXPONENT}
          onReset={flow.reset}
        />
      )}
    </section>
  );
}
