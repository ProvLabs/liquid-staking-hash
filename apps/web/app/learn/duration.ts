// Coarse human durations for window labels and program age (display only;
// never used in amount math). Pure and client-safe.

const MINUTE = 60;
const HOUR = 3_600;
const DAY = 86_400;

/** "42 minutes" / "8 hours" / "26 days": one coarse unit, truncated. */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "n/a";
  if (seconds < HOUR) {
    const minutes = Math.floor(seconds / MINUTE);
    return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  }
  if (seconds < 2 * DAY) {
    const hours = Math.floor(seconds / HOUR);
    return `${hours} hour${hours === 1 ? "" : "s"}`;
  }
  const days = Math.floor(seconds / DAY);
  return `${days} day${days === 1 ? "" : "s"}`;
}

/** Age of an ISO timestamp relative to `nowMs`, as a coarse duration. */
export function formatAgeSince(iso: string, nowMs: number): string {
  const started = Date.parse(iso);
  if (!Number.isFinite(started)) return "n/a";
  return formatDuration(Math.max(0, (nowMs - started) / 1_000));
}
