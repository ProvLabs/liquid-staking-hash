// Stake preview math (app-spec §8.3, §10.3 SwapIn). `estimate_swap_in`
// is gRPC-only (§14.2 pinned fact), so the App previews expected nvHASH out
// from the live NAV pair with the vault's own share math — floor division,
// rounding in the vault's favour (never over-promises shares), mirroring the
// contract's mint. The result is labeled an EXECUTION-TIME-RATE ESTIMATE in
// the UI (§10.3: the mint is at the execution-time rate, not this quote), and
// e2e-live cross-checks it against the real `EventSwapIn.shares_received`.
//
// Pure and dependency-free (BigInt only, no floats — spec §3 decision 8).

export type PreviewResult =
  | { ok: true; shares: bigint }
  | { ok: false; reason: "empty-vault" };

/**
 * Expected nvHASH shares for a HASH deposit at the current NAV:
 *   shares = floor(depositNhash × totalShares ÷ totalValueNhash)
 * Null-priced when the vault has no value yet (bootstrap mint is a
 * contract-internal ratio the App does not fabricate a quote for).
 */
export function previewSharesOut(
  depositNhash: bigint,
  totalShares: bigint,
  totalValueNhash: bigint,
): PreviewResult {
  if (totalValueNhash <= 0n || totalShares <= 0n) return { ok: false, reason: "empty-vault" };
  return { ok: true, shares: (depositNhash * totalShares) / totalValueNhash };
}
