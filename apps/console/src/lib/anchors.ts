/** A parsed entity anchor. Closed union — four kinds, exactly. */
export type Anchor =
  | { kind: "request"; id: number }
  | { kind: "validator"; valoper: string }
  | { kind: "epoch"; index: number }
  | { kind: "proposal"; id: string };

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
