// Amount discipline (app-spec §13): every chain amount is a decimal-string
// Uint128 and is parsed to bigint at the boundary — never a JS number, which
// silently corrupts past 2^53. Parsers here REJECT anything that is not a
// canonical integer string; a value that cannot be bounded safely is an
// error, never a best-effort continue.

export const U128_MAX = (1n << 128n) - 1n;
// cosmwasm_std::Int128 domain (i128) — NOT symmetric around the Uint128 max.
export const I128_MIN = -(1n << 127n);
export const I128_MAX = (1n << 127n) - 1n;

export class DecodeError extends Error {
  constructor(
    readonly path: string,
    readonly reason: string,
    readonly value?: unknown,
  ) {
    super(`decode ${path}: ${reason}${value === undefined ? "" : ` (got ${JSON.stringify(value)})`}`);
    this.name = "DecodeError";
  }
}

const UINT_RE = /^(0|[1-9][0-9]*)$/;
const INT_RE = /^(0|-?[1-9][0-9]*)$/; // canonical: no "-0", no leading zeros

/** Canonical unsigned decimal string -> bigint, bounded to Uint128. */
export function parseUint128(value: unknown, path = "$"): bigint {
  if (typeof value !== "string" || !UINT_RE.test(value)) {
    throw new DecodeError(path, "expected canonical unsigned integer string", value);
  }
  const n = BigInt(value);
  if (n > U128_MAX) throw new DecodeError(path, "exceeds Uint128 range", value);
  return n;
}

/**
 * Signed decimal string (e.g. the snapshot's net_deposits, a
 * cosmwasm_std::Int128) -> bigint, bounded to the i128 domain.
 */
export function parseInt128(value: unknown, path = "$"): bigint {
  if (typeof value !== "string" || !INT_RE.test(value)) {
    throw new DecodeError(path, "expected canonical integer string", value);
  }
  const n = BigInt(value);
  if (n > I128_MAX || n < I128_MIN) throw new DecodeError(path, "exceeds Int128 range", value);
  return n;
}

/**
 * Unsigned integer that the chain serializes as a STRING (proto JSON uint64:
 * heights, unix seconds, account numbers, pagination totals).
 */
export function parseU64String(value: unknown, path = "$"): bigint {
  if (typeof value !== "string" || !UINT_RE.test(value)) {
    throw new DecodeError(path, "expected string-encoded uint64", value);
  }
  const n = BigInt(value);
  if (n >= 1n << 64n) throw new DecodeError(path, "exceeds uint64 range", value);
  return n;
}

/**
 * u64 the contract serializes as a JSON NUMBER (cosmwasm u64: bps, seconds,
 * counters). Bounded to safe-integer range — a bps/interval that overflows
 * 2^53 is corrupt input, not a value to round.
 */
export function parseU64Number(value: unknown, path = "$"): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new DecodeError(path, "expected non-negative safe integer", value);
  }
  return value;
}

export interface Coin {
  denom: string;
  /** base-unit amount as bigint — never a JS number */
  amount: bigint;
}

export function parseCoin(value: unknown, path = "$"): Coin {
  const o = expectObject(value, path);
  return {
    denom: expectString(o["denom"], `${path}.denom`),
    amount: parseUint128(o["amount"], `${path}.amount`),
  };
}

// --- structural helpers shared by the decoders -----------------------------

export function expectObject(value: unknown, path = "$"): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DecodeError(path, "expected object", value);
  }
  return value as Record<string, unknown>;
}

export function expectArray(value: unknown, path = "$"): unknown[] {
  if (!Array.isArray(value)) throw new DecodeError(path, "expected array", value);
  return value;
}

export function expectString(value: unknown, path = "$"): string {
  if (typeof value !== "string") throw new DecodeError(path, "expected string", value);
  return value;
}

export function expectBoolean(value: unknown, path = "$"): boolean {
  if (typeof value !== "boolean") throw new DecodeError(path, "expected boolean", value);
  return value;
}
