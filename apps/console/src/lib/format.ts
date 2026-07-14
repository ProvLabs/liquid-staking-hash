// Display formatting. All amount math is BigInt; conversion (nhash->HASH, bps->%)
// is floor-formatted at render time only (spec Decision 8, §9.5). No float on amounts.
import { config } from "@/config";

export function toBig(v: string | number | bigint | null | undefined): bigint {
  if (v === null || v === undefined || v === "") return 0n;
  if (typeof v === "bigint") return v;
  try {
    return BigInt(typeof v === "number" ? Math.trunc(v) : v.split(".")[0]);
  } catch {
    return 0n;
  }
}

const DENOM = 10n ** BigInt(config.denomExponent); // 1e9
const SHARE = 10n ** BigInt(config.shareExponent); // 1e15

// Floor a scaled bigint to `decimals` places with locale grouping on the integer part.
function fmtScaled(value: bigint, scale: bigint, decimals: number): string {
  const neg = value < 0n;
  const abs = neg ? -value : value;
  const whole = abs / scale;
  const frac = abs % scale;
  const grouped = whole.toLocaleString("en-US");
  let out = grouped;
  if (decimals > 0) {
    // scale has (exponent) digits; take the leading `decimals` of the fraction
    const scaleDigits = scale.toString().length - 1;
    const fracStr = frac.toString().padStart(scaleDigits, "0").slice(0, decimals);
    out = `${grouped}.${fracStr}`;
  }
  return neg ? `-${out}` : out;
}

/** nhash -> HASH string (default 2 decimals). */
export function hash(nhash: string | bigint, decimals = 2): string {
  return fmtScaled(toBig(nhash), DENOM, decimals);
}
/** nhash -> "1,234.56 HASH". */
export function hashUnit(nhash: string | bigint, decimals = 2): string {
  return `${hash(nhash, decimals)} ${config.displayDenom}`;
}
/** base shares (nvhash) -> whole nvHASH string. */
export function shares(nvhash: string | bigint, decimals = 2): string {
  return fmtScaled(toBig(nvhash), SHARE, decimals);
}

/** bps -> "8.41 %" (2 decimals). */
export function pct(bps: number, decimals = 2): string {
  return `${(bps / 100).toFixed(decimals)} %`;
}

/** Truncate an address middle: pb1abc...xyz9. */
export function truncAddr(a: string, head = 8, tail = 4): string {
  if (!a || a.length <= head + tail + 1) return a;
  return `${a.slice(0, head)}…${a.slice(-tail)}`;
}

/** Humanize a duration in seconds: "3d 2h", "27d", "5m 12s". */
export function humanDuration(secs: number): string {
  if (secs < 0) secs = 0;
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  if (d > 0) return h > 0 ? `${d}d ${h}h` : `${d}d`;
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

/** "3d 2h ago" relative to now (seconds since epoch). */
export function relTime(unixSecs: number, nowSecs: number): string {
  const delta = nowSecs - unixSecs;
  if (delta < 0) return "in the future";
  return `${humanDuration(delta)} ago`;
}

/** Absolute local time for tooltips. */
export function absTime(unixSecs: number): string {
  return new Date(unixSecs * 1000).toLocaleString();
}

/** Fraction (0..1) of a as a share of b, for proportion bars. Safe on zero. */
export function ratio(a: bigint, b: bigint): number {
  if (b <= 0n) return 0;
  // scale to 1e6 to keep precision, then to float for layout only
  return Number((a * 1_000_000n) / b) / 1_000_000;
}
