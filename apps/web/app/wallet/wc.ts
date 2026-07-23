// The shared WalletConnect v2 core (app-spec §10.1; plan 5.1 §3): standard
// pairing plus the standard Cosmos-namespace methods ONLY —
// `cosmos_getAccounts`, `cosmos_signAmino` (ADR-36 session login),
// `cosmos_signDirect` (arrives with PR 5.2). Nothing vendor-specific may
// live here: the dual-vendor §14.1 certification (Figure + Arculus) is the
// conformance gate for this shared path, and any workaround a vendor needs
// goes in that vendor's adapter module and is recorded in §14.1.
//
// Dependency posture (plan §7 Q3): `@walletconnect/sign-client` plus a
// minimal QR renderer in the UI — no modal SDK. The client is imported
// lazily on the user's explicit connect action.

import { buildAdr36SignDoc, loginChallenge, utf8ToBase64 } from "~/lib/adr36";
import type {
  AdapterEnv,
  SignArbitraryResult,
  VendorId,
  WalletAccount,
  WalletAdapter,
} from "./adapter";

/** Standard Cosmos-namespace methods (WC v2 CAIP-25). */
const COSMOS_METHODS = ["cosmos_getAccounts", "cosmos_signAmino", "cosmos_signDirect"] as const;

type SignClientLike = {
  connect(params: unknown): Promise<{ uri?: string; approval: () => Promise<SessionLike> }>;
  request<T>(params: { topic: string; chainId: string; request: unknown }): Promise<T>;
  disconnect(params: { topic: string; reason: { code: number; message: string } }): Promise<void>;
};

type SessionLike = {
  topic: string;
  namespaces: Record<string, { accounts: string[] }>;
};

/**
 * Normalize wallet-returned bytes (hex, base64, or base64url — vendors vary
 * in ENCODING, which is format normalization, not a vendor workaround) to
 * standard base64, verified to the expected decoded length. Anything else
 * is null: the caller surfaces a hard error rather than passing garbage on
 * (and the server independently re-verifies everything it receives).
 */
export function normalizeBase64Bytes(raw: string, expectedLength: number): string | null {
  if (new RegExp(`^[0-9a-fA-F]{${expectedLength * 2}}$`).test(raw)) {
    return Buffer.from(raw, "hex").toString("base64");
  }
  // base64url → standard base64 (PR #17 review: several Cosmos WC wallets
  // emit base64url); unpadded input is tolerated by the decoder.
  const std = raw.replace(/-/g, "+").replace(/_/g, "/");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(std)) return null;
  const bytes = Buffer.from(std, "base64");
  if (bytes.length !== expectedLength) return null;
  return bytes.toString("base64");
}

/** 33-byte compressed secp256k1 pubkey. */
export function normalizePubkey(raw: string): string | null {
  return normalizeBase64Bytes(raw, 33);
}

/** 64-byte r||s signature — the same encoding drift applies to signatures
 * (the login/relay boundary schemas require standard base64). */
export function normalizeSignature(raw: string): string | null {
  return normalizeBase64Bytes(raw, 64);
}

export class WcAdapter implements WalletAdapter {
  private client: SignClientLike | null = null;
  private session: SessionLike | null = null;

  constructor(
    public readonly vendor: VendorId,
    private readonly env: AdapterEnv,
  ) {}

  private get caipChainId(): string {
    return `cosmos:${this.env.chainId}`;
  }

  async connect(): Promise<WalletAccount> {
    if (this.env.walletConnectProjectId === null) {
      throw new Error("walletconnect-unconfigured");
    }
    const { default: SignClient } = await import("@walletconnect/sign-client");
    this.client = (await SignClient.init({
      projectId: this.env.walletConnectProjectId,
      metadata: {
        name: "nvHASH",
        description: "Liquid staking for HASH",
        url: typeof location !== "undefined" ? location.origin : "https://nvhash.invalid",
        icons: [],
      },
    })) as unknown as SignClientLike;

    const { uri, approval } = await this.client.connect({
      requiredNamespaces: {
        cosmos: {
          methods: [...COSMOS_METHODS],
          chains: [this.caipChainId],
          events: [],
        },
      },
    });
    if (uri !== undefined) this.env.onPairingUri?.(uri);
    this.session = await approval();

    const accounts = this.session.namespaces["cosmos"]?.accounts ?? [];
    // CAIP-10: "cosmos:<chain-id>:<address>" — take the first account on our
    // chain; a session approving no account on this chain is a hard error.
    const onChain = accounts.find((a) => a.startsWith(`${this.caipChainId}:`));
    if (onChain === undefined) throw new Error("no account approved for this chain");
    const address = onChain.slice(this.caipChainId.length + 1);

    // cosmos_getAccounts supplies the pubkey the session layer verifies
    // against the address (adr36-verify.server.ts re-derives it server-side).
    const got = await this.client.request<Array<{ address: string; pubkey: string }>>({
      topic: this.session.topic,
      chainId: this.caipChainId,
      request: { method: "cosmos_getAccounts", params: {} },
    });
    const match = got.find((a) => a.address === address) ?? got[0];
    const pubkey = match === undefined ? null : normalizePubkey(match.pubkey);
    if (pubkey === null) throw new Error("wallet returned no usable pubkey");
    return { address, pubkeyBase64: pubkey };
  }

  async signArbitrary(
    signerAddress: string,
    challengeText: string,
  ): Promise<SignArbitraryResult> {
    if (this.client === null || this.session === null) throw new Error("not connected");
    const signDoc = buildAdr36SignDoc(signerAddress, utf8ToBase64(challengeText));
    const response = await this.client.request<{
      signature: { signature: string; pub_key: { value: string } };
    }>({
      topic: this.session.topic,
      chainId: this.caipChainId,
      request: {
        method: "cosmos_signAmino",
        params: { signerAddress, signDoc },
      },
    });
    const pubkey = normalizePubkey(response.signature.pub_key.value);
    if (pubkey === null) throw new Error("wallet returned no usable pubkey");
    const signature = normalizeSignature(response.signature.signature);
    if (signature === null) throw new Error("wallet returned no usable signature");
    return { signatureBase64: signature, pubkeyBase64: pubkey };
  }

  async signDirect(
    signerAddress: string,
    signDoc: import("./adapter").DirectSignDoc,
  ): Promise<SignArbitraryResult> {
    if (this.client === null || this.session === null) throw new Error("not connected");
    // Standard WC v2 cosmos_signDirect: base64 byte fields + chain id +
    // account number, exactly the sign doc the confirm step disclosed.
    const response = await this.client.request<{
      signature: { signature: string; pub_key: { value: string } };
    }>({
      topic: this.session.topic,
      chainId: this.caipChainId,
      request: {
        method: "cosmos_signDirect",
        params: {
          signerAddress,
          signDoc: {
            bodyBytes: signDoc.bodyBytesBase64,
            authInfoBytes: signDoc.authInfoBytesBase64,
            chainId: signDoc.chainId,
            accountNumber: signDoc.accountNumber,
          },
        },
      },
    });
    const pubkey = normalizePubkey(response.signature.pub_key.value);
    if (pubkey === null) throw new Error("wallet returned no usable pubkey");
    const signature = normalizeSignature(response.signature.signature);
    if (signature === null) throw new Error("wallet returned no usable signature");
    return { signatureBase64: signature, pubkeyBase64: pubkey };
  }

  async disconnect(): Promise<void> {
    if (this.client !== null && this.session !== null) {
      try {
        await this.client.disconnect({
          topic: this.session.topic,
          reason: { code: 6000, message: "user disconnected" },
        });
      } catch {
        // A dead relay must not block local disconnect.
      }
    }
    this.client = null;
    this.session = null;
  }
}

// Re-export for the provider's convenience (single import site client-side).
export { loginChallenge };
