import { useState } from "react";

import { MAX_ACK_NOTE_LENGTH } from "@nvhash/api-types";

import type { IncidentFeedVM, IncidentRowVM, PanelState } from "~/admin/types";
import { t, type Locale } from "~/i18n";
import { PanelBody, PanelShell } from "./panel";

// §8.8 incident feed with acknowledgment (§9.6). The one WRITE behind `/admin`,
// and it writes only to the `app` schema.
//
// The affordance per row was decided in the loader (C4), not here: a closed
// incident is read-only, and one acknowledged by ANOTHER admin shows that ack
// rather than re-offering "acknowledge" as though it were unacknowledged. This
// component renders whichever affordance it was handed and nothing else — the
// rule is unit-tested at the seam, where it can be exhaustive.
//
// The note is bounded in the input as well as at the route and the column. The
// input bound is convenience; the route's is the enforcement.

function AckControls({
  locale,
  row,
  onDone,
}: {
  locale: Locale;
  row: IncidentRowVM;
  onDone: () => void;
}) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(action: "acknowledge" | "unacknowledge") {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/admin/incidents/ack", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          incident_id: row.id,
          action,
          ...(action === "acknowledge" && note.trim() !== "" ? { note } : {}),
        }),
      });
      if (!response.ok) {
        // The server's reason is shown, not a generic failure: "already
        // acknowledged" and "we could not verify your membership" call for
        // different responses from the administrator.
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? String(response.status));
        return;
      }
      onDone();
    } catch {
      setError("network");
    } finally {
      setBusy(false);
    }
  }

  if (row.affordance === "none") return null;

  return (
    <div className="mt-2 flex flex-col gap-2">
      {row.affordance === "acknowledge" ? (
        <label className="flex flex-col gap-1 text-xs">
          <span>{t(locale, "admin.ack-note-label")}</span>
          <input
            className="w-full rounded-md border bg-background px-2 py-1 text-sm"
            maxLength={MAX_ACK_NOTE_LENGTH}
            value={note}
            onChange={(event) => setNote(event.target.value)}
          />
        </label>
      ) : null}
      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            void submit(row.affordance === "acknowledge" ? "acknowledge" : "unacknowledge")
          }
          className="rounded-md border px-3 py-1 text-sm disabled:opacity-50"
        >
          {t(locale, row.affordance === "acknowledge" ? "admin.ack-action" : "admin.unack-action")}
        </button>
        {error === null ? null : (
          <span role="alert" className="text-xs text-muted-foreground">
            {t(locale, "admin.ack-failed")} ({error})
          </span>
        )}
      </div>
    </div>
  );
}

export function IncidentFeed({
  locale,
  state,
  onChanged,
}: {
  locale: Locale;
  state: PanelState<IncidentFeedVM>;
  onChanged: () => void;
}) {
  return (
    <PanelShell title={t(locale, "admin.incidents-title")}>
      <PanelBody locale={locale} state={state}>
        {({ rows, ackStateKnown }) =>
          rows.length === 0 ? (
            <p
              role="status"
              className="rounded-lg border bg-card p-4 text-sm text-muted-foreground"
            >
              {t(locale, "admin.incidents-empty")}
            </p>
          ) : (
            <>
              {/* The incidents read succeeded and the ACK read did not. Said
                  once, above the list, because every row below is affected:
                  an unmarked row here means "we do not know", not
                  "unacknowledged" — and no row offers a control. */}
              {ackStateKnown ? null : (
                <p
                  role="status"
                  className="mb-2 rounded-lg border bg-card p-3 text-sm text-muted-foreground"
                >
                  {t(locale, "admin.ack-state-unknown")}
                </p>
              )}
              <ul className="flex flex-col gap-2">
                {rows.map((row) => (
                  <li key={row.id} className="rounded-lg border bg-card p-3 text-sm">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      {/* Severity as a WORD, never colour alone. */}
                      <span className="font-medium">{row.kind}</span>
                      <span className="text-xs text-muted-foreground">{row.severity}</span>
                      <span className="text-xs text-muted-foreground">
                        {row.openedAt.slice(0, 10)}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {row.open
                          ? t(locale, "admin.incident-open")
                          : t(locale, "admin.incident-closed")}
                      </span>
                    </div>
                    {row.ack === null ? null : (
                      <p className="mt-1 text-xs text-muted-foreground">
                        {t(locale, "admin.ack-by", {
                          address: row.ack.by,
                          at: row.ack.at.slice(0, 10),
                        })}
                        {row.ack.note === null ? null : ` — ${row.ack.note}`}
                      </p>
                    )}
                    <AckControls locale={locale} row={row} onDone={onChanged} />
                  </li>
                ))}
              </ul>
            </>
          )
        }
      </PanelBody>
    </PanelShell>
  );
}
