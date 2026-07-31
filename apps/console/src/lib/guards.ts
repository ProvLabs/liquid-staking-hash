// Guard preflight (spec §10.3). Each execute computes its on-chain guard state from
// already-polled data: enabled | disabled-with-reason | hidden. The CONTRACT remains the
// enforcement boundary; preflight only prevents doomed txs and explains state (spec §12).
import { humanDuration } from "@/lib/format";
import { nextRunAt } from "@/lib/derived";
import type { ConfigResponse, EpochStatusResponse } from "@/lib/types";
import type { Role } from "@/tx/wallet";

export type GuardState =
  | { kind: "enabled" }
  | { kind: "disabled"; reason: string }
  | { kind: "hidden" };

export interface GuardInputs {
  role: Role;
  stale: boolean;
  nowSecs: number;
  config: ConfigResponse | null;
  epoch: EpochStatusResponse | null;
}

const fresh = (g: GuardInputs): GuardState | null =>
  g.stale
    ? { kind: "disabled", reason: "data stale; refusing to submit against unknown state" }
    : null;

function isReleasing(e: EpochStatusResponse | null): boolean {
  return e?.phase === "Releasing";
}

export function guardRunEpoch(g: GuardInputs): GuardState {
  if (g.epoch?.halted) return { kind: "disabled", reason: "contract halted" };
  const s = fresh(g);
  if (s) return s;
  if (isReleasing(g.epoch)) return { kind: "enabled" }; // continuation bypasses the calendar gate
  if (g.epoch) {
    const at = nextRunAt(g.epoch.last_run_seconds);
    if (g.nowSecs < at)
      return {
        kind: "disabled",
        reason: `calendar month: eligible in ${humanDuration(at - g.nowSecs)}`,
      };
  }
  return { kind: "enabled" };
}

export function guardClaimRewards(g: GuardInputs): GuardState {
  return fresh(g) ?? { kind: "enabled" };
}

export function guardServiceRedemptions(g: GuardInputs): GuardState {
  if (g.epoch?.halted) return { kind: "disabled", reason: "contract halted" };
  return fresh(g) ?? { kind: "enabled" };
}

export function guardCaptureUptime(_g: GuardInputs): GuardState {
  // Always enabled; early calls are accepted no-ops (spec §10.3).
  return { kind: "enabled" };
}

export function guardReportJailed(jailedNow: boolean): GuardState {
  if (!jailedNow)
    return {
      kind: "disabled",
      reason: "target not currently jailed (report would be a clearing no-op)",
    };
  return { kind: "enabled" };
}

export interface PurgeInputs extends GuardInputs {
  reportExists: boolean;
  purgeReadyAt: number;
  jailedNow: boolean;
  claimantEligibleAndMine?: boolean;
}
export function guardPurge(p: PurgeInputs): GuardState {
  if (!p.reportExists) return { kind: "disabled", reason: "no open jail report" };
  if (p.epoch?.halted) return { kind: "disabled", reason: "contract halted" };
  if (p.nowSecs < p.purgeReadyAt)
    return {
      kind: "disabled",
      reason: `cooldown: purge-ready in ${humanDuration(p.purgeReadyAt - p.nowSecs)}`,
    };
  if (!p.jailedNow) return { kind: "disabled", reason: "target unjailed; report will clear" };
  if (p.claimantEligibleAndMine === false)
    return { kind: "disabled", reason: "claimant must be an eligible validator you operate" };
  const s = fresh(p);
  if (s) return s;
  return { kind: "enabled" };
}

export function requireRole(have: Role, need: Role): GuardState {
  const rank: Record<Role, number> = { observer: 0, keeper: 1, operator: 2, admin: 3 };
  return rank[have] >= rank[need] ? { kind: "enabled" } : { kind: "hidden" };
}
