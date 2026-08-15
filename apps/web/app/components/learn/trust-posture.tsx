import { CORPUS_CERTIFIED } from "~/chrome/certification";
import { TRUST_CONTENT } from "~/content/trust";
import { t, type Locale, type MessageKey } from "~/i18n";

// §8.1.4 security & trust posture from the §5.4 build-reviewed content
// module. Pre-audit reality renders honestly (no audit rows yet → the
// pre-audit statement, not an omitted section). No marketing adjectives:
// the console's "numbers carry the enthusiasm" rule holds here.
const RISKS: readonly MessageKey[] = [
  "learn.trust-risk-contract",
  "learn.trust-risk-slashing",
  "learn.trust-risk-bridge",
];

export function TrustPosture({ locale }: { locale: Locale }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-xl font-semibold">{t(locale, "learn.trust-title")}</h2>
      {/* Pre-certification caveat (D22, plan 8.4 §2.7.2): keyed to the
          fixture manifest status — retires only when 8.0's re-capture flips
          the manifest, never by a config flag. */}
      {/* A PLAIN paragraph, not role="status": the caveat is standing
          provenance content, not a live-region change — and the chrome's
          pristine-state contract (e2e/chrome.spec.ts) is that no status/alert
          chrome exists without a real condition. */}
      {CORPUS_CERTIFIED ? null : (
        <p
          data-certification-caveat
          className="rounded-lg border p-4 text-sm"
          style={{ borderLeft: "4px solid var(--status-warning)" }}
        >
          {t(locale, "learn.trust-certification-caveat")}
        </p>
      )}
      {TRUST_CONTENT.audits.length === 0 ? (
        <p className="rounded-lg border bg-card p-4 text-sm text-muted-foreground">
          {t(locale, "learn.trust-preaudit")}
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {TRUST_CONTENT.audits.map((audit) => (
            <li key={audit.reportUrl} className="rounded-lg border bg-card p-4 text-sm">
              <span className="font-medium">{audit.firm}</span> · {audit.scope} · {audit.date} ·{" "}
              <a
                className="underline underline-offset-4 hover:text-foreground"
                href={audit.reportUrl}
                rel="noreferrer"
                target="_blank"
              >
                {audit.coveredBuild}
              </a>
            </li>
          ))}
        </ul>
      )}
      <p className="max-w-2xl text-sm text-muted-foreground">
        {t(locale, "learn.trust-governance")}
      </p>
      <h3 className="text-base font-medium">{t(locale, "learn.trust-risk-title")}</h3>
      <ul className="flex max-w-2xl flex-col gap-2 text-sm text-muted-foreground">
        {RISKS.map((key) => (
          <li key={key} className="rounded-lg border p-3">
            {t(locale, key)}
          </li>
        ))}
      </ul>
    </section>
  );
}
