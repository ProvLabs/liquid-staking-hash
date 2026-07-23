// Minimal protobuf wire primitives (app plan PR 5.2). Deliberately
// dependency-free and tiny: the App encodes exactly four message shapes
// (TxBody, AuthInfo, SignDoc, TxRaw over the two vault msgs) and decodes one
// (TxRaw, for the broadcast-relay guards) — a proto toolchain would be a
// larger supply-chain surface than the ~150 lines it replaces (SECURITY.md
// dependency posture; the console precedent).
//
// Canonical proto3 rules this encoder follows (and the byte-golden fixture
// tests PIN — a divergence from what the SDK produced fails the txhash
// goldens in test/tx-build.test.ts):
//   * fields serialized in field-number order
//   * scalar defaults (0, "", false, empty bytes) are omitted
//   * submessages length-delimited (wire type 2), varints wire type 0

export type WireValue =
  | { readonly wire: 0; readonly varint: bigint }
  | { readonly wire: 2; readonly bytes: Uint8Array };

export interface WireField {
  readonly field: number;
  readonly value: WireValue;
}

// ── Writer ───────────────────────────────────────────────────────────────

function varintBytes(value: bigint): number[] {
  if (value < 0n) throw new Error("negative varint");
  const out: number[] = [];
  let v = value;
  for (;;) {
    const septet = Number(v & 0x7fn);
    v >>= 7n;
    if (v === 0n) {
      out.push(septet);
      return out;
    }
    out.push(septet | 0x80);
  }
}

export class ProtoWriter {
  private readonly parts: number[] = [];

  /** Varint scalar; proto3 canonical: zero is omitted. */
  uint(field: number, value: bigint | number): this {
    const v = typeof value === "number" ? BigInt(value) : value;
    if (v === 0n) return this;
    this.parts.push(...varintBytes(BigInt(field << 3)), ...varintBytes(v));
    return this;
  }

  /** Length-delimited bytes; empty is omitted. */
  bytes(field: number, value: Uint8Array): this {
    if (value.length === 0) return this;
    this.parts.push(...varintBytes(BigInt((field << 3) | 2)), ...varintBytes(BigInt(value.length)));
    for (const b of value) this.parts.push(b);
    return this;
  }

  /** UTF-8 string; empty is omitted. */
  string(field: number, value: string): this {
    return this.bytes(field, new TextEncoder().encode(value));
  }

  /**
   * Submessage — length-delimited even when empty IF `alwaysEmit` (a set
   * message field is present regardless of content; an unset one is omitted
   * by simply not calling this).
   */
  message(field: number, encoded: Uint8Array, alwaysEmit = false): this {
    if (encoded.length === 0 && !alwaysEmit) return this;
    this.parts.push(...varintBytes(BigInt((field << 3) | 2)), ...varintBytes(BigInt(encoded.length)));
    for (const b of encoded) this.parts.push(b);
    return this;
  }

  finish(): Uint8Array {
    return Uint8Array.from(this.parts);
  }
}

// ── Reader ───────────────────────────────────────────────────────────────

/** Parse a message's top-level fields. Throws on truncation or wire types
 * this codebase never produces (groups, fixed32/64) — reject, not skip. */
export function readFields(bytes: Uint8Array): WireField[] {
  const fields: WireField[] = [];
  let i = 0;
  const readVarint = (): bigint => {
    let shift = 0n;
    let value = 0n;
    for (;;) {
      if (i >= bytes.length) throw new Error("truncated varint");
      const b = bytes[i]!;
      i += 1;
      value |= BigInt(b & 0x7f) << shift;
      if ((b & 0x80) === 0) return value;
      shift += 7n;
      if (shift > 63n) throw new Error("varint overflow");
    }
  };
  while (i < bytes.length) {
    const tag = readVarint();
    const field = Number(tag >> 3n);
    const wire = Number(tag & 7n);
    if (field === 0) throw new Error("field 0 is invalid");
    if (wire === 0) {
      fields.push({ field, value: { wire: 0, varint: readVarint() } });
    } else if (wire === 2) {
      const length = Number(readVarint());
      if (i + length > bytes.length) throw new Error("truncated bytes field");
      fields.push({ field, value: { wire: 2, bytes: bytes.slice(i, i + length) } });
      i += length;
    } else {
      throw new Error(`unsupported wire type ${wire}`);
    }
  }
  return fields;
}

/** All length-delimited values of `field` (repeated message/bytes/string). */
export function bytesFields(fields: WireField[], field: number): Uint8Array[] {
  return fields
    .filter((f) => f.field === field && f.value.wire === 2)
    .map((f) => (f.value as { bytes: Uint8Array }).bytes);
}

/** The single length-delimited value of `field`, or null. */
export function bytesField(fields: WireField[], field: number): Uint8Array | null {
  const all = bytesFields(fields, field);
  return all.length === 1 ? all[0]! : null;
}

export function stringField(fields: WireField[], field: number): string {
  const raw = bytesField(fields, field);
  return raw === null ? "" : new TextDecoder().decode(raw);
}
