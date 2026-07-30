// Figure Wallet browser-extension adapter (desktop; §14.1 decided vendor,
// injected transport). PER-VENDOR MODULE: anything Figure-extension-specific
// lives here, never in the shared path (app-spec §10.1).
//
// PROVISIONAL until the §14.1 certification checklist runs against the real
// extension on devnet (the acceptance gate,
// the §14.1 certification runbook): the injected
// surface below — `window.figure.provenance` with connect/signAmino — is the
// interface this adapter certifies AGAINST; a divergence found by the
// checklist run is fixed HERE and recorded in app-spec §14.1, exactly the
// localization the per-vendor adapter boundary exists for.

import { buildAdr36SignDoc, utf8ToBase64 } from "~/lib/adr36";
import { normalizePubkey, normalizeSignature } from "./wc";
import type {
  AdapterEnv,
  SignArbitraryResult,
  VendorId,
  WalletAccount,
  WalletAdapter,
} from "./adapter";

/** The injected provider surface this adapter certifies against (§14.1). */
interface InjectedFigureProvider {
  connect(args: { chainId: string }): Promise<{ address: string; pubKey?: string; pubkey?: string }>;
  signAmino(args: {
    chainId: string;
    signerAddress: string;
    signDoc: unknown;
  }): Promise<{ signature: { signature: string; pub_key: { value: string } } }>;
  signDirect?(args: {
    chainId: string;
    signerAddress: string;
    signDoc: {
      bodyBytes: string;
      authInfoBytes: string;
      chainId: string;
      accountNumber: string;
    };
  }): Promise<{ signature: { signature: string; pub_key: { value: string } } }>;
  disconnect?(): Promise<void>;
}

function probeProvider(): InjectedFigureProvider | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    figure?: { provenance?: InjectedFigureProvider } & InjectedFigureProvider;
  };
  const candidate = w.figure?.provenance ?? w.figure;
  if (candidate !== undefined && typeof candidate.connect === "function") return candidate;
  return null;
}

export class FigureExtensionAdapter implements WalletAdapter {
  public readonly vendor: VendorId = "figure-extension";
  private provider: InjectedFigureProvider | null = null;

  constructor(private readonly env: AdapterEnv) {}

  async connect(): Promise<WalletAccount> {
    const provider = probeProvider();
    if (provider === null) throw new Error("figure-extension-not-found");
    this.provider = provider;
    const account = await provider.connect({ chainId: this.env.chainId });
    const rawPubkey = account.pubKey ?? account.pubkey ?? "";
    const pubkey = normalizePubkey(rawPubkey);
    if (pubkey === null) throw new Error("wallet returned no usable pubkey");
    return { address: account.address, pubkeyBase64: pubkey };
  }

  async signArbitrary(
    signerAddress: string,
    challengeText: string,
  ): Promise<SignArbitraryResult> {
    if (this.provider === null) throw new Error("not connected");
    const signDoc = buildAdr36SignDoc(signerAddress, utf8ToBase64(challengeText));
    const response = await this.provider.signAmino({
      chainId: this.env.chainId,
      signerAddress,
      signDoc,
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
    if (this.provider === null) throw new Error("not connected");
    if (typeof this.provider.signDirect !== "function") {
      // Provisional (§14.1): if the real extension exposes direct signing
      // under a different name, THIS adapter absorbs it — never the shared
      // path. The checklist run (item d) settles it.
      throw new Error("figure-extension-no-sign-direct");
    }
    const response = await this.provider.signDirect({
      chainId: this.env.chainId,
      signerAddress,
      signDoc: {
        bodyBytes: signDoc.bodyBytesBase64,
        authInfoBytes: signDoc.authInfoBytesBase64,
        chainId: signDoc.chainId,
        accountNumber: signDoc.accountNumber,
      },
    });
    const pubkey = normalizePubkey(response.signature.pub_key.value);
    if (pubkey === null) throw new Error("wallet returned no usable pubkey");
    const signature = normalizeSignature(response.signature.signature);
    if (signature === null) throw new Error("wallet returned no usable signature");
    return { signatureBase64: signature, pubkeyBase64: pubkey };
  }

  async disconnect(): Promise<void> {
    try {
      await this.provider?.disconnect?.();
    } catch {
      // Extension teardown failures must not block local disconnect.
    }
    this.provider = null;
  }
}
