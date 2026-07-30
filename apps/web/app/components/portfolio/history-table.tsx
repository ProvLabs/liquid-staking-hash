import { Link } from "react-router";

import { t, type Locale, type MessageKey } from "~/i18n";
import type { HistoryPageVM } from "~/portfolio/types";

// §8.2 transaction history: the set-table convention over the
// address's indexed events. Amounts are tabular-nums BigInt-formatted
// strings; the txhash links to the configured explorer when one exists, else
// renders as a plain truncated hash (no fabricated verify target). Pagination
// rides ?page= links (session address unaffected). The CSV export is a plain
// anchor to the session-gated proxy (anonymous users never reach this body).
// Alert settings are a recorded 6.2 deferral, not an empty shell.

const KIND_LABEL: Record<string, MessageKey> = {
  swap_in: "portfolio.kind-swap-in",
  swap_out_request: "portfolio.kind-swap-out-request",
  redemption_payout: "portfolio.kind-redemption-payout",
  redemption_refund: "portfolio.kind-redemption-refund",
  transfer_in: "portfolio.kind-transfer-in",
  transfer_out: "portfolio.kind-transfer-out",
};

function truncateHash(hash: string): string {
  return hash.length <= 16 ? hash : `${hash.slice(0, 8)}…${hash.slice(-4)}`;
}

function dateOf(iso: string): string {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : iso;
}

export function HistoryTable({ locale, history }: { locale: Locale; history: HistoryPageVM }) {
  const { rows, page, hasMore } = history;
  return (
    <section aria-label={t(locale, "portfolio.history-title")} className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-xl font-semibold">{t(locale, "portfolio.history-title")}</h2>
        <a
          href="/portfolio/export"
          className="rounded-md border px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground"
        >
          {t(locale, "portfolio.history-export")}
        </a>
      </div>

      {rows.length === 0 ? (
        <p className="rounded-lg border bg-card p-4 text-sm text-muted-foreground">
          {t(locale, "portfolio.history-empty")}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-xs text-muted-foreground">
                <th className="px-3 py-2 font-medium">{t(locale, "portfolio.history-col-time")}</th>
                <th className="px-3 py-2 font-medium">{t(locale, "portfolio.history-col-kind")}</th>
                <th className="px-3 py-2 font-medium">{t(locale, "portfolio.history-col-shares")}</th>
                <th className="px-3 py-2 font-medium">{t(locale, "portfolio.history-col-hash")}</th>
                <th className="px-3 py-2 font-medium">{t(locale, "portfolio.history-col-nav")}</th>
                <th className="px-3 py-2 font-medium">{t(locale, "portfolio.history-col-tx")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={`${row.txhash}-${row.time}`} className="border-b last:border-b-0">
                  <td className="px-3 py-2">{dateOf(row.time)}</td>
                  <td className="px-3 py-2">
                    {row.kind in KIND_LABEL ? t(locale, KIND_LABEL[row.kind]!) : row.kind}
                  </td>
                  <td className="px-3 py-2 tabular-nums">{row.sharesDisplay}</td>
                  <td className="px-3 py-2 tabular-nums">{row.nhashDisplay}</td>
                  <td className="px-3 py-2 tabular-nums">{row.navDisplay}</td>
                  <td className="px-3 py-2 font-mono text-xs">
                    {row.explorerHref !== null ? (
                      <a
                        href={row.explorerHref}
                        target="_blank"
                        rel="noreferrer"
                        className="text-primary hover:underline"
                      >
                        {t(locale, "portfolio.history-explorer")}
                      </a>
                    ) : (
                      truncateHash(row.txhash)
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {(page > 0 || hasMore) && (
        <div className="flex items-center justify-between gap-2">
          {page > 0 ? (
            <Link
              to={`?page=${page - 1}`}
              className="rounded-md border px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground"
            >
              {t(locale, "portfolio.history-prev")}
            </Link>
          ) : (
            <span />
          )}
          <span className="text-xs text-muted-foreground">
            {t(locale, "portfolio.history-page", { page: page + 1 })}
          </span>
          {hasMore ? (
            <Link
              to={`?page=${page + 1}`}
              className="rounded-md border px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground"
            >
              {t(locale, "portfolio.history-next")}
            </Link>
          ) : (
            <span />
          )}
        </div>
      )}

      <section aria-label={t(locale, "portfolio.alerts-title")} className="flex flex-col gap-1">
        <h3 className="text-base font-medium">{t(locale, "portfolio.alerts-title")}</h3>
        <p className="text-xs text-muted-foreground">{t(locale, "portfolio.alerts-deferred")}</p>
      </section>
    </section>
  );
}
