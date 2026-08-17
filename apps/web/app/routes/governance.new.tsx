// `/governance/new` — the template composer (app-spec §8.7).
//
// MEMBER-GATED, and gated on THREE states before any form renders, the
// `/validators/mine` pattern: anonymous (connect prompt), the live plane
// unresolved (an explicit "we could not check" — the App never renders a
// privileged surface from a failed read), and connected non-member. Only then
// is the composer offered.
//
// The gate is a COURTESY, not the security boundary. A non-member who composed
// a proposal anyway would be rejected by preflight, by the relay guard's
// condition 2, and finally by the group module. SECURITY.md: UI guards are
// convenience; the enforcement boundary is elsewhere.

import { useState } from "react";
import { Link } from "react-router";

import { ConfigDiff } from "~/components/governance/config-diff";
import { TemplateForm } from "~/components/governance/template-form";
import { Button } from "~/components/ui/button";
import { getBootedConfig } from "~/config/config.server";
import {
  configDiffRows,
  defaultWireValues,
  describeTemplateError,
  parseTemplateValues,
  templateById,
  templateSummaryKey,
  type WireTemplateValues,
} from "~/governance/templates";
import { loadLiveGovernance } from "~/lib/services/governance.server";
import { getSessionContext } from "~/lib/services/session.server";
import { NvhashContractClient, LcdClient } from "@nvhash/chain-client";
import {
  MAX_PROPOSAL_METADATA_LEN,
  MAX_PROPOSAL_SUMMARY_LEN,
  MAX_PROPOSAL_TITLE_LEN,
} from "@nvhash/api-types";
import { t } from "~/i18n";
import { useLocale } from "~/root";
import { HASH_EXPONENT } from "~/learn/amounts";
import { TxConfirm } from "~/tx/confirm";
import { FlowStatus, feeDisplay } from "~/tx/flow-status";
import { useTxFlow } from "~/tx/use-tx-flow";
import type { Route } from "./+types/governance.new";

export function meta(_: Route.MetaArgs) {
  return [{ title: "New proposal · nvHASH" }];
}

/** The composer's gate state, decided in the LOADER so it is unit-testable
 * rather than a condition in JSX (the `/validators/mine` rule). */
export type ComposerGate =
  | { kind: "anonymous" }
  | { kind: "not-governed" }
  | { kind: "unavailable" }
  | { kind: "not-member" }
  | { kind: "ready"; sessionAddress: string; policies: { address: string; metadata: string }[] };

export async function loader({ request }: Route.LoaderArgs) {
  const config = await getBootedConfig();
  const session = await getSessionContext(config, request);
  if (session === null) {
    return {
      gate: { kind: "anonymous" } as ComposerGate,
      currentConfig: null,
      contractAddress: "",
    };
  }

  const live = await loadLiveGovernance(config);
  if (live.state === "not-governed") {
    return {
      gate: { kind: "not-governed" } as ComposerGate,
      currentConfig: null,
      contractAddress: "",
    };
  }
  if (live.state === "unavailable" || live.members === null) {
    // "We could not check" is a different sentence from "you are not a member",
    // and only one of them may be shown to an actual member.
    return {
      gate: { kind: "unavailable" } as ComposerGate,
      currentConfig: null,
      contractAddress: "",
    };
  }
  if (!live.members.some((member) => member.address === session.address)) {
    return {
      gate: { kind: "not-member" } as ComposerGate,
      currentConfig: null,
      contractAddress: "",
    };
  }

  // The live `Config {}` read feeds the diff's CURRENT column. A failed read
  // leaves every current value null and the diff says "could not be read" —
  // never 0, which on a bps field reads as a real setting.
  const currentConfig = await new NvhashContractClient(
    new LcdClient(config.lcdUrl),
    config.contractAddress,
  )
    .config()
    .then((c) => ({
      max_delegations_per_run: c.maxDelegationsPerRun.toString(),
      aum_fee_bps: c.aumFeeBps.toString(),
      performance_threshold_bps: c.performanceThresholdBps.toString(),
      min_capture_interval_secs: c.minCaptureIntervalSecs.toString(),
      max_concentration_multiple_bps: c.maxConcentrationMultipleBps.toString(),
      min_bonded_cap_bps: c.minBondedCapBps.toString(),
      max_bonded_cap_bps: c.maxBondedCapBps.toString(),
      concentration_safety_offset_bps: c.concentrationSafetyOffsetBps.toString(),
      commission_bps: c.commissionBps.toString(),
      jail_unbond_delay_secs: c.jailUnbondDelaySecs.toString(),
      // Omitted when the deployed build predates the field: the diff's
      // current column then renders the honest "could not be read" gap.
      ...(c.redemptionMarginBps === null
        ? {}
        : { redemption_margin_bps: c.redemptionMarginBps.toString() }),
    }))
    .catch(() => null);

  return {
    gate: {
      kind: "ready",
      // The proposer, taken from the SESSION and never from client input — the
      // standing session-scope rule, and the relay re-checks it over the signed
      // bytes anyway (guard condition 2).
      sessionAddress: session.address,
      policies: live.policies.map((policy) => ({
        address: policy.address,
        metadata: policy.metadata,
      })),
    } as ComposerGate,
    currentConfig,
    contractAddress: config.contractAddress,
  };
}

export default function GovernanceNew({ loaderData }: Route.ComponentProps) {
  const locale = useLocale();
  const { gate, currentConfig, contractAddress } = loaderData;

  const shell = (body: React.ReactNode) => (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-6 py-12">
      <Link className="text-sm underline underline-offset-4" to="/governance">
        ← {t(locale, "governance.back-to-list")}
      </Link>
      <h1 className="text-2xl font-semibold">{t(locale, "governance.new-title")}</h1>
      <p className="text-sm text-muted-foreground">{t(locale, "governance.new-lede")}</p>
      {body}
    </div>
  );

  if (gate.kind === "anonymous") {
    return shell(
      <p className="rounded-lg border bg-card p-4 text-sm">
        {t(locale, "governance.new-connect")}
      </p>,
    );
  }
  if (gate.kind === "not-governed") {
    return shell(
      <p className="rounded-lg border bg-card p-4 text-sm">
        {t(locale, "governance.new-not-governed")}
      </p>,
    );
  }
  if (gate.kind === "unavailable") {
    return shell(
      <p
        className="rounded-lg border border-[var(--status-warning)] bg-card p-4 text-sm"
        role="alert"
      >
        {t(locale, "governance.new-unavailable")}
      </p>,
    );
  }
  if (gate.kind === "not-member") {
    return shell(
      <p className="rounded-lg border bg-card p-4 text-sm">
        {t(locale, "governance.new-not-member")}
      </p>,
    );
  }

  return shell(
    <Composer
      sessionAddress={gate.sessionAddress}
      policies={gate.policies}
      currentConfig={currentConfig}
      contractAddress={contractAddress}
    />,
  );
}

function Composer({
  sessionAddress,
  policies,
  currentConfig,
  contractAddress,
}: {
  sessionAddress: string;
  policies: { address: string; metadata: string }[];
  currentConfig: Record<string, string> | null;
  contractAddress: string;
}) {
  const locale = useLocale();
  const flow = useTxFlow();
  const [policyAddress, setPolicyAddress] = useState(policies[0]?.address ?? "");
  const [templateId, setTemplateId] = useState("update_config");
  const [values, setValues] = useState<WireTemplateValues>(() =>
    defaultWireValues("update_config"),
  );
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [metadata, setMetadata] = useState("");
  const [submitted, setSubmitted] = useState(false);

  const parsed = parseTemplateValues(templateId, values);
  const fieldErrors: Record<string, string> = {};
  let formError: string | null = null;
  if (!parsed.ok) {
    for (const error of parsed.errors) {
      if ("key" in error) fieldErrors[error.key] = describeTemplateError(error);
      else formError = describeTemplateError(error);
    }
  }

  const ready =
    parsed.ok && policyAddress !== "" && title.trim().length > 0 && summary.trim().length > 0;

  const template = templateById(templateId);
  const diffRows =
    templateId === "update_config" && parsed.ok
      ? configDiffRows(
          parsed.values,
          Object.fromEntries(
            Object.entries(currentConfig ?? {}).map(([key, value]) => [key, BigInt(value)]),
          ),
        )
      : null;

  const start = async () => {
    if (!parsed.ok) return;
    await flow.begin(
      {
        kind: "gov_submit",
        policyAddress,
        templateId,
        values: parsed.values,
        title: title.trim(),
        summary: summary.trim(),
        metadata: metadata.trim(),
      },
      sessionAddress,
      contractAddress,
    );
  };

  const summaryKey = parsed.ok ? templateSummaryKey(templateId, parsed.values) : null;
  const confirmLines = [
    t(locale, "governance.confirm-submit-1", {
      summary: summaryKey === null ? "" : t(locale, summaryKey.key, summaryKey.params),
    }),
    ...(template?.summaryKeys ?? []).map((key) => t(locale, key)),
    // DANGER TIER, FRAMED ACCURATELY (§2.6): submitting is not itself the
    // dangerous act — passage and execution are — and the confirmation says so
    // without using that framing to soften the disclosure.
    t(locale, "governance.confirm-submit-2"),
    // Submission is NOT idempotent. A second signature creates a
    // SECOND proposal, which is a real hazard rather than a duplicate row.
    t(locale, "governance.confirm-submit-3"),
  ];

  return (
    <div className="flex flex-col gap-4">
      {policies.length > 1 ? (
        <label className="flex flex-col gap-1 text-sm">
          <span>{t(locale, "governance.new-policy-label")}</span>
          <select
            className="w-full rounded-md border bg-background px-3 py-2 text-sm"
            value={policyAddress}
            onChange={(event) => setPolicyAddress(event.target.value)}
          >
            {policies.map((policy) => (
              <option key={policy.address} value={policy.address}>
                {policy.metadata === "" ? policy.address : `${policy.metadata} — ${policy.address}`}
              </option>
            ))}
          </select>
        </label>
      ) : null}

      <TemplateForm
        locale={locale}
        templateId={templateId}
        onTemplateChange={setTemplateId}
        values={values}
        onValuesChange={setValues}
        errors={fieldErrors}
      />

      {formError === null ? null : (
        // Critical color rides the border: as text-xs it fails 4.5:1 on the
        // dark card.
        <p
          className="rounded border border-[var(--status-critical)] px-2 py-1 text-xs"
          role="alert"
        >
          {formError}
        </p>
      )}

      {diffRows === null ? null : <ConfigDiff locale={locale} rows={diffRows} />}

      <div className="flex flex-col gap-3 rounded-lg border bg-card p-4">
        <label className="flex flex-col gap-1 text-sm">
          <span>{t(locale, "governance.compose-title-label")}</span>
          <input
            className="w-full rounded-md border bg-background px-3 py-2 text-sm"
            maxLength={MAX_PROPOSAL_TITLE_LEN}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span>{t(locale, "governance.compose-summary-label")}</span>
          <textarea
            className="w-full rounded-md border bg-background px-3 py-2 text-sm"
            maxLength={MAX_PROPOSAL_SUMMARY_LEN}
            rows={3}
            value={summary}
            onChange={(event) => setSummary(event.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span>{t(locale, "governance.compose-metadata-label")}</span>
          <textarea
            className="w-full rounded-md border bg-background px-3 py-2 text-sm"
            maxLength={MAX_PROPOSAL_METADATA_LEN}
            rows={2}
            value={metadata}
            onChange={(event) => setMetadata(event.target.value)}
          />
        </label>
        <p className="text-xs text-muted-foreground">
          {t(locale, "governance.compose-public-note")}
        </p>
        <div>
          {/* Re-submit is disabled after broadcast: signing twice
              creates two separate proposals, not one. */}
          <Button onClick={() => void start()} disabled={!ready || submitted}>
            {t(locale, "governance.new-submit")}
          </Button>
        </div>
        {submitted ? (
          <p className="text-xs" role="status">
            {t(locale, "governance.submitted-note")}
          </p>
        ) : null}
      </div>

      {flow.state.phase === "confirm" ? (
        <TxConfirm
          locale={locale}
          plan={flow.state.plan}
          summaryLines={confirmLines}
          feeDisplay={feeDisplay(flow.state.plan.fee.amount)}
          tier="danger"
          onConfirm={() => {
            setSubmitted(true);
            void flow.confirm();
          }}
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
    </div>
  );
}
