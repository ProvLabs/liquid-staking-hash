// Broadcast-relay guard gate (plan 5.2 §4.9; §12.3 amendment): the relay
// accepts ONLY a fully-signed tx whose sole signer is the session address,
// whose messages are the closed vault set against the configured vault,
// size-capped and rate-limited. Every guard has its case here — wrong
// signer → 403, non-allowlisted msg → 400, oversize → 413, malformed → 400,
// rate → 429. (The session requirement's 401 is covered by the
// session-scope suite; the route wires requireSession.)

import { secp256k1 } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha256";
import { beforeEach, describe, expect, it } from "vitest";

import { pubkeyToBech32 } from "~/lib/adr36-verify.server";
import { loadConfig } from "~/config/config.server";
import {
  buildTxPlan,
  encodeTxBody,
  encodeTxRaw,
  type TxIntent,
} from "~/tx/build";
import { ProtoWriter } from "~/tx/proto";
import {
  guardSignedTx,
  RATE_LIMIT_PER_MINUTE,
  resetRelayRateLimitForTests,
  SIZE_CAP_BYTES,
} from "~/tx/broadcast.server";

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

const PRIV = sha256(new TextEncoder().encode("nvhash-broadcast-guard-key"));
const PUB = secp256k1.getPublicKey(PRIV, true);
const SESSION_ADDRESS = pubkeyToBech32(PUB, "tp");
const OTHER_PRIV = sha256(new TextEncoder().encode("someone-else"));
const OTHER_PUB = secp256k1.getPublicKey(OTHER_PRIV, true);

beforeEach(() => resetRelayRateLimitForTests());

function signedTx(overrides?: {
  owner?: string;
  vault?: string;
  pubkey?: Uint8Array;
  signatures?: number;
}): Uint8Array {
  const intent: TxIntent = {
    kind: "swap_in",
    owner: overrides?.owner ?? SESSION_ADDRESS,
    vaultAddress: overrides?.vault ?? config.vaultAddress,
    amount: 1_000_000_000n,
    denom: "nhash",
  };
  const plan = buildTxPlan(
    intent,
    { gasLimit: 200_000n, amount: 381_000_000n, denom: "nhash" },
    {
      chainId: config.chainId,
      accountNumber: 1n,
      sequence: 0n,
      pubkeyBase64: Buffer.from(overrides?.pubkey ?? PUB).toString("base64"),
    },
  );
  const sigs = Array.from({ length: overrides?.signatures ?? 1 }, () => new Uint8Array(64));
  return encodeTxRaw(plan.bodyBytes, plan.authInfoBytes, sigs);
}

describe("relay guards (each an enforced mechanism)", () => {
  it("accepts the session's own vault tx", () => {
    expect(guardSignedTx(config, SESSION_ADDRESS, signedTx())).toEqual({ ok: true });
  });

  it("SIGNER pubkey not deriving the session address → 403", () => {
    const verdict = guardSignedTx(config, SESSION_ADDRESS, signedTx({ pubkey: OTHER_PUB }));
    expect(verdict).toMatchObject({ ok: false, status: 403 });
  });

  it("message owner differing from the session address → 403", () => {
    const verdict = guardSignedTx(
      config,
      SESSION_ADDRESS,
      signedTx({ owner: "tp1xj828fwstxajpn95mq07mw0ztn449lxx65skad" }),
    );
    expect(verdict).toMatchObject({ ok: false, status: 403 });
  });

  it("non-allowlisted message type → 400", () => {
    // Hand-encode a bank MsgSend Any inside a TxBody with our signer.
    const msgSend = new ProtoWriter()
      .string(1, SESSION_ADDRESS)
      .string(2, SESSION_ADDRESS)
      .finish();
    const anyMsg = new ProtoWriter()
      .string(1, "/cosmos.bank.v1beta1.MsgSend")
      .bytes(2, msgSend)
      .finish();
    const body = new ProtoWriter().message(1, anyMsg, true).finish();
    const plan = buildTxPlan(
      {
        kind: "swap_in",
        owner: SESSION_ADDRESS,
        vaultAddress: config.vaultAddress,
        amount: 1n,
        denom: "nhash",
      },
      { gasLimit: 1n, amount: 1n, denom: "nhash" },
      {
        chainId: config.chainId,
        accountNumber: 1n,
        sequence: 0n,
        pubkeyBase64: Buffer.from(PUB).toString("base64"),
      },
    );
    const tx = encodeTxRaw(body, plan.authInfoBytes, [new Uint8Array(64)]);
    expect(guardSignedTx(config, SESSION_ADDRESS, tx)).toMatchObject({ ok: false, status: 400 });
  });

  it("unexpected vault address → 400", () => {
    const verdict = guardSignedTx(
      config,
      SESSION_ADDRESS,
      signedTx({ vault: "tp1rxvcuzkn0zk4nwgclw2nf2wcc5pym3fjc7y4s0" }),
    );
    expect(verdict).toMatchObject({ ok: false, status: 400 });
  });

  it("oversize → 413", () => {
    const verdict = guardSignedTx(config, SESSION_ADDRESS, new Uint8Array(SIZE_CAP_BYTES + 1));
    expect(verdict).toMatchObject({ ok: false, status: 413 });
  });

  it("malformed bytes → 400", () => {
    expect(guardSignedTx(config, SESSION_ADDRESS, new Uint8Array([0xff, 0x01, 0x02]))).toMatchObject(
      { ok: false, status: 400 },
    );
  });

  it("multiple signatures → 400 (sole-signer rule)", () => {
    const verdict = guardSignedTx(config, SESSION_ADDRESS, signedTx({ signatures: 2 }));
    expect(verdict).toMatchObject({ ok: false, status: 400 });
  });

  it("empty TxBody (no messages) → 400", () => {
    const plan = buildTxPlan(
      {
        kind: "swap_in",
        owner: SESSION_ADDRESS,
        vaultAddress: config.vaultAddress,
        amount: 1n,
        denom: "nhash",
      },
      { gasLimit: 1n, amount: 1n, denom: "nhash" },
      {
        chainId: config.chainId,
        accountNumber: 1n,
        sequence: 0n,
        pubkeyBase64: Buffer.from(PUB).toString("base64"),
      },
    );
    const emptyBody = encodeTxBody([]);
    const tx = encodeTxRaw(emptyBody, plan.authInfoBytes, [new Uint8Array(64)]);
    expect(guardSignedTx(config, SESSION_ADDRESS, tx)).toMatchObject({ ok: false, status: 400 });
  });

  it("rate limit: request N+1 in a minute → 429; a new window admits again", () => {
    const nowMs = 1_750_000_000_000;
    for (let i = 0; i < RATE_LIMIT_PER_MINUTE; i += 1) {
      expect(guardSignedTx(config, SESSION_ADDRESS, signedTx(), nowMs + i)).toEqual({ ok: true });
    }
    expect(guardSignedTx(config, SESSION_ADDRESS, signedTx(), nowMs + 10)).toMatchObject({
      ok: false,
      status: 429,
    });
    expect(guardSignedTx(config, SESSION_ADDRESS, signedTx(), nowMs + 61_000)).toEqual({ ok: true });
  });
});
