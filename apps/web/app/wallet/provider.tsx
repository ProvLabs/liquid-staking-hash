// Wallet provider: client-side connection state plus the
// session login orchestration — connect via the vendor adapter, mint a
// nonce, ADR-36-sign the challenge, establish the HttpOnly cookie session,
// then revalidate so server loaders see it. The signed challenge text is
// EXACTLY what /session/nonce returned; construction is the shared
// app/lib/adr36.ts, verification is server-side.
//
// The provider never sees key material (SECURITY.md): adapters expose
// connect/sign only, and the session cookie is HttpOnly — this code cannot
// read it back.

import { createContext, useCallback, useContext, useMemo, useState } from "react";
import { useRevalidator } from "react-router";

import {
  isVendorId,
  WALLET_VENDORS,
  type DirectSignDoc,
  type SignArbitraryResult,
  type VendorId,
  type WalletAdapter,
} from "./adapter";

export type WalletState =
  | { phase: "disconnected" }
  | { phase: "connecting"; vendor: VendorId; pairingUri: string | null }
  | { phase: "signing"; vendor: VendorId; address: string }
  | { phase: "connected"; vendor: VendorId | null; address: string }
  | { phase: "error"; vendor: VendorId; reason: WalletErrorReason };

export type WalletErrorReason =
  | "walletconnect-unconfigured"
  | "extension-not-found"
  | "rejected-or-failed";

/** Thrown by `signDirect` when the cookie session is live but the in-memory
 * adapter is gone (post-reload) — the UI must prompt a reconnect to sign. */
export class ReconnectToSignError extends Error {
  constructor() {
    super("reconnect-to-sign");
    this.name = "ReconnectToSignError";
  }
}

interface WalletContextValue {
  state: WalletState;
  connect(vendor: VendorId): Promise<void>;
  disconnect(): Promise<void>;
  /**
   * SIGN_MODE_DIRECT sign of a transaction sign doc (wired
   * to pages in 5.3). Throws ReconnectToSignError when no live adapter backs
   * the current session (the reload case) — signing never silently no-ops.
   */
  signDirect(signerAddress: string, signDoc: DirectSignDoc): Promise<SignArbitraryResult>;
  /** True when a transaction can be signed now without reconnecting. */
  canSign: boolean;
  /**
   * The connected account's compressed secp256k1 pubkey (base64), needed by
   * simulate + sign-doc building. Null unless a live adapter is connected
   * this page-load (a public value — never key material).
   */
  pubkeyBase64: string | null;
}

const WalletContext = createContext<WalletContextValue | null>(null);

export function useWallet(): WalletContextValue {
  const value = useContext(WalletContext);
  if (value === null) throw new Error("useWallet outside WalletProvider");
  return value;
}

export interface WalletProviderProps {
  chainId: string;
  walletConnectProjectId: string | null;
  /** Server-known session address (root loader) — the source of truth. */
  sessionAddress: string | null;
  children: React.ReactNode;
}

async function postJson(path: string, body: unknown): Promise<Response> {
  return fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export function WalletProvider({
  chainId,
  walletConnectProjectId,
  sessionAddress,
  children,
}: WalletProviderProps) {
  const revalidator = useRevalidator();
  const [adapter, setAdapter] = useState<WalletAdapter | null>(null);
  const [pubkeyBase64, setPubkeyBase64] = useState<string | null>(null);
  const [clientState, setClientState] = useState<WalletState | null>(null);

  // Server session wins: a valid cookie session renders connected even after
  // a reload dropped the in-memory adapter (signing then requires reconnect).
  const state: WalletState =
    clientState ??
    (sessionAddress !== null
      ? { phase: "connected", vendor: adapter?.vendor ?? null, address: sessionAddress }
      : { phase: "disconnected" });

  const connect = useCallback(
    async (vendor: VendorId) => {
      if (!isVendorId(vendor)) return; // closed registry; nothing else constructs
      setClientState({ phase: "connecting", vendor, pairingUri: null });
      try {
        const created = await WALLET_VENDORS[vendor].create({
          chainId,
          walletConnectProjectId,
          onPairingUri: (uri) => setClientState({ phase: "connecting", vendor, pairingUri: uri }),
        });
        const account = await created.connect();
        setAdapter(created);
        setPubkeyBase64(account.pubkeyBase64);
        setClientState({ phase: "signing", vendor, address: account.address });

        const nonceRes = await postJson("/session/nonce", { address: account.address });
        if (!nonceRes.ok) throw new Error("nonce mint failed");
        const { nonce, challenge } = (await nonceRes.json()) as {
          nonce: string;
          challenge: string;
        };

        const signed = await created.signArbitrary(account.address, challenge);
        const loginRes = await postJson("/session/login", {
          address: account.address,
          nonce,
          pubkey: signed.pubkeyBase64,
          signature: signed.signatureBase64,
        });
        if (!loginRes.ok) throw new Error("login failed");

        setClientState({ phase: "connected", vendor, address: account.address });
        revalidator.revalidate();
      } catch (error) {
        const reason: WalletErrorReason =
          error instanceof Error && error.message === "walletconnect-unconfigured"
            ? "walletconnect-unconfigured"
            : error instanceof Error && error.message === "figure-extension-not-found"
              ? "extension-not-found"
              : "rejected-or-failed";
        setClientState({ phase: "error", vendor, reason });
      }
    },
    [chainId, walletConnectProjectId, revalidator],
  );

  const disconnect = useCallback(async () => {
    try {
      await postJson("/session/logout", {});
    } finally {
      await adapter?.disconnect();
      setAdapter(null);
      setPubkeyBase64(null);
      setClientState({ phase: "disconnected" });
      revalidator.revalidate();
    }
  }, [adapter, revalidator]);

  const signDirect = useCallback(
    async (signerAddress: string, signDoc: DirectSignDoc): Promise<SignArbitraryResult> => {
      // The adapter is the only thing that can sign; when the session cookie
      // outlived the in-memory adapter (reload), we cannot — and must say so
      // rather than fail obscurely deep in the flow.
      if (adapter === null) throw new ReconnectToSignError();
      return adapter.signDirect(signerAddress, signDoc);
    },
    [adapter],
  );

  const canSign = adapter !== null;

  const value = useMemo(
    () => ({ state, connect, disconnect, signDirect, canSign, pubkeyBase64 }),
    [state, connect, disconnect, signDirect, canSign, pubkeyBase64],
  );
  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}
