// The badge mapping for the testnet profile (plan 8.4 §2.7.1 / §7.1 Q5): the
// pilot's APP_ENV=testnet must actually produce the LOUD badge with the
// testnet chain-id rendered — asserted here at the component level, and
// against the deployed build by the live lane's badge case (never assumed
// from devnet behavior).
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { EnvBadge } from "~/components/chrome/env-badge";

describe("environment badge (§8.0: quiet on production, loud everywhere else)", () => {
  it("testnet is LOUD: warning-tinted with the label and the chain id", () => {
    const html = renderToString(
      createElement(EnvBadge, { locale: "en", appEnv: "testnet", chainId: "pio-testnet-1" }),
    );
    expect(html).toContain("testnet");
    expect(html).toContain("pio-testnet-1");
    expect(html).toContain("--status-warning");
  });

  it("production is quiet: chain id only, no warning tint", () => {
    const html = renderToString(
      createElement(EnvBadge, { locale: "en", appEnv: "production", chainId: "pio-mainnet-1" }),
    );
    expect(html).toContain("pio-mainnet-1");
    expect(html).not.toContain("--status-warning");
  });

  it("the closed APP_ENV set is development | testnet | production (Q5: staging replaced)", async () => {
    const { readFileSync } = await import("node:fs");
    const client = readFileSync(new URL("../app/config/client.ts", import.meta.url), "utf8");
    expect(client).toContain('"development" | "testnet" | "production"');
    expect(client).not.toContain("staging");
  });
});
