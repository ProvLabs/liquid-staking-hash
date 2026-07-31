// The redemption tracker (app-spec §8.4): queue position, live funded/queue
// state, countdown, and terminal outcomes for the connected address. Reads
// the on-chain queue, so a redemption made with any tool appears (§8.4).
// Every value is chain/API-derived (§12.1 never-lie); nothing here is
// fabricated, and a request in flight is never rendered as settled.

import { Link } from "react-router";

import { formatBaseAmount, HASH_EXPONENT, SHARE_EXPONENT } from "~/learn/amounts";
import { t, type Locale } from "~/i18n";
import type { ExitContext } from "~/exit/exit.server";

function daysUntil(iso: string, nowMs: number): number {
  return Math.max(0, Math.ceil((new Date(iso).getTime() - nowMs) / (24 * 60 * 60 * 1000)));
}

export function RedemptionTracker({
  locale,
  tracker,
  nowMs,
}: {
  locale: Locale;
  tracker: NonNullable<ExitContext["tracker"]>;
  nowMs: number;
}) {
  const { active, queue, terminal } = tracker;
  const nothing = active.length === 0 && queue.length === 0 && terminal.length === 0;

  return (
    <section className="flex flex-col gap-3" aria-label={t(locale, "exit.tracker-title")}>
      <h2 className="text-lg font-semibold">{t(locale, "exit.tracker-title")}</h2>
      {nothing ? (
        <p className="rounded-lg border bg-card p-4 text-sm text-muted-foreground">
          {t(locale, "exit.tracker-empty")}
        </p>
      ) : (
        <>
          {active.map((r) => {
            const queueEntry = queue.find((q) => q.shares === r.shares) ?? queue[0];
            return (
              <div
                key={r.request_id}
                className="flex flex-col gap-1 rounded-lg border border-[var(--status-warning)] bg-card p-4 text-sm"
              >
                <span className="font-medium">
                  {t(
                    locale,
                    r.status === "expedited" ? "exit.tracker-expedited" : "exit.tracker-enqueued",
                  )}
                </span>
                <span>
                  {t(locale, "exit.tracker-shares", {
                    shares: formatBaseAmount(BigInt(r.shares), SHARE_EXPONENT, 4),
                  })}
                </span>
                {queueEntry ? (
                  <>
                    <span className="text-muted-foreground">
                      {t(locale, "exit.tracker-queue-position", {
                        position: queueEntry.position,
                        total: queueEntry.queueLength,
                      })}
                    </span>
                    <span className="text-muted-foreground">
                      {t(locale, "exit.tracker-countdown", {
                        days: daysUntil(queueEntry.timeoutIso, nowMs),
                      })}
                    </span>
                  </>
                ) : null}
                <span className="text-xs text-muted-foreground">
                  {t(locale, "exit.tracker-expedite-note")}
                </span>
                {/* 6.2: default-on redemption alerts resolve to copy under
                    absence-means-default — the owner is covered the moment the
                    redemption exists; no subscribe write at SwapOut time. */}
                <span className="text-xs text-muted-foreground">
                  {t(locale, "exit.tracker-alert-note")}{" "}
                  <Link to="/portfolio#alert-settings" className="underline">
                    {t(locale, "exit.tracker-alert-settings-link")}
                  </Link>
                </span>
              </div>
            );
          })}

          {terminal.map((leg) => (
            <div
              key={`${leg.txhash}:${leg.msgIndex}`}
              className={`flex flex-col gap-1 rounded-lg border bg-card p-4 text-sm ${leg.kind === "redemption_refund" ? "border-[var(--status-warning)]" : "border-[var(--status-good)]"}`}
            >
              <span className="font-medium">
                {t(
                  locale,
                  leg.kind === "redemption_refund" ? "exit.tracker-refunded" : "exit.tracker-paid",
                )}
              </span>
              {leg.kind === "redemption_payout" ? (
                <span>
                  {t(locale, "exit.tracker-payout-amount", {
                    amount: formatBaseAmount(BigInt(leg.nhash), HASH_EXPONENT, 4),
                  })}
                </span>
              ) : (
                <span>
                  {t(locale, "exit.tracker-refund-shares", {
                    shares: formatBaseAmount(BigInt(leg.shares), SHARE_EXPONENT, 4),
                  })}
                </span>
              )}
              <span className="break-all font-mono text-xs text-muted-foreground">
                {leg.txhash}
              </span>
            </div>
          ))}
        </>
      )}
    </section>
  );
}
