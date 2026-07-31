// Event-attribute decoding — the ONE place the pinned "extra JSON-string
// quoting layer" fact lives (fixture corpus, packages/fixtures/manifest.json:
// "vault event attribute values are JSON-encoded strings (one extra quoting
// layer)"). Every worker decode path goes through here so a change to that
// quirk is a one-line, one-test change, never a scatter of ad-hoc `.slice`s.
//
// Attribute VALUES in tx-search results and in block_results
// `finalize_block_events` arrive as plain strings, but the vault module's
// values carry an extra JSON-string layer (`"nvhash"`, `"36852482nhash"`,
// `"3"`), while cosmos-sdk values (`mode = EndBlock`) are bare. `dequote`
// tolerates both.
//
// Amount discipline (app-spec §13): coin amounts parse to `bigint`, never a JS
// number. The canonical parsers live in packages/chain-client/src/amounts.ts;
// the minimal subset needed here is duplicated deliberately so the indexer's
// runtime keeps a zero cross-package dependency surface (SECURITY.md supply
// chain) — the shared package is a browser/bundler consumer, this is raw Node.

/** A single Tendermint event attribute (`{ key, value, index }`). */
export interface RawAttribute {
  readonly key: string;
  readonly value: string;
  readonly index?: boolean;
}

/** A Tendermint event: a typed bag of attributes. */
export interface RawEvent {
  readonly type: string;
  readonly attributes: readonly RawAttribute[];
}

export class DecodeError extends Error {
  constructor(
    readonly path: string,
    readonly reason: string,
    readonly value?: unknown,
  ) {
    super(
      `decode ${path}: ${reason}${value === undefined ? "" : ` (got ${JSON.stringify(value)})`}`,
    );
    this.name = "DecodeError";
  }
}

/** base-unit coin amount as bigint plus its denom — never a JS number. */
export interface Coin {
  readonly denom: string;
  readonly amount: bigint;
}

const U128_MAX = (1n << 128n) - 1n;
const UINT_RE = /^(0|[1-9][0-9]*)$/;
// amount then denom, e.g. `36852482nhash`; denom per the SDK coin grammar.
const COIN_RE = /^(0|[1-9][0-9]*)([a-zA-Z][a-zA-Z0-9/:._-]*)$/;

/**
 * Strip one JSON-string quoting layer if present, else return the value
 * unchanged. `"nvhash"` -> `nvhash`; `"3"` -> `3`; bare `EndBlock` -> `EndBlock`.
 * Only unwraps when the result is itself a string, so a bare token that merely
 * looks numeric is never coerced.
 */
export function dequote(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (typeof parsed === "string") return parsed;
    } catch {
      // not valid JSON — fall through and treat as a bare value
    }
  }
  return value;
}

/** Canonical unsigned decimal string -> bigint, bounded to Uint128. */
export function parseU128(value: string, path = "$"): bigint {
  if (!UINT_RE.test(value)) {
    throw new DecodeError(path, "expected canonical unsigned integer string", value);
  }
  const n = BigInt(value);
  if (n > U128_MAX) throw new DecodeError(path, "exceeds Uint128 range", value);
  return n;
}

/** Parse an SDK coin string (`<amount><denom>`) into `{ amount, denom }`. */
export function parseCoinString(value: string, path = "$"): Coin {
  const m = COIN_RE.exec(value);
  if (m === null) throw new DecodeError(path, "expected <amount><denom> coin string", value);
  return { amount: parseU128(m[1]!, path), denom: m[2]! };
}

/** Every event of a given type, in emission order. */
export function findEvents(events: readonly RawEvent[], type: string): RawEvent[] {
  return events.filter((e) => e.type === type);
}

/** The first event of a given type, or `undefined`. */
export function findEvent(events: readonly RawEvent[], type: string): RawEvent | undefined {
  return events.find((e) => e.type === type);
}

/** Required attribute value (de-quoted). Throws if the key is absent. */
export function attr(event: RawEvent, key: string): string {
  const found = event.attributes.find((a) => a.key === key);
  if (found === undefined) throw new DecodeError(`${event.type}.${key}`, "attribute not present");
  return dequote(found.value);
}

/** Optional attribute value (de-quoted), or `undefined` if absent. */
export function optionalAttr(event: RawEvent, key: string): string | undefined {
  const found = event.attributes.find((a) => a.key === key);
  return found === undefined ? undefined : dequote(found.value);
}

/** Required coin-valued attribute -> `{ amount, denom }`. */
export function coinAttr(event: RawEvent, key: string): Coin {
  return parseCoinString(attr(event, key), `${event.type}.${key}`);
}
