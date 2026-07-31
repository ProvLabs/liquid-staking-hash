// Unit: the RPC / height-pinned transports, with an injected fetch (no network).
// Proves the JSON-RPC `result` unwrap, that EndBlocker events surface from
// `finalize_block_events` (where payout/refund/NAV live — never tx-search), the
// `x-cosmos-block-height` header on pinned smart queries, and error mapping.

import { describe, expect, it } from "vitest";
import { attr, coinAttr, findEvent } from "../../src/decode/attributes.ts";
import { PinnedLcdClient, RpcClient, RpcError, type RpcFetch } from "../../src/transport/rpc.ts";

interface Recorded {
  url: string;
  headers?: Record<string, string>;
}

function fakeFetch(body: unknown, ok = true, status = 200): { impl: RpcFetch; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const impl: RpcFetch = async (url, init) => {
    calls.push(init.headers === undefined ? { url } : { url, headers: init.headers });
    return { ok, status, text: async () => JSON.stringify(body) };
  };
  return { impl, calls };
}

describe("RpcClient.latestHeight", () => {
  it("reads sync_info.latest_block_height as bigint", async () => {
    const { impl, calls } = fakeFetch({ result: { sync_info: { latest_block_height: "7810" } } });
    const client = new RpcClient("http://dev-node:26657", { fetchImpl: impl });
    expect(await client.latestHeight()).toBe(7810n);
    expect(calls[0]!.url).toBe("http://dev-node:26657/status");
  });
});

describe("RpcClient.blockResults", () => {
  it("surfaces EndBlocker events from finalize_block_events, decodable by attributes", async () => {
    const { impl } = fakeFetch({
      result: {
        height: "7810",
        txs_results: [
          { events: [{ type: "wasm", attributes: [{ key: "action", value: "run_epoch" }] }] },
        ],
        finalize_block_events: [
          {
            type: "provlabs.vault.v1.EventSwapOutCompleted",
            attributes: [
              { key: "assets", value: '"36852482nhash"', index: true },
              { key: "owner", value: '"tp1owner"', index: true },
              { key: "request_id", value: '"3"', index: true },
              { key: "mode", value: "EndBlock", index: true },
            ],
          },
        ],
      },
    });
    const client = new RpcClient("http://dev-node:26657", { fetchImpl: impl });

    const block = await client.blockResults(7810n);

    expect(block.height).toBe(7810n);
    expect(block.txsResults[0]!.events[0]!.attributes[0]!.value).toBe("run_epoch");

    const completed = findEvent(
      block.finalizeBlockEvents,
      "provlabs.vault.v1.EventSwapOutCompleted",
    );
    expect(completed).toBeDefined();
    expect(attr(completed!, "request_id")).toBe("3");
    expect(coinAttr(completed!, "assets")).toEqual({ amount: 36852482n, denom: "nhash" });
  });
});

describe("RpcClient.txSearch / blockSearch", () => {
  it("quotes the query and decodes tx events + height", async () => {
    const { impl, calls } = fakeFetch({
      result: {
        total_count: "1",
        txs: [
          {
            hash: "ABCD",
            height: "42",
            tx_result: {
              events: [{ type: "wasm", attributes: [{ key: "action", value: "swap_in" }] }],
            },
          },
        ],
      },
    });
    const client = new RpcClient("http://dev-node:26657", { fetchImpl: impl });

    const page = await client.txSearch("tx.height>=1 AND tx.height<=50");

    expect(page.totalCount).toBe(1);
    expect(page.txs[0]).toMatchObject({ hash: "ABCD", height: 42n });
    expect(page.txs[0]!.events[0]!.attributes[0]!.value).toBe("swap_in");
    // The query is sent quoted (CometBFT requires it) and URL-encoded.
    const sent = new URL(calls[0]!.url);
    expect(sent.searchParams.get("query")).toBe('"tx.height>=1 AND tx.height<=50"');
    expect(sent.searchParams.get("per_page")).toBe("100");
  });

  it("extracts block heights from block_search", async () => {
    const { impl } = fakeFetch({
      result: {
        total_count: "2",
        blocks: [{ block: { header: { height: "10" } } }, { block: { header: { height: "20" } } }],
      },
    });
    const client = new RpcClient("http://dev-node:26657", { fetchImpl: impl });
    expect(await client.blockSearch("run_epoch.exists")).toEqual({
      totalCount: 2,
      heights: [10n, 20n],
    });
  });
});

describe("PinnedLcdClient.smartAtHeight", () => {
  it("sends x-cosmos-block-height and returns the envelope data", async () => {
    const { impl, calls } = fakeFetch({ data: { epoch_index: 8 } });
    const client = new PinnedLcdClient("http://dev-node:1317", { fetchImpl: impl });

    const data = await client.smartAtHeight("tp1contract", { epoch_snapshot: {} }, 7811n);

    expect(data).toEqual({ epoch_index: 8 });
    expect(calls[0]!.headers).toEqual({ "x-cosmos-block-height": "7811" });
    expect(calls[0]!.url).toContain("/cosmwasm/wasm/v1/contract/tp1contract/smart/");
  });
});

describe("error mapping", () => {
  it("maps a non-ok response to RpcError", async () => {
    const { impl } = fakeFetch({ error: "boom" }, false, 500);
    const client = new RpcClient("http://dev-node:26657", { fetchImpl: impl });
    await expect(client.latestHeight()).rejects.toBeInstanceOf(RpcError);
  });
});
