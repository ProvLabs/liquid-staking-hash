import { Link } from "react-router";

import { DecodedMessages } from "~/components/governance/decoded-message";
import { MemberStatusTable } from "~/components/governance/member-status-table";
import { OutcomeHistory } from "~/components/governance/outcome-history";
import { ProposalActions } from "~/components/governance/proposal-actions";
import { ProposalHeader } from "~/components/governance/proposal-header";
import { TallyPanel } from "~/components/governance/tally-panel";
import { getBootedConfig } from "~/config/config.server";
import { executeAffordance, voteAffordance } from "~/governance/actions";
import { loadGovernanceProposalData } from "~/governance/governance.server";
import { parseProposalIdParam } from "~/governance/params";
import { getSessionContext } from "~/lib/services/session.server";
import { t } from "~/i18n";
import { useLocale } from "~/root";
import type { Route } from "./+types/governance.$proposalId";

export function meta(_: Route.MetaArgs) {
  return [{ title: "Proposal · nvHASH" }];
}

/**
 * One proposal (§8.7 detail). PUBLIC READ, loader + gating only.
 *
 * The id is bounded at this boundary as a canonical u64 decimal string —
 * malformed is a 400, not a clamp — and an id neither plane holds is a 404,
 * because "no record of this proposal" and "this proposal is empty" are
 * different answers.
 *
 * NO verify link is rendered anywhere on this page (D8): the console has no
 * governance panel, and a pruned proposal has nothing left on chain to link to.
 */
export async function loader({ params, request }: Route.LoaderArgs) {
  const config = await getBootedConfig();
  const proposalId = parseProposalIdParam(params.proposalId);
  const session = await getSessionContext(config, request);
  const data = await loadGovernanceProposalData(config, proposalId, {
    sessionAddress: session?.address ?? null,
  });
  if (data === null) throw new Response("proposal not found", { status: 404 });

  // The affordance decision happens HERE, in the loader, over the LIVE plane —
  // not in JSX. That is what makes it table-drivable
  // (`test/governance-flows.test.ts` runs one case per row) and what keeps
  // "actions offered against a state they cannot operate on" from recurring.
  const affordanceInput = {
    live: data.proposal.liveState,
    pruned: data.proposal.pruned,
    membershipChanged: data.proposal.membershipChanged,
    sessionAddress: session?.address ?? null,
    isMember: data.proposal.sessionIsMember,
    hasVoted: data.proposal.sessionVote !== null,
    votedOption: data.proposal.sessionVote?.option ?? null,
    nowMs: Date.now(),
  };
  return {
    data,
    // The session's OWN address, which the client already knows. This route
    // stays a PUBLIC read — it uses `getSessionContext` and never the
    // session-requiring loader helper, so it does not join the personal-route
    // list (the standing session-scope gate). The address is used to BUILD the
    // user's own transaction, never to key a read.
    sessionAddress: session?.address ?? null,
    contractAddress: config.contractAddress,
    vote: voteAffordance(affordanceInput),
    execute: executeAffordance(affordanceInput),
  };
}

export default function GovernanceProposal({ loaderData }: Route.ComponentProps) {
  const locale = useLocale();
  const { proposal } = loaderData.data;
  const { vote, execute, contractAddress } = loaderData;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-6 py-12">
      <Link className="text-sm underline underline-offset-4" to="/governance">
        ← {t(locale, "governance.back-to-list")}
      </Link>

      <ProposalHeader locale={locale} proposal={proposal} />

      <ProposalActions
        locale={locale}
        proposalId={proposal.proposalId}
        sessionAddress={loaderData.sessionAddress}
        vote={vote}
        execute={execute}
        messages={proposal.messages}
        contractAddress={contractAddress}
      />

      <TallyPanel locale={locale} tally={proposal.tally} />
      <MemberStatusTable locale={locale} status={proposal.memberStatus} />
      <OutcomeHistory locale={locale} votes={proposal.votes} truncated={proposal.votesTruncated} />
      <DecodedMessages
        locale={locale}
        messages={proposal.messages}
        truncated={proposal.messagesTruncated}
      />
    </div>
  );
}
