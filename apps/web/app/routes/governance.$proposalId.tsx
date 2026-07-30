import { Link } from "react-router";

import { DecodedMessages } from "~/components/governance/decoded-message";
import { MemberStatusTable } from "~/components/governance/member-status-table";
import { OutcomeHistory } from "~/components/governance/outcome-history";
import { ProposalHeader } from "~/components/governance/proposal-header";
import { TallyPanel } from "~/components/governance/tally-panel";
import { getBootedConfig } from "~/config/config.server";
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
  return { data };
}

export default function GovernanceProposal({ loaderData }: Route.ComponentProps) {
  const locale = useLocale();
  const { proposal } = loaderData.data;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-6 py-12">
      <Link className="text-sm underline underline-offset-4" to="/governance">
        ← {t(locale, "governance.back-to-list")}
      </Link>

      <ProposalHeader locale={locale} proposal={proposal} />

      {/* Read-only, on every state in the C4 matrix. 7.3–7.4 adds the actions,
          and inherits that matrix as the set of states each one is decided
          against. */}
      <p className="text-sm text-muted-foreground">{t(locale, "governance.read-only-note")}</p>

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
