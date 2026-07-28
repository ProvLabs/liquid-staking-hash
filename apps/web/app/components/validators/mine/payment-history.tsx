import type { OperatorPaymentRowVM } from "~/validators/mine-types";
import { t, type Locale } from "~/i18n";

// §8.6 payment history + the §14.11 operator CSV export. Two things this table
// says that no other surface can:
//
//   * WHO paid. Program payments are permissionless — "anyone, nhash attached"
//     (contract msg.rs) — so a payer that is not the operator is a normal,
//     material fact (a co-op partner, a delegator), not an anomaly. It is
//     labeled, never hidden behind the amount.
//   * WHICH epoch a payment credited, or that the crediting epoch is still
//     OPEN. An open epoch renders as "pending", never as the latest epoch —
//     services/api serves null there for exactly that reason.
//
// The export is a plain link to a resource route registered OUTSIDE the `:lang?`
// segment (the portfolio-export precedent): the browser never talks to the API
// and never sees the assertion.

export function PaymentHistory({
  locale,
  payments,
  hasMore,
  valoper,
}: {
  locale: Locale;
  payments: OperatorPaymentRowVM[];
  hasMore: boolean;
  valoper: string;
}) {
  return (
    <section aria-label={t(locale, "operator.payments-title")} className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-xl font-semibold">{t(locale, "operator.payments-title")}</h2>
        <a
          className="text-sm underline underline-offset-4"
          href={`/operator/export?valoper=${encodeURIComponent(valoper)}`}
        >
          {t(locale, "operator.export-csv")}
        </a>
      </div>

      {payments.length === 0 ? (
        <p className="rounded-lg border bg-card p-4 text-sm text-muted-foreground">
          {t(locale, "operator.payments-empty")}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[40rem] border-collapse text-sm">
            <caption className="sr-only">{t(locale, "operator.payments-title")}</caption>
            <thead>
              <tr className="border-b text-left text-xs text-muted-foreground">
                <th scope="col" className="py-2 pr-4 font-medium">
                  {t(locale, "operator.payment-time-header")}
                </th>
                <th scope="col" className="py-2 pr-4 font-medium">
                  {t(locale, "operator.payment-type-header")}
                </th>
                <th scope="col" className="py-2 pr-4 font-medium">
                  {t(locale, "operator.payment-amount-header")}
                </th>
                <th scope="col" className="py-2 pr-4 font-medium">
                  {t(locale, "operator.epoch-header")}
                </th>
                <th scope="col" className="py-2 pr-4 font-medium">
                  {t(locale, "operator.payment-payer-header")}
                </th>
                <th scope="col" className="py-2 font-medium">
                  {t(locale, "operator.payment-tx-header")}
                </th>
              </tr>
            </thead>
            <tbody>
              {payments.map((row) => (
                // `(txhash, msgIndex)` — NOT txhash+time: one tx can carry
                // several payments (paying is permissionless), and they share
                // both txhash and the per-tx block time.
                <tr key={`${row.txhash}-${row.msgIndex}`} className="border-b last:border-0">
                  <td className="py-2 pr-4 whitespace-nowrap">{row.time.slice(0, 10)}</td>
                  <td className="py-2 pr-4">
                    {t(
                      locale,
                      row.paymentType === "commission"
                        ? "operator.payment-commission"
                        : "operator.payment-tip",
                    )}
                  </td>
                  <td className="py-2 pr-4 tabular-nums">{row.amountHash}</td>
                  <td className="py-2 pr-4 tabular-nums">
                    {row.epochIndex === null
                      ? t(locale, "operator.epoch-pending")
                      : String(row.epochIndex)}
                  </td>
                  <td className="py-2 pr-4">
                    <span className="font-mono text-xs break-all">{row.payer}</span>
                    {row.paidByOther ? (
                      <span className="ml-2 text-xs text-muted-foreground">
                        {t(locale, "operator.paid-by-other")}
                      </span>
                    ) : null}
                  </td>
                  <td className="py-2">
                    {row.explorerHref === null ? (
                      <span className="font-mono text-xs">{row.txhash.slice(0, 10)}…</span>
                    ) : (
                      <a
                        className="font-mono text-xs underline underline-offset-4"
                        href={row.explorerHref}
                        rel="noreferrer"
                        target="_blank"
                      >
                        {row.txhash.slice(0, 10)}…
                      </a>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {hasMore ? (
        <p className="text-xs text-muted-foreground">{t(locale, "operator.payments-more")}</p>
      ) : null}
    </section>
  );
}
