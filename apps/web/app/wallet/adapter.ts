// The wallet adapter boundary (app-spec §10.1). Signing exists
// ONLY behind this closed registry: the §14.1-decided v1 vendor set — Figure
// (WC v2 mobile + injected extension) and Arculus (WC v2 mobile) — as a
// typed union with a compile-time totality assertion (the verify-link
// pattern; test/wallet-adapter.test.ts gates closedness).
//
// SECURITY.md (apps): the App never touches key material. An adapter's whole
// surface is connect / disconnect / sign — no mnemonic or key input exists
// anywhere, and adding a vendor is a spec-recorded §14.1 amendment plus a
// checklist run, never a config toggle.
//
// Vendor-specific workarounds live INSIDE that vendor's adapter module and
// are recorded in app-spec §14.1 (§10.1: the shared WC v2 path uses standard
// pairing and Cosmos-namespace methods only).

export type VendorId = "figure-mobile" | "figure-extension" | "arculus";

export interface WalletAccount {
  address: string;
  /** base64, 33-byte compressed secp256k1 (normalized by the adapter). */
  pubkeyBase64: string;
}

export interface SignArbitraryResult {
  /** base64, 64-byte r||s. */
  signatureBase64: string;
  pubkeyBase64: string;
}

/** SIGN_MODE_DIRECT sign doc as base64 fields (§10.2 step 5). */
export interface DirectSignDoc {
  bodyBytesBase64: string;
  authInfoBytesBase64: string;
  chainId: string;
  /** decimal string (u64) */
  accountNumber: string;
}

/**
 * What a vendor adapter provides. `signDirect` signs the §10.2
 * transaction sign doc; `signArbitrary` signs the ADR-36 session
 * challenge. Nothing else — no key material ever crosses this boundary.
 */
export interface WalletAdapter {
  readonly vendor: VendorId;
  connect(): Promise<WalletAccount>;
  disconnect(): Promise<void>;
  /** ADR-36 sign of the utf8 challenge text (session login, §3 decision 5). */
  signArbitrary(signerAddress: string, challengeText: string): Promise<SignArbitraryResult>;
  /** SIGN_MODE_DIRECT over the exact bytes the confirm step disclosed. */
  signDirect(signerAddress: string, signDoc: DirectSignDoc): Promise<SignArbitraryResult>;
}

/** Environment an adapter is constructed with (all public values). */
export interface AdapterEnv {
  chainId: string;
  /** null = WC transport unconfigured (WC vendors must surface that, not throw obscurely). */
  walletConnectProjectId: string | null;
  /** WC pairing URI callback — the UI renders it as a QR code. */
  onPairingUri?: (uri: string) => void;
}

export interface VendorDescriptor {
  readonly id: VendorId;
  /** Display label (brand names are not translated). */
  readonly label: string;
  readonly transport: "walletconnect" | "injected";
  create(env: AdapterEnv): Promise<WalletAdapter>;
}

// Lazy factory imports keep the WalletConnect client out of the initial
// bundle; it loads on the user's explicit connect action.
export const WALLET_VENDORS = {
  "figure-mobile": {
    id: "figure-mobile",
    label: "Figure Wallet (mobile)",
    transport: "walletconnect",
    create: async (env) => {
      const { WcAdapter } = await import("./wc");
      return new WcAdapter("figure-mobile", env);
    },
  },
  "figure-extension": {
    id: "figure-extension",
    label: "Figure Wallet (extension)",
    transport: "injected",
    create: async (env) => {
      const { FigureExtensionAdapter } = await import("./figure-extension");
      return new FigureExtensionAdapter(env);
    },
  },
  arculus: {
    id: "arculus",
    label: "Arculus (mobile)",
    transport: "walletconnect",
    create: async (env) => {
      const { WcAdapter } = await import("./wc");
      return new WcAdapter("arculus", env);
    },
  },
} as const satisfies Record<VendorId, VendorDescriptor>;

export const VENDOR_IDS = Object.keys(WALLET_VENDORS) as readonly VendorId[];

export function isVendorId(value: string): value is VendorId {
  return (VENDOR_IDS as readonly string[]).includes(value);
}
