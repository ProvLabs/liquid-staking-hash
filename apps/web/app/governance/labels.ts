// Closed label maps for the governance enums. TOTAL over each wire union, so a
// status or outcome the union gains is a type error here rather than a blank
// cell on the page.
//
// `unspecified` has a label of its own in every map. It is the honest landing
// place for a value a later chain upgrade adds, and "Unrecognized status" is a
// far better thing to render than an empty table cell that reads as "none".

import type { GovExecutorResult, GovProposalStatus, GovVoteOption } from "@nvhash/api-types";

import type { MessageKey } from "~/i18n";

export const STATUS_KEYS = {
  submitted: "governance.status-submitted",
  accepted: "governance.status-accepted",
  rejected: "governance.status-rejected",
  aborted: "governance.status-aborted",
  withdrawn: "governance.status-withdrawn",
  unspecified: "governance.status-unspecified",
} as const satisfies Record<GovProposalStatus, MessageKey>;

export const EXECUTOR_KEYS = {
  not_run: "governance.executor-not-run",
  success: "governance.executor-success",
  failure: "governance.executor-failure",
  unspecified: "governance.executor-unspecified",
} as const satisfies Record<GovExecutorResult, MessageKey>;

export const VOTE_OPTION_KEYS = {
  yes: "governance.vote-yes",
  no: "governance.vote-no",
  abstain: "governance.vote-abstain",
  no_with_veto: "governance.vote-no-with-veto",
  unspecified: "governance.vote-unspecified",
} as const satisfies Record<GovVoteOption, MessageKey>;
