// Session gates (–4.4): cookie properties, single-use nonces
// (replay → 401-shaped failure), ADR-36 verification correctness, absolute +
// sliding expiry, logout-destroys-row. Runs entirely on the in-memory store
// with an injected clock — Postgres-free, deterministic.
//
// The "wallet" here is a throwaway in-test secp256k1 key (SECURITY.md dev
// rule: test material only; it signs nothing but fabricated challenges).

import { secp256k1 } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha256";
import { describe, expect, it } from "vitest";

import { loadConfig } from "~/config/config.server";
import { buildAdr36SignDoc, canonicalJson, loginChallenge, utf8ToBase64 } from "~/lib/adr36";
import { pubkeyToBech32, verifyAdr36 } from "~/lib/adr36-verify.server";
import { InMemorySessionStore } from "~/lib/models/session.server";
import {
  getSessionContext,
  login,
  logout,
  mintNonce,
  NONCE_TTL_SECONDS,
  SESSION_ABSOLUTE_TTL_SECONDS,
  sessionIdFromCookieHeader,
} from "~/lib/services/session.server";

const BASE_ENV = {
  APP_ENV: "development",
  CHAIN_ID: "chain-dev",
  LCD_URL: "http://lcd.mock:1317",
  CONTRACT_ADDRESS: "tp14hj2tavq8fpesdwxxcu44rty3hh90vhujrvcmstl4zr3txmfvw9s96lrg8",
  VAULT_ADDRESS: "tp1xj828fwstxajpn95mq07mw0ztn449lxx65skad",
  CONSOLE_URL: "https://console.example",
  CONSOLE_CHAIN_ID: "chain-dev",
  API_URL: "http://api.mock:8787",
} as NodeJS.ProcessEnv;

const devConfig = () => loadConfig(BASE_ENV);
const prodConfig = () => loadConfig({ ...BASE_ENV, APP_ENV: "production" } as NodeJS.ProcessEnv);

// ── Throwaway test signer ────────────────────────────────────────────────

const PRIV = sha256(new TextEncoder().encode("nvhash-session-test-key"));
const PUB = secp256k1.getPublicKey(PRIV, true);
const ADDRESS = pubkeyToBech32(PUB, "tp");
const PUB_B64 = Buffer.from(PUB).toString("base64");

function signChallenge(challengeText: string, signer = ADDRESS): string {
  const doc = buildAdr36SignDoc(signer, utf8ToBase64(challengeText));
  const digest = sha256(new TextEncoder().encode(canonicalJson(doc)));
  return Buffer.from(secp256k1.sign(digest, PRIV).toCompactRawBytes()).toString("base64");
}

function clockAt(startMs: number) {
  const state = { ms: startMs };
  return {
    now: () => new Date(state.ms),
    advanceSeconds: (s: number) => {
      state.ms += s * 1000;
    },
  };
}

async function establishSession(
  config = devConfig(),
  store = new InMemorySessionStore(),
  clock = clockAt(1_750_000_000_000),
) {
  const deps = { store, now: clock.now };
  const { nonce, challenge } = await mintNonce(config, ADDRESS, deps);
  const result = await login(
    config,
    { address: ADDRESS, nonce, pubkey: PUB_B64, signature: signChallenge(challenge) },
    deps,
  );
  return { config, store, clock, deps, nonce, result };
}

// ── ADR-36 verification ──────────────────────────────────────────────────

describe("ADR-36 verification (adr36-verify.server)", () => {
  it("verifies a correctly signed challenge and binds pubkey to address", () => {
    const text = loginChallenge("chain-dev", "n".repeat(43));
    expect(
      verifyAdr36({
        address: ADDRESS,
        challengeText: text,
        pubkeyBase64: PUB_B64,
        signatureBase64: signChallenge(text),
      }),
    ).toBe(true);
  });

  it("rejects a signature over different text", () => {
    expect(
      verifyAdr36({
        address: ADDRESS,
        challengeText: "some other text",
        pubkeyBase64: PUB_B64,
        signatureBase64: signChallenge("the signed text"),
      }),
    ).toBe(false);
  });

  it("rejects a pubkey that does not derive the claimed address", () => {
    const otherPriv = sha256(new TextEncoder().encode("another-key"));
    const otherPub = Buffer.from(secp256k1.getPublicKey(otherPriv, true)).toString("base64");
    const text = loginChallenge("chain-dev", "n".repeat(43));
    expect(
      verifyAdr36({
        address: ADDRESS, // claimed, but signed/derived by the other key
        challengeText: text,
        pubkeyBase64: otherPub,
        signatureBase64: signChallenge(text),
      }),
    ).toBe(false);
  });

  it("rejects malformed inputs without throwing", () => {
    const text = loginChallenge("chain-dev", "n".repeat(43));
    for (const bad of ["", "AA==", "!!!!"]) {
      expect(
        verifyAdr36({
          address: ADDRESS,
          challengeText: text,
          pubkeyBase64: bad,
          signatureBase64: signChallenge(text),
        }),
      ).toBe(false);
    }
    expect(
      verifyAdr36({
        address: "no-separator",
        challengeText: text,
        pubkeyBase64: PUB_B64,
        signatureBase64: signChallenge(text),
      }),
    ).toBe(false);
  });

  it("canonicalJson sorts keys at every depth (amino canonical form)", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [{ f: 3, e: 4 }] } })).toBe(
      '{"a":{"c":[{"e":4,"f":3}],"d":2},"b":1}',
    );
  });
});

// ── Login / cookie ───────────────────────────────────────────────────────

describe("login and cookie discipline (§12.3)", () => {
  it("logs in with a valid signed challenge and sets the cookie flags", async () => {
    const { result } = await establishSession();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.setCookie).toMatch(/^nvhash_session=[A-Za-z0-9_-]{43};/);
    expect(result.setCookie).toContain("HttpOnly");
    expect(result.setCookie).toContain("SameSite=Lax");
    expect(result.setCookie).toContain("Path=/");
    // Development: no Secure (localhost http); production: Secure required.
    expect(result.setCookie).not.toContain("Secure");
    expect(result.setCookie).toContain(`Max-Age=${SESSION_ABSOLUTE_TTL_SECONDS}`);
  });

  it("sets Secure outside development", async () => {
    const { result } = await establishSession(prodConfig());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.setCookie).toContain("; Secure");
  });

  it("the cookie value is the opaque id only — no address, no claims", async () => {
    const { result } = await establishSession();
    if (!result.ok) throw new Error("login failed");
    const value = result.setCookie.split(";")[0]!.split("=")[1]!;
    expect(value).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(result.setCookie).not.toContain(ADDRESS);
  });

  it("REPLAY: a second login with the same nonce+signature fails", async () => {
    const { config, store, clock, nonce, result } = await establishSession();
    expect(result.ok).toBe(true);
    const replay = await login(
      config,
      {
        address: ADDRESS,
        nonce,
        pubkey: PUB_B64,
        signature: signChallenge(loginChallenge(config.chainId, nonce)),
      },
      { store, now: clock.now },
    );
    expect(replay.ok).toBe(false); // consume-on-verify: the row is gone
  });

  it("an expired nonce fails even with a valid signature", async () => {
    const config = devConfig();
    const store = new InMemorySessionStore();
    const clock = clockAt(1_750_000_000_000);
    const deps = { store, now: clock.now };
    const { nonce, challenge } = await mintNonce(config, ADDRESS, deps);
    clock.advanceSeconds(NONCE_TTL_SECONDS + 1);
    const result = await login(
      config,
      { address: ADDRESS, nonce, pubkey: PUB_B64, signature: signChallenge(challenge) },
      deps,
    );
    expect(result.ok).toBe(false);
  });

  it("a nonce minted for another address fails (address-bound)", async () => {
    const config = devConfig();
    const store = new InMemorySessionStore();
    const clock = clockAt(1_750_000_000_000);
    const deps = { store, now: clock.now };
    const other = "tp1xj828fwstxajpn95mq07mw0ztn449lxx65skad";
    const { nonce, challenge } = await mintNonce(config, other, deps);
    const result = await login(
      config,
      { address: ADDRESS, nonce, pubkey: PUB_B64, signature: signChallenge(challenge) },
      deps,
    );
    expect(result.ok).toBe(false);
  });

  it("a bad signature fails and still burns the nonce", async () => {
    const config = devConfig();
    const store = new InMemorySessionStore();
    const clock = clockAt(1_750_000_000_000);
    const deps = { store, now: clock.now };
    const { nonce } = await mintNonce(config, ADDRESS, deps);
    const bad = await login(
      config,
      {
        address: ADDRESS,
        nonce,
        pubkey: PUB_B64,
        signature: signChallenge("entirely different text"),
      },
      deps,
    );
    expect(bad.ok).toBe(false);
    // Burned: even the CORRECT signature cannot use this nonce now.
    const retry = await login(
      config,
      {
        address: ADDRESS,
        nonce,
        pubkey: PUB_B64,
        signature: signChallenge(loginChallenge(config.chainId, nonce)),
      },
      deps,
    );
    expect(retry.ok).toBe(false);
  });
});

// ── Session lifetime / logout ────────────────────────────────────────────

describe("session lifetime and logout", () => {
  function requestWithCookie(setCookie: string): Request {
    const value = setCookie.split(";")[0]!;
    return new Request("http://app.local/portfolio", { headers: { Cookie: value } });
  }

  it("resolves the session while live; absolute expiry kills it", async () => {
    const { config, store, clock, result } = await establishSession();
    if (!result.ok) throw new Error("login failed");
    const request = requestWithCookie(result.setCookie);
    const deps = { store, now: clock.now };

    expect((await getSessionContext(config, request, deps))?.address).toBe(ADDRESS);

    // Keep it active (refresh inside the idle bound) up to the ceiling — the
    // absolute expiry wins regardless of activity.
    for (let i = 0; i < SESSION_ABSOLUTE_TTL_SECONDS / (12 * 60 * 60); i++) {
      clock.advanceSeconds(12 * 60 * 60);
      await getSessionContext(config, request, deps);
    }
    clock.advanceSeconds(1);
    expect(await getSessionContext(config, request, deps)).toBeNull();
  });

  it("sliding bound: 24 h of inactivity ends the session early", async () => {
    const { config, store, clock, result } = await establishSession();
    if (!result.ok) throw new Error("login failed");
    const request = requestWithCookie(result.setCookie);
    const deps = { store, now: clock.now };
    clock.advanceSeconds(24 * 60 * 60 + 1);
    expect(await getSessionContext(config, request, deps)).toBeNull();
  });

  it("logout destroys the row: the same cookie is dead afterwards", async () => {
    const { config, store, clock, result } = await establishSession();
    if (!result.ok) throw new Error("login failed");
    const request = requestWithCookie(result.setCookie);
    const deps = { store, now: clock.now };

    const { setCookie } = await logout(config, request, deps);
    expect(setCookie).toContain("Max-Age=0");
    expect(await getSessionContext(config, request, deps)).toBeNull();
  });

  it("bounds the cookie value shape (reject, not clamp)", () => {
    expect(sessionIdFromCookieHeader(null)).toBeNull();
    expect(sessionIdFromCookieHeader("other=x")).toBeNull();
    expect(sessionIdFromCookieHeader("nvhash_session=short")).toBeNull();
    expect(sessionIdFromCookieHeader(`nvhash_session=${"x".repeat(43)}; theme=dark`)).toBe(
      "x".repeat(43),
    );
    expect(sessionIdFromCookieHeader(`theme=dark; nvhash_session=${"y".repeat(43)}`)).toBe(
      "y".repeat(43),
    );
  });
});
