// Entity-anchor grammar (console-spec §14 item 9, the console-side record of
// app-spec §14.13). The grammar is a SPEC RECORD shared with apps/web's
// verify-link tests by golden strings — the two codebases cannot share code
// (the console is outside the pnpm workspace, ADR-001 Decision 4), so both
// suites pin the same strings and drift fails whichever side moved. Extending
// the union is a spec amendment, not a helper.

/** A parsed entity anchor. Closed union — four kinds, exactly. */
export type Anchor =
  | { kind: "request"; id: number }
  | { kind: "validator"; valoper: string }
  | { kind: "epoch"; index: number }
  | { kind: "proposal"; id: string };

/**
 * Parse a URL fragment (without the leading `#`) into an anchor.
 *
 * Takes the whole fragment or nothing: a fragment that is not exactly one
 * well-formed anchor returns null (unknown-fragment tolerance — a plain page,
 * never an error). Numeric ids must be unsigned decimals within the safe
 * integer range; the proposal id stays a decimal string (u64 on chain).
 */
export function parseAnchor(fragment: string): Anchor | null {
  const req = fragment.match(/^req-(\d{1,15})$/);
  if (req) return { kind: "request", id: Number(req[1]) };
  const val = fragment.match(/^val-([a-z][a-z0-9]{7,89})$/);
  if (val) return { kind: "validator", valoper: val[1] };
  const epoch = fragment.match(/^epoch-(\d{1,15})$/);
  if (epoch) return { kind: "epoch", index: Number(epoch[1]) };
  const prop = fragment.match(/^prop-(\d{1,20})$/);
  if (prop) return { kind: "proposal", id: prop[1] };
  return null;
}

/** Format an anchor as its URL fragment, leading `#` included. */
export function formatAnchor(a: Anchor): string {
  switch (a.kind) {
    case "request":
      return `#req-${a.id}`;
    case "validator":
      return `#val-${a.valoper}`;
    case "epoch":
      return `#epoch-${a.index}`;
    case "proposal":
      return `#prop-${a.id}`;
  }
}

/** The DOM element id an anchor lands on (the fragment without `#`). */
export function anchorDomId(a: Anchor): string {
  return formatAnchor(a).slice(1);
}

/**
 * The anchor-miss notice copy — a first-class honesty surface (§2.1): shown
 * only when the owning read SUCCEEDED and the entity is absent, with the
 * entity-specific reason. Silence would read as "nothing to verify" or
 * "verified fine" depending on the visitor's prior.
 */
export function anchorMissNotice(a: Anchor, extra?: { ledgerCoverage?: string }): string {
  switch (a.kind) {
    case "request":
      return `The chain's queue no longer holds request #${a.id} (paid out, refunded, or never existed).`;
    case "validator":
      return `No enrolled validator ${a.valoper} (unregistered or never enrolled).`;
    case "epoch":
      return `This browser's ledger has no epoch #${a.index} — history accrues per browser${
        extra?.ledgerCoverage ? ` (${extra.ledgerCoverage} in this browser)` : ""
      }.`;
    case "proposal":
      return `The chain retains only live proposals; executed and rejected proposals are pruned — durable history is the App's governance record.`;
  }
}
