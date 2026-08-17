/** The injected provider surface this adapter certifies against (§14.1). */
interface InjectedFigureProvider {
  connect(args: {
    chainId: string;
  }): Promise<{ address: string; pubKey?: string; pubkey?: string }>;
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

export interface ExtensionAccount {
  address: string;
  /** base64, 33-byte compressed secp256k1. */
  pubkeyBase64: string;
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

let provider: InjectedFigureProvider | null = null;

/** Connect the injected extension; a missing extension is a specific error
 *  ("extension not found"), never a silent fallback to any other path. */
export async function extensionConnect(chainId: string): Promise<ExtensionAccount> {
  const found = probeProvider();
  if (found === null) {
    throw new Error("Figure extension not found — install it or use the devnet build's key mode");
  }
  provider = found;
  const account = await found.connect({ chainId });
  const pubkey = account.pubKey ?? account.pubkey ?? "";
  if (pubkey === "") throw new Error("wallet returned no usable pubkey");
  return { address: account.address, pubkeyBase64: pubkey };
}

/** SIGN_MODE_DIRECT over base64 SignDoc parts. Unknown capability → refuse
 *  with a specific error (never an amino fallback signing different bytes). */
export async function extensionSignDirect(args: {
  chainId: string;
  signerAddress: string;
  bodyBytesBase64: string;
  authInfoBytesBase64: string;
  accountNumber: string;
}): Promise<{ signatureBase64: string }> {
  if (provider === null) throw new Error("not connected");
  if (typeof provider.signDirect !== "function") {
    throw new Error(
      "this extension exposes no signDirect — direct signing is required (no amino fallback)",
    );
  }
  const response = await provider.signDirect({
    chainId: args.chainId,
    signerAddress: args.signerAddress,
    signDoc: {
      bodyBytes: args.bodyBytesBase64,
      authInfoBytes: args.authInfoBytesBase64,
      chainId: args.chainId,
      accountNumber: args.accountNumber,
    },
  });
  const signature = response.signature?.signature;
  if (typeof signature !== "string" || signature === "") {
    throw new Error("wallet returned no usable signature");
  }
  return { signatureBase64: signature };
}

export async function extensionDisconnect(): Promise<void> {
  try {
    await provider?.disconnect?.();
  } catch {
    // Extension teardown failures must not block local disconnect.
  }
  provider = null;
}
