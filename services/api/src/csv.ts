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

import type { OperatorPaymentRow, TransactionRow } from "@nvhash/api-types";

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

/**
 * The pinned OPERATOR column set (§14.11 validator/operator export, §8.6): a
 * record of commission/TIP payment amounts and times for the operator's own tax
 * analysis. Exactly the six decided columns, in order.
 *
 * `payer` is deliberately NOT here even though the row carries it: §14.11 pins
 * this set, and payment being permissionless does not change what the decided
 * export is. The JSON view serves `payer` for the audit case; adding it to the
 * CSV would be a §14.11 amendment, not an implementation choice.
 *
 * `epoch_index` is empty when the crediting epoch has not closed yet — an empty
 * cell, never a guessed epoch (app-spec §9.1).
 *
 * The amount column is `nhash_amount`, not §14.11's proposed `hash_amount`: the
 * value served is `OperatorPaymentRow.amount`, which is nhash BASE UNITS, and a
 * column named for whole HASH holding base units reads a billion times too
 * large in the spreadsheet this export exists for. The holder export made the
 * same correction (§14.11 proposed `hash_amount`/`nvhash_amount`; it serves
 * `nhash`/`shares`), so base-unit content under a base-unit name is the
 * established convention here. Recorded as the [R4] §14.11 deviation.
 */
export const OPERATOR_PAYMENTS_CSV_COLUMNS = [
  "datetime_utc",
  "block_height",
  "epoch_index",
  "payment_type",
  "nhash_amount",
  "txhash",
] as const;

/**
 * The export's header line (terminated). Split from the row renderer so the
 * route can emit the export INCREMENTALLY as the reader's keyset stream yields
 * chunks, instead of joining the whole history into one string — a 300 000-row
 * export measured 33 MB of string on top of the rows it was built from
 * (2026-07-28 review). Header + rows concatenated is byte-identical to what
 * `operatorPaymentsCsv` produced before the split, so the pinned column gate
 * and the CSV goldens are unaffected.
 */
export function operatorPaymentsCsvHeader(): string {
  return `${OPERATOR_PAYMENTS_CSV_COLUMNS.join(",")}\n`;
}

/** Render payment rows only (no header), each line `\n`-terminated. */
export function operatorPaymentsCsvRows(rows: readonly OperatorPaymentRow[]): string {
  let out = "";
  for (const row of rows) {
    out += `${[
      row.occurred_at,
      String(row.height),
      row.epoch_index === null ? "" : String(row.epoch_index),
      row.payment_type,
      row.amount,
      row.txhash,
    ]
      .map(csvField)
      .join(",")}\n`;
  }
  return out;
}

/** Render the operator payment export (§14.11): header + one line per payment. */
export function operatorPaymentsCsv(rows: readonly OperatorPaymentRow[]): string {
  return operatorPaymentsCsvHeader() + operatorPaymentsCsvRows(rows);
}

/** The holder export's header line (terminated). Split from the row renderer
 * for the same reason as the operator export: the route streams chunk by chunk
 * rather than joining an unbounded history into one string. */
export function transactionsCsvHeader(): string {
  return `${TRANSACTIONS_CSV_COLUMNS.join(",")}\n`;
}

/** Render transaction rows only (no header), each line `\n`-terminated. */
export function transactionsCsvRows(rows: readonly TransactionRow[]): string {
  let out = "";
  for (const row of rows) {
    out += `${[
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
      .join(",")}\n`;
  }
  return out;
}

/** Render the export: header line + one line per row, `\n`-joined. */
export function transactionsCsv(rows: readonly TransactionRow[]): string {
  return transactionsCsvHeader() + transactionsCsvRows(rows);
}
