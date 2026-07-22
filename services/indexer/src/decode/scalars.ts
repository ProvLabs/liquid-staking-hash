// Scalar decoders for smart-query JSON payloads (epoch snapshot, APR, and — in
// PR 2.3 — validators). The canonical versions live in
// packages/chain-client/src/amounts.ts, but the indexer runs raw `.ts` on Node
// and cannot import that package at runtime (Node refuses to type-strip a `.ts`
// under node_modules — `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`). This minimal mirror
// keeps the indexer's runtime dependency surface at zero (SECURITY.md supply
// chain) while decoding to the same discipline: every amount is a bigint, never
// a JS number that would corrupt past 2^53.

import { DecodeError, parseU128 } from "./attributes.ts";

/** Canonical unsigned Uint128 -> bigint. Accepts `unknown` (smart-query JSON
 * values) and validates it is a canonical integer string via `parseU128`. */
export function parseUint128(value: unknown, path = "$"): bigint {
  if (typeof value !== "string") throw new DecodeError(path, "expected Uint128 string", value);
  return parseU128(value, path);
}

const INT_RE = /^(0|-?[1-9][0-9]*)$/; // canonical: no "-0", no leading zeros
const I128_MIN = -(1n << 127n);
const I128_MAX = (1n << 127n) - 1n;

/** Signed Int128 decimal string (e.g. snapshot net_deposits) -> bigint. */
export function parseInt128(value: unknown, path = "$"): bigint {
  if (typeof value !== "string" || !INT_RE.test(value)) {
    throw new DecodeError(path, "expected canonical integer string", value);
  }
  const n = BigInt(value);
  if (n > I128_MAX || n < I128_MIN) throw new DecodeError(path, "exceeds Int128 range", value);
  return n;
}

/** A contract u64 the chain serializes as a JSON NUMBER (bps, seconds, counts,
 * epoch index). Bounded to the safe-integer range — an overflow is corrupt
 * input, not a value to round. */
export function parseU64Number(value: unknown, path = "$"): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new DecodeError(path, "expected non-negative safe integer", value);
  }
  return value;
}

export function expectObject(value: unknown, path = "$"): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DecodeError(path, "expected object", value);
  }
  return value as Record<string, unknown>;
}

export function expectString(value: unknown, path = "$"): string {
  if (typeof value !== "string") throw new DecodeError(path, "expected string", value);
  return value;
}

export function expectArray(value: unknown, path = "$"): unknown[] {
  if (!Array.isArray(value)) throw new DecodeError(path, "expected array", value);
  return value;
}
