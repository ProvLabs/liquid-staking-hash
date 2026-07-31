// Exit-context loader gate (app-spec §8.4, §12.1 never-lie): the
// comparison stat, native-flow context, and the tracker composed from three
// reads (live queue + /portfolio active + /transactions terminal), each
// degrading independently. Chain reads from the fixture corpus via MSW; API
// envelopes from the @nvhash/api-types producers.

import { envelope } from "@nvhash/api-types";
import { http, HttpResponse } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { loadConfig } from "~/config/config.server";
import { loadExitContext } from "~/exit/exit.server";
import {
  FIXTURE_CHAIN_ID,
  FIXTURE_CONTRACT_ADDRESS,
  FIXTURE_VAULT_ADDRESS,
} from "~/mocks/handlers";
import { server } from "~/mocks/node";

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const config = loadConfig({
  APP_ENV: "development",
  CHAIN_ID: FIXTURE_CHAIN_ID,
  LCD_URL: "http://lcd.mock:1317",
  CONTRACT_ADDRESS: FIXTURE_CONTRACT_ADDRESS,
  VAULT_ADDRESS: FIXTURE_VAULT_ADDRESS,
  CONSOLE_URL: "https://console.example",
  CONSOLE_CHAIN_ID: FIXTURE_CHAIN_ID,
  API_URL: "http://api.mock:8787",
  // Assertion key present so personalApiHeaders mints (portfolio/transactions).
  API_SERVICE_ASSERTION_KEY: "exit-test-assertion-key-0123456789abcdef",
} as NodeJS.ProcessEnv);

// The fixture corpus's pending-swap-outs owner (queries/vault/pending-swap-outs).
const PENDING_OWNER = "tp1rxvcuzkn0zk4nwgclw2nf2wcc5pym3fjc7y4s0";

describe("loadExitContext", () => {
  it("assembles the payout stat and native-flow vault context (anonymous)", async () => {
    const ctx = await loadExitContext(config, null);
    expect(ctx.payout).not.toBeNull();
    expect(ctx.payout!.cold_start).toBe(true); // default MSW honest cold-start
    expect(ctx.vault).not.toBeNull();
    expect(ctx.vault!.swapOutEnabled).toBe(true);
    expect(ctx.tracker).toBeNull(); // no address → no personal reads
  });

  it("shows the sample-sufficient typical when the API serves it", async () => {
    server.use(
      http.get("*/api/v1/redemptions/stats", () =>
        HttpResponse.json(
          envelope(
            {
              sample_count: 15,
              median_seconds: 26 * 86400,
              p90_seconds: 31 * 86400,
              band_floor_seconds: 21 * 86400,
              band_ceiling_seconds: 60 * 86400,
              cold_start: false,
            },
            { source: "indexed" },
          ),
        ),
      ),
    );
    const ctx = await loadExitContext(config, null);
    expect(ctx.payout!.median_seconds).toBe(26 * 86400);
    expect(ctx.payout!.cold_start).toBe(false);
  });

  it("composes the tracker: active (portfolio) + queue (chain) + terminal (transactions)", async () => {
    server.use(
      // A populated on-chain queue (the corpus fixture is empty) with the
      // connected owner at position 2 of 2.
      http.get("*/vault/v1/vaults/:id/pending_swap_outs", () =>
        HttpResponse.json({
          pending_swap_outs: [
            {
              pending_swap_out: {
                owner: "tp1someoneelse000000000000000000000000000",
                vault_address: FIXTURE_VAULT_ADDRESS,
                shares: { denom: "nvhash", amount: "9000000000000000" },
                redeem_denom: "",
              },
              timeout: "2026-09-01T00:00:00Z",
            },
            {
              pending_swap_out: {
                owner: PENDING_OWNER,
                vault_address: FIXTURE_VAULT_ADDRESS,
                shares: { denom: "nvhash", amount: "5000000000000000" },
                redeem_denom: "",
              },
              timeout: "2026-08-15T00:00:00Z",
            },
          ],
          pagination: { next_key: null, total: "2" },
        }),
      ),
      http.get("*/api/v1/portfolio", ({ request }) =>
        HttpResponse.json(
          envelope(
            {
              address: new URL(request.url).searchParams.get("address") ?? "",
              first_activity_at: "2026-06-01T00:00:00Z",
              transaction_count: 3,
              escrowed_shares: "5000000000000000",
              active_redemptions: [
                {
                  request_id: "req-a",
                  shares: "5000000000000000",
                  status: "enqueued",
                  enqueued_at: "2026-07-01T00:00:00Z",
                  expedited_at: null,
                  matured_at: null,
                  refunded_at: null,
                  last_height: 100,
                  last_txhash: "AA",
                },
              ],
            },
            { source: "indexed" },
          ),
        ),
      ),
      http.get("*/api/v1/transactions", () =>
        HttpResponse.json(
          envelope(
            [
              {
                txhash: "PAID",
                msg_index: 0,
                kind: "redemption_payout",
                shares: "1000000000000000",
                nhash: "1000000000",
                nav_at_height: "1.0",
                height: 90,
                block_time: "2026-06-20T00:00:00Z",
              },
              {
                txhash: "REF",
                msg_index: 0,
                kind: "redemption_refund",
                shares: "2000000000000000",
                nhash: "0",
                nav_at_height: "1.0",
                height: 80,
                block_time: "2026-06-10T00:00:00Z",
              },
              {
                txhash: "DEP",
                msg_index: 0,
                kind: "swap_in",
                shares: "3000000000000000",
                nhash: "3000000000",
                nav_at_height: "1.0",
                height: 70,
                block_time: "2026-06-01T00:00:00Z",
              },
            ],
            { source: "indexed" },
          ),
        ),
      ),
    );
    const ctx = await loadExitContext(config, PENDING_OWNER);
    expect(ctx.tracker).not.toBeNull();
    expect(ctx.tracker!.active.map((r) => r.request_id)).toEqual(["req-a"]);
    // The owner is at position 2 of the injected 2-entry queue.
    expect(ctx.tracker!.queue).toHaveLength(1);
    expect(ctx.tracker!.queue[0]!.position).toBe(2);
    expect(ctx.tracker!.queue[0]!.queueLength).toBe(2);
    expect(ctx.tracker!.queue[0]!.timeoutIso).toBe("2026-08-15T00:00:00Z");
    // Only the two terminal legs surface — the swap_in is excluded — and each
    // carries its (txhash, msgIndex) row identity (one tx can hold several
    // redemption legs; the tracker keys on the pair).
    expect(
      ctx
        .tracker!.terminal.map((t) => ({ kind: t.kind, txhash: t.txhash, msgIndex: t.msgIndex }))
        .sort((a, b) => a.kind.localeCompare(b.kind)),
    ).toEqual([
      { kind: "redemption_payout", txhash: "PAID", msgIndex: 0 },
      { kind: "redemption_refund", txhash: "REF", msgIndex: 0 },
    ]);
  });

  it("degrades to payout:null when the stats API is unreachable (guarantee still stands upstream)", async () => {
    server.use(
      http.get("*/api/v1/redemptions/stats", () =>
        HttpResponse.json({ error: "down" }, { status: 503 }),
      ),
    );
    const ctx = await loadExitContext(config, null);
    expect(ctx.payout).toBeNull();
    expect(ctx.vault).not.toBeNull(); // independent read still resolves
  });

  it("degrades vault to null on a failed vault read, never fabricating", async () => {
    server.use(
      http.get("*/vault/v1/vaults/:id", () =>
        HttpResponse.json({ code: 2, message: "down", details: [] }, { status: 503 }),
      ),
    );
    const ctx = await loadExitContext(config, null);
    expect(ctx.vault).toBeNull();
  });
});
