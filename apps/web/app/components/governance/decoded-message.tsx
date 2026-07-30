import { formatCoin, summarizeMessage, type DecodedMessage } from "~/governance/decode";
import { shortAddress } from "~/governance/format";
import { t, type Locale } from "~/i18n";

// §8.7's ordering, literally: a human-readable summary ABOVE the exact JSON,
// and the exact JSON present for EVERY message — known or not.
//
// The summary is whatever `decode.ts` could establish; where that is nothing, it
// says so plainly instead of guessing. This component adds no interpretation of
// its own: it renders the decoded value and the payload, and the only judgement
// it makes is which fields to surface beside the summary.
//
// Per §7 Q3 the payload is expanded on the first message and collapsed after —
// a proposal may carry up to 32, and 32 open JSON blocks is not a readable page.

export function DecodedMessageBlock({
  locale,
  message,
  index,
  total,
}: {
  locale: Locale;
  message: DecodedMessage;
  index: number;
  total: number;
}) {
  return (
    <li className="rounded-lg border bg-card p-4">
      <p className="text-xs text-muted-foreground">
        {t(locale, "governance.message-position", { index: index + 1, total })}
      </p>
      <p className="mt-1 text-sm font-semibold">{summarizeMessage(locale, message)}</p>

      <dl className="mt-2 flex flex-col gap-1 text-xs text-muted-foreground">
        <div className="flex gap-2">
          <dt>{t(locale, "governance.message-type")}</dt>
          <dd className="font-mono break-all">{message.typeUrl ?? t(locale, "governance.na")}</dd>
        </div>
        {message.kind === "program-action" ? (
          <>
            <div className="flex gap-2">
              <dt>{t(locale, "governance.message-contract")}</dt>
              <dd className="font-mono" title={message.contract}>
                {shortAddress(message.contract)}
              </dd>
            </div>
            {/* Funds are surfaced separately because for `pay_commission` and
                `pay_tip` the whole amount being paid lives here and nowhere
                else in the message. */}
            {message.funds.length > 0 ? (
              <div className="flex gap-2">
                <dt>{t(locale, "governance.message-funds")}</dt>
                <dd className="tabular-nums">{message.funds.map(formatCoin).join(", ")}</dd>
              </div>
            ) : null}
            {message.fields.map((field) => (
              <div key={field.key} className="flex gap-2">
                <dt className="font-mono">{field.key}</dt>
                <dd className="font-mono break-all">{field.value}</dd>
              </div>
            ))}
          </>
        ) : null}
      </dl>

      <details className="mt-3" open={index === 0}>
        <summary className="cursor-pointer text-xs text-muted-foreground">
          {t(locale, "governance.message-exact")}
        </summary>
        <pre className="mt-2 overflow-x-auto rounded-md border bg-background p-3 text-xs">
          <code>{message.json}</code>
        </pre>
        {message.jsonTruncated ? (
          <p className="mt-1 text-xs text-muted-foreground">
            {t(locale, "governance.message-json-truncated")}
          </p>
        ) : null}
      </details>
    </li>
  );
}

export function DecodedMessages({
  locale,
  messages,
  truncated,
}: {
  locale: Locale;
  messages: DecodedMessage[];
  truncated: boolean;
}) {
  return (
    <section aria-label={t(locale, "governance.messages-title")} className="flex flex-col gap-3">
      <h2 className="text-xl font-semibold">{t(locale, "governance.messages-title")}</h2>

      {/* Stated ABOVE the list, not below it: a reader who stops after the
          messages must already know the list is short of what was proposed. */}
      {truncated ? (
        <p role="status" className="rounded-lg border bg-card p-4 text-sm text-muted-foreground">
          {t(locale, "governance.messages-truncated")}
        </p>
      ) : null}

      {messages.length === 0 ? (
        <p className="rounded-lg border bg-card p-4 text-sm text-muted-foreground">
          {t(locale, "governance.messages-empty")}
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {messages.map((message, index) => (
            <DecodedMessageBlock
              key={index}
              locale={locale}
              message={message}
              index={index}
              total={messages.length}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
