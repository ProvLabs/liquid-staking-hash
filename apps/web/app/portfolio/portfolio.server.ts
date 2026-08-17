// Portfolio-page data assembly (plan; app-spec §8.2, §9.5, §14.11).
// Two planes composed honestly. The LIVE plane (the canonical chain read:
// vault TVV/shares plus the address's on-chain share balance) prices the
// position; the INDEXED plane (services/api, address-scoped assertion) carries
// cost basis, realized gain, effective yield, accrual series, redemptions, and
// the paginated history. Every read degrades to null independently (the
// market.server.ts pattern) and the loader NEVER throws, except the internal
// `page` invariant, which the route zod-bounds before calling.
//
// Amounts are BigInt end-to-end; floats appear only at the accrual chart-point
// mapping (app-spec §9.5 render-time conversion). The acting address is the
// SESSION address only (standing session-scope gate); no query param is read.

import { BankClient, LcdClient, VaultClient, type FetchLike } from "@nvhash/chain-client";

import {
  fetchApiJson,
  portfolioEnvelopeSchema,
  portfolioMetricsEnvelopeSchema,
  transactionsEnvelopeSchema,
} from "~/api/api.server";
import { completenessOf } from "~/api/completeness";
import { CHROME_READ_TIMEOUT_MS } from "~/chrome/chrome.server";
import type { WebConfig } from "~/config/config.server";
import { formatBaseAmount, HASH_EXPONENT, navHashPerShare, SHARE_EXPONENT } from "~/learn/amounts";
import { personalApiHeaders } from "~/lib/services/assertion.server";
import { requireSession, type SessionDeps } from "~/lib/services/session.server";
import type {
  AccrualVM,
  HistoryPageVM,
  PortfolioData,
  PortfolioPlane,
  PositionSummaryVM,
  RedemptionVM,
} from "./types";

export type { PortfolioData } from "./types";

/** Indexed history page size (app-spec §8.2 paginated view). */
export const HISTORY_PAGE_SIZE = 50;

// ── Composition (pure, BigInt-only) ────────────────────────────────────────

export interface LivePlaneInput {
  /** On-chain share balance of the address (bank read). */
  balanceShares: bigint;
  /** Total vault value in nhash base units. */
  tvv: bigint;
  /** Total shares outstanding, nvHASH base units. */
  totalShares: bigint;
}

export interface IndexedPlaneInput {
  indexedShareBalance: bigint;
  escrowedShares: bigint;
  heldBasis: bigint | null;
  escrowBasis: bigint | null;
  realizedGain: bigint | null;
  historyState: "complete" | "has_transfers" | "inconsistent";
  /** Last accrual point value in nhash, the indexed-plane fallback price. */
  fallbackValueNhash: bigint | null;
}

export interface ComposedPosition {
  valuePlane: PortfolioPlane;
  balanceShares: bigint | null;
  currentValueNhash: bigint | null;
  costBasisNhash: bigint | null;
  accruedGainNhash: bigint | null;
  realizedGainNhash: bigint | null;
  divergent: boolean;
  historyState: "complete" | "has_transfers" | "inconsistent" | null;
}

/**
 * Compose the position from the two planes. Live prices held + escrowed shares
 * at TVV/shares (floor); when the live plane is unavailable it falls back to
 * the last indexed accrual value. Basis-derived figures populate whenever the
 * indexed history supplied them (the FLAGS carry divergence / history state;
 * no silent nulling beyond what the API already nulled on `inconsistent`).
 */
export function composePosition(
  live: LivePlaneInput | null,
  indexed: IndexedPlaneInput | null,
): ComposedPosition {
  const escrow = indexed?.escrowedShares ?? 0n;
  const livePriceable = live !== null && live.totalShares > 0n;

  let valuePlane: PortfolioPlane;
  let balanceShares: bigint | null;
  let currentValueNhash: bigint | null;
  if (livePriceable) {
    valuePlane = "live";
    balanceShares = live.balanceShares;
    currentValueNhash = ((live.balanceShares + escrow) * live.tvv) / live.totalShares;
  } else if (indexed !== null) {
    valuePlane = "indexed";
    balanceShares = indexed.indexedShareBalance;
    currentValueNhash = indexed.fallbackValueNhash;
  } else if (live !== null) {
    // Live read succeeded but the vault holds no shares (no NAV to price at).
    valuePlane = "live";
    balanceShares = live.balanceShares;
    currentValueNhash = null;
  } else {
    return {
      valuePlane: null,
      balanceShares: null,
      currentValueNhash: null,
      costBasisNhash: null,
      accruedGainNhash: null,
      realizedGainNhash: null,
      divergent: false,
      historyState: null,
    };
  }

  const basisKnown = indexed !== null && indexed.heldBasis !== null && indexed.escrowBasis !== null;
  const costBasisNhash = basisKnown ? indexed.heldBasis! + indexed.escrowBasis! : null;
  const realizedGainNhash = indexed?.realizedGain ?? null;
  const accruedGainNhash =
    currentValueNhash !== null && costBasisNhash !== null && realizedGainNhash !== null
      ? currentValueNhash - costBasisNhash + realizedGainNhash
      : null;

  const divergent =
    live !== null && indexed !== null && live.balanceShares !== indexed.indexedShareBalance;

  return {
    valuePlane,
    balanceShares,
    currentValueNhash,
    costBasisNhash,
    accruedGainNhash,
    realizedGainNhash,
    divergent,
    historyState: indexed?.historyState ?? null,
  };
}

// ── Loader ─────────────────────────────────────────────────────────────────

export interface PortfolioSession {
  address: string;
}

/**
 * Assemble the Portfolio page's data for one request. Never throws (each read
 * degrades to null independently); asserts only the caller-supplied `page`
 * invariant, which the route zod-bounds upstream.
 */
export async function loadPortfolioData(
  config: WebConfig,
  session: PortfolioSession,
  page: number,
  fetchImpl?: FetchLike,
): Promise<PortfolioData> {
  if (!Number.isInteger(page) || page < 0) {
    throw new RangeError(`page must be a non-negative integer, got ${page}`);
  }
  const doFetch: FetchLike = fetchImpl ?? ((url, init) => fetch(url, init));
  const lcd = new LcdClient(config.lcdUrl, {
    fetchImpl: doFetch,
    timeoutMs: CHROME_READ_TIMEOUT_MS,
  });
  const vault = new VaultClient(lcd);
  const bank = new BankClient(lcd);
  const apiBase = config.apiUrl.replace(/\/+$/, "");
  const headers = personalApiHeaders(config, session.address);
  const authFetch: FetchLike | null =
    headers === null ? null : (url, init) => doFetch(url, { ...init, headers });
  const addr = encodeURIComponent(session.address);

  const [live, summaryEnv, metricsEnv, txEnv] = await Promise.all([
    (async (): Promise<LivePlaneInput | null> => {
      const state = await vault.getVault(config.vaultAddress);
      const shareDenom = state.vault.totalShares.denom;
      const balance = await bank.balance(session.address, shareDenom);
      return {
        balanceShares: balance.amount,
        tvv: state.totalVaultValue.amount,
        totalShares: state.vault.totalShares.amount,
      };
    })().catch(() => null),
    authFetch === null
      ? Promise.resolve(null)
      : fetchApiJson(
          `${apiBase}/api/v1/portfolio?address=${addr}`,
          authFetch,
          CHROME_READ_TIMEOUT_MS,
        )
          .then((body) => portfolioEnvelopeSchema.parse(body))
          .catch(() => null),
    authFetch === null
      ? Promise.resolve(null)
      : fetchApiJson(
          `${apiBase}/api/v1/portfolio/metrics?address=${addr}`,
          authFetch,
          CHROME_READ_TIMEOUT_MS,
        )
          .then((body) => portfolioMetricsEnvelopeSchema.parse(body))
          .catch(() => null),
    authFetch === null
      ? Promise.resolve(null)
      : fetchApiJson(
          `${apiBase}/api/v1/transactions?address=${addr}&limit=${HISTORY_PAGE_SIZE}&offset=${page * HISTORY_PAGE_SIZE}`,
          authFetch,
          CHROME_READ_TIMEOUT_MS,
        )
          .then((body) => transactionsEnvelopeSchema.parse(body))
          .catch(() => null),
  ]);

  const metrics = metricsEnv?.data ?? null;
  const indexed: IndexedPlaneInput | null =
    metrics === null
      ? null
      : {
          indexedShareBalance: BigInt(metrics.indexed_share_balance),
          escrowedShares: BigInt(metrics.escrowed_share_balance),
          heldBasis: metrics.cost_basis_nhash === null ? null : BigInt(metrics.cost_basis_nhash),
          escrowBasis:
            metrics.escrowed_basis_nhash === null ? null : BigInt(metrics.escrowed_basis_nhash),
          realizedGain:
            metrics.realized_gain_nhash === null ? null : BigInt(metrics.realized_gain_nhash),
          historyState: metrics.history_state,
          fallbackValueNhash:
            metrics.accrual.length === 0
              ? null
              : BigInt(metrics.accrual[metrics.accrual.length - 1]!.value_nhash),
        };

  const composed = composePosition(live, indexed);
  const liveNav =
    live !== null && live.totalShares > 0n ? navHashPerShare(live.tvv, live.totalShares) : null;

  const summary: PositionSummaryVM = {
    balanceHash:
      composed.balanceShares === null
        ? null
        : formatBaseAmount(composed.balanceShares, SHARE_EXPONENT, 6),
    currentValueHash:
      composed.currentValueNhash === null
        ? null
        : formatBaseAmount(composed.currentValueNhash, HASH_EXPONENT, 4),
    valuePlane: composed.valuePlane,
    currentNav: liveNav,
    accruedGainHash:
      composed.accruedGainNhash === null
        ? null
        : formatBaseAmount(composed.accruedGainNhash, HASH_EXPONENT, 4),
    costBasisHash:
      composed.costBasisNhash === null
        ? null
        : formatBaseAmount(composed.costBasisNhash, HASH_EXPONENT, 4),
    realizedGainHash:
      composed.realizedGainNhash === null
        ? null
        : formatBaseAmount(composed.realizedGainNhash, HASH_EXPONENT, 4),
    basisIsAid: true,
    divergent: composed.divergent,
    historyState: composed.historyState,
  };

  const accrual: AccrualVM | null =
    metrics === null
      ? null
      : {
          points: metrics.accrual.map((p) => ({
            time: p.time,
            // Plottable HASH value; float confined to the chart mapping (§9.5).
            valueHash: Number(formatBaseAmount(BigInt(p.value_nhash), HASH_EXPONENT, 4)),
          })),
          markers: metrics.accrual_markers.map((m) => ({
            time: m.time,
            txhash: m.txhash,
            kind: m.kind,
            sharesDisplay: formatBaseAmount(BigInt(m.shares), SHARE_EXPONENT, 6),
            nhashDisplay: formatBaseAmount(BigInt(m.nhash), HASH_EXPONENT, 4),
          })),
          truncated: metrics.markers_truncated,
          historyTruncated: metrics.accrual_truncated,
        };

  const activeRedemptions: RedemptionVM[] = (summaryEnv?.data.active_redemptions ?? []).map(
    (r) => ({
      requestId: r.request_id,
      sharesDisplay: formatBaseAmount(BigInt(r.shares), SHARE_EXPONENT, 6),
      status: r.status,
      enqueuedAt: r.enqueued_at,
      statusTimestamps: {
        expeditedAt: r.expedited_at,
        maturedAt: r.matured_at,
        refundedAt: r.refunded_at,
      },
    }),
  );

  const history: HistoryPageVM | null =
    txEnv === null
      ? null
      : {
          rows: txEnv.data.map((row) => ({
            time: row.block_time,
            kind: row.kind,
            sharesDisplay: formatBaseAmount(BigInt(row.shares), SHARE_EXPONENT, 6),
            nhashDisplay: formatBaseAmount(BigInt(row.nhash), HASH_EXPONENT, 4),
            navDisplay: row.nav_at_height,
            txhash: row.txhash,
            explorerHref: explorerHref(config, row.txhash),
          })),
          page,
          pageSize: HISTORY_PAGE_SIZE,
          hasMore: txEnv.data.length === HISTORY_PAGE_SIZE,
        };

  return {
    address: session.address,
    summary,
    effectiveAprBps: metrics?.effective_apr_bps ?? null,
    yieldByEpoch: (metrics?.yield_by_epoch ?? []).map((p) => ({
      epochIndex: p.epoch_index,
      endedAt: p.ended_at,
      personalAprBps: p.personal_apr_bps,
      netAprBps: p.net_apr_bps,
    })),
    yieldTruncated: metrics?.yield_truncated ?? false,
    accrual,
    activeRedemptions,
    // Tri-state, never a defaulted boolean: an unavailable /portfolio read
    // (summaryEnv null) and an older API that ships no flag both land on
    // "unknown" — the panel then makes no completeness claim.
    activeRedemptionsCompleteness: completenessOf(summaryEnv?.data.active_redemptions_truncated),
    firstActivityAt: summaryEnv?.data.first_activity_at ?? null,
    history,
    personalReadsAvailable: headers !== null && (summaryEnv !== null || metricsEnv !== null),
    freshness: metricsEnv?.meta ?? summaryEnv?.meta ?? txEnv?.meta ?? null,
  };
}

/** Verify-link to the configured explorer, or null when none is configured. */
export function explorerHref(config: WebConfig, txhash: string): string | null {
  return config.explorerUrl ? `${config.explorerUrl.replace(/\/$/, "")}/tx/${txhash}` : null;
}

// ── CSV export proxy ─────────────────────────────────────────────────────────

/** Upstream headers forwarded verbatim (content + [R3] freshness). */
const FORWARDED_EXPORT_HEADERS = [
  "content-type",
  "content-disposition",
  "x-chain-height",
  "x-indexed-height",
  "x-generated-at",
] as const;

/**
 * Defensive headers SET on the proxied response (2026-07-28 review). services/api
 * applies these to every response it serves, including the CSV
 * (`handler.ts` merges them onto the raw Response) — but this proxy rebuilds the
 * header set from an allowlist, which silently dropped all three. The body is a
 * personal statement of fact, so it must not be stored by a shared cache or
 * content-type sniffed. SET rather than forwarded: the guarantee should not
 * depend on the upstream remembering.
 */
function withDefensiveHeaders(headers: Headers): Headers {
  headers.set("cache-control", "no-store");
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", "no-referrer");
  return headers;
}

export interface ExportDeps {
  /** Native fetch (the proxy forwards the streamed body + freshness headers). */
  fetchImpl?: typeof fetch;
  sessionOverride?: Partial<SessionDeps>;
}

/**
 * Proxy the FULL-history CSV export for the SESSION address (§14.11). Anonymous
 * requests get requireSession's 401; a missing minting key degrades to 503
 * (honest "unavailable", never a fabricated empty file). The session address is
 * the only input (query params are ignored), so no address can be spoofed.
 */
export async function exportTransactionsCsv(
  config: WebConfig,
  request: Request,
  deps: ExportDeps = {},
): Promise<Response> {
  const session = await requireSession(config, request, deps.sessionOverride);
  const headers = personalApiHeaders(config, session.address);
  if (headers === null) {
    return Response.json({ error: "export unavailable" }, { status: 503 });
  }
  const doFetch = deps.fetchImpl ?? fetch;
  const apiBase = config.apiUrl.replace(/\/+$/, "");
  const url = `${apiBase}/api/v1/transactions?address=${encodeURIComponent(session.address)}&format=csv`;

  const upstream = await doFetch(url, { headers });
  const forwarded = new Headers();
  for (const name of FORWARDED_EXPORT_HEADERS) {
    const value = upstream.headers.get(name);
    if (value !== null) forwarded.set(name, value);
  }
  return new Response(upstream.body, {
    status: upstream.status,
    headers: withDefensiveHeaders(forwarded),
  });
}
