// CSV export for `/transactions?format=csv` (app plan §4: "CSV column set"
// is a tested contract; app-spec §14.11: the export is a statement of fact —
// raw per-event rows with the NAV at each event — never a computed tax
// position). Pure functions; the route builds the Response.
//
// A CSV body cannot carry the JSON freshness envelope, so freshness rides in
// response headers (X-Chain-Height / X-Indexed-Height / X-Generated-At) —
// the [R3] recorded deviation in the app-spec §9.4 revision note.
//
// Injection guard: a field beginning with = + - @ (or tab/CR) is prefixed
// with a single quote so spreadsheet applications never interpret it as a
// formula. Every field this export serves is numeric/enum/hash/ISO-time —
// the guard is defensive depth, not a load-bearing sanitizer.

import type { TransactionRow } from "@nvhash/api-types";

/** The pinned column set (plan §4 gate; §14.11 holder export). */
export const TRANSACTIONS_CSV_COLUMNS = [
  "datetime_utc",
  "block_height",
  "txhash",
  "msg_index",
  "kind",
  "shares",
  "nhash",
  "nav_at_height",
] as const;

const FORMULA_LEADS = new Set(["=", "+", "-", "@", "\t", "\r"]);

/** Escape one CSV field: formula-injection guard, then RFC-4180 quoting. */
export function csvField(value: string): string {
  const first = value.charAt(0);
  const guarded = FORMULA_LEADS.has(first) ? `'${value}` : value;
  if (/[",\n\r]/.test(guarded)) {
    return `"${guarded.replaceAll('"', '""')}"`;
  }
  return guarded;
}

/** Render the export: header line + one line per row, `\n`-joined. */
export function transactionsCsv(rows: readonly TransactionRow[]): string {
  const lines = [TRANSACTIONS_CSV_COLUMNS.join(",")];
  for (const row of rows) {
    lines.push(
      [
        row.block_time,
        String(row.height),
        row.txhash,
        String(row.msg_index),
        row.kind,
        row.shares,
        row.nhash,
        row.nav_at_height,
      ]
        .map(csvField)
        .join(","),
    );
  }
  return `${lines.join("\n")}\n`;
}
