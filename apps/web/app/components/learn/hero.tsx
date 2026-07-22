import { t, type Locale, type MessageKey } from "~/i18n";

// §8.1.1 hero + mechanism explainer. Stepwise honesty is IN the first
// explanation (register E4): the step note is part of the hero, not a
// footnote. The pipeline diagram is a static inline SVG whose arrow pulse is
// CSS-only and disabled by the global prefers-reduced-motion rule (§11).
const FLOW_STEPS: ReadonlyArray<{ key: MessageKey }> = [
  { key: "learn.flow-deposit" },
  { key: "learn.flow-pool" },
  { key: "learn.flow-stake" },
  { key: "learn.flow-rewards" },
];

export function Hero({ locale }: { locale: Locale }) {
  return (
    <section className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <h1 className="text-4xl font-semibold tracking-tight">{t(locale, "home.title")}</h1>
        <p className="max-w-2xl text-lg text-muted-foreground">{t(locale, "home.lede")}</p>
        <p className="max-w-2xl text-sm text-muted-foreground">
          {t(locale, "learn.hero-step-note")}
        </p>
      </div>
      <figure
        role="img"
        aria-label={t(locale, "learn.flow-label")}
        className="rounded-lg border bg-card p-4"
      >
        <div className="flex flex-wrap items-center gap-2 text-sm">
          {FLOW_STEPS.map((step, index) => (
            <span key={step.key} className="flex items-center gap-2">
              <span className="rounded-md border px-2.5 py-1.5">{t(locale, step.key)}</span>
              {index < FLOW_STEPS.length - 1 ? (
                <svg
                  aria-hidden="true"
                  focusable="false"
                  viewBox="0 0 16 16"
                  className="flow-pulse h-3.5 w-3.5 shrink-0"
                  style={{ fill: "var(--primary)", animationDelay: `${index * 0.4}s` }}
                >
                  <path d="M2 7h9.2L8.1 3.9 9.5 2.5 15 8l-5.5 5.5-1.4-1.4L11.2 9H2V7Z" />
                </svg>
              ) : null}
            </span>
          ))}
        </div>
      </figure>
    </section>
  );
}
