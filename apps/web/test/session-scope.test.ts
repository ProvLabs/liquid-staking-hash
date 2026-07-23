// Personal-route session-scope enforcement — THE STANDING WEB CI GATE from
// PR 5.1 on (master plan §4; plan 5.1 §4.6). The acting address on a
// personal surface comes ONLY from the session; a query parameter naming
// another address must never influence it, and an anonymous request gets a
// prompt-and-explain (page) or a reasonless 401 (resource route) — never
// blank, never someone else's data.

import { secp256k1 } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha256";
import { describe, expect, it } from "vitest";

import { loadConfig } from "~/config/config.server";
import { buildAdr36SignDoc, canonicalJson, utf8ToBase64 } from "~/lib/adr36";
import { pubkeyToBech32 } from "~/lib/adr36-verify.server";
import { InMemorySessionStore } from "~/lib/models/session.server";
import { login, mintNonce, requireSession } from "~/lib/services/session.server";

const config = loadConfig({
  APP_ENV: "development",
  CHAIN_ID: "chain-dev",
  LCD_URL: "http://lcd.mock:1317",
  CONTRACT_ADDRESS: "tp14hj2tavq8fpesdwxxcu44rty3hh90vhujrvcmstl4zr3txmfvw9s96lrg8",
  VAULT_ADDRESS: "tp1xj828fwstxajpn95mq07mw0ztn449lxx65skad",
  CONSOLE_URL: "https://console.example",
  CONSOLE_CHAIN_ID: "chain-dev",
  API_URL: "http://api.mock:8787",
} as NodeJS.ProcessEnv);

const PRIV = sha256(new TextEncoder().encode("nvhash-scope-test-key"));
const PUB = secp256k1.getPublicKey(PRIV, true);
const ADDRESS = pubkeyToBech32(PUB, "tp");
const OTHER = "tp1xj828fwstxajpn95mq07mw0ztn449lxx65skad";

async function sessionCookie(store: InMemorySessionStore): Promise<string> {
  const deps = { store };
  const { nonce, challenge } = await mintNonce(config, ADDRESS, deps);
  const doc = buildAdr36SignDoc(ADDRESS, utf8ToBase64(challenge));
  const signature = Buffer.from(
    secp256k1.sign(sha256(new TextEncoder().encode(canonicalJson(doc))), PRIV).toCompactRawBytes(),
  ).toString("base64");
  const result = await login(
    config,
    { address: ADDRESS, nonce, pubkey: Buffer.from(PUB).toString("base64"), signature },
    deps,
  );
  if (!result.ok) throw new Error("login failed");
  return result.setCookie.split(";")[0]!;
}

describe("personal-route session scope (standing gate, plan §4)", () => {
  it("requireSession rejects anonymous requests with a reasonless 401", async () => {
    const store = new InMemorySessionStore();
    const request = new Request("http://app.local/portfolio");
    await expect(requireSession(config, request, { store })).rejects.toSatisfy(
      (thrown) => thrown instanceof Response && thrown.status === 401,
    );
  });

  it("resolves the SESSION address — a ?address= query param has no effect", async () => {
    const store = new InMemorySessionStore();
    const cookie = await sessionCookie(store);
    // A hostile query param naming another address: the session must win.
    const request = new Request(`http://app.local/portfolio?address=${OTHER}`, {
      headers: { Cookie: cookie },
    });
    const context = await requireSession(config, request, { store });
    expect(context.address).toBe(ADDRESS);
    expect(context.address).not.toBe(OTHER);
  });

  it("a forged cookie id resolves to no session", async () => {
    const store = new InMemorySessionStore();
    await sessionCookie(store); // real session exists for ADDRESS
    const request = new Request("http://app.local/portfolio", {
      headers: { Cookie: `nvhash_session=${"f".repeat(43)}` },
    });
    await expect(requireSession(config, request, { store })).rejects.toSatisfy(
      (thrown) => thrown instanceof Response && thrown.status === 401,
    );
  });
});
