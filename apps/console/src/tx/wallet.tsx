// Wallet adapter (spec §10.1). Production signing happens entirely in the
// wallet extension; the console never sees keys (SECURITY.md). The devnet
// direct-key / mock path lives behind a BUILD-MODE STATIC condition
// (`import.meta.env.MODE === "devnet"`), so Vite's dead-code elimination
// removes it — and its identities module — from test/production bundles;
// scripts/check-bundle.mjs proves it stayed removed (spec §10.1's
// "compile-time excluded", a gate since PR 8.4b rather than prose).
import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { config } from "@/config";
import { lcdGetJson } from "@/data/lcd";
import {
  decodeAuthAccount,
  encodeExecuteContract,
  encodeAuthInfo,
  encodeTxBody,
  encodeTxRaw,
  bytesToBase64,
  base64ToBytes,
  MSG_EXECUTE_CONTRACT,
  type Coin,
  type Fee,
} from "@/tx/build";
import { simulateFee } from "@/tx/simulate";
import { broadcastAndConfirm } from "@/tx/broadcast";
import { extensionConnect, extensionDisconnect, extensionSignDirect } from "@/tx/figure-extension";
import { MOCK_IDENTITIES, mockTxHash } from "@/tx/devnet-keys";
import type { ExecuteMsg } from "@/tx/messages";

/** True ONLY in the devnet build profile — a compile-time constant Vite
 *  folds, taking the mock/direct-key branch and its imports with it. */
const DEVNET_BUILD = import.meta.env.MODE === "devnet";

export type Role = "observer" | "keeper" | "operator" | "admin";

export interface WalletState {
  address: string | null;
  devnetKeyMode: boolean;
  /** Devnet-build mock identity labels; ALWAYS empty in test/production
   *  builds (the identities module is compile-time excluded). Consumers read
   *  this rather than importing the module, which would defeat the DCE. */
  mockIdentityLabels: string[];
  connect: (mockIdentity?: string) => Promise<void>;
  disconnect: () => void;
  /** Simulate the exact rendered message; the result IS the fee (verbatim). */
  estimateFee: (msg: ExecuteMsg, funds?: Coin[]) => Promise<Fee>;
  signAndBroadcast: (msg: ExecuteMsg, funds?: Coin[]) => Promise<string>;
}

const WalletCtx = createContext<WalletState | null>(null);

export function WalletProvider({ children }: { children: ReactNode }) {
  const [address, setAddress] = useState<string | null>(null);
  const [pubkey, setPubkey] = useState<string | null>(null);

  const value = useMemo<WalletState>(() => {
    const mockMode = DEVNET_BUILD && (config.mock || config.devnetKeyMode);

    /** body+authInfo for the exact rendered message, at the CURRENT sequence. */
    const encodeForSigner = async (msg: ExecuteMsg, funds: Coin[], fee: Fee) => {
      if (address === null || pubkey === null) throw new Error("wallet not connected");
      const account = decodeAuthAccount(
        await lcdGetJson(`/cosmos/auth/v1beta1/accounts/${encodeURIComponent(address)}`),
      );
      const signer = {
        chainId: config.chainId,
        accountNumber: account.accountNumber,
        sequence: account.sequence,
        pubkeyBase64: pubkey,
      };
      const bodyBytes = encodeTxBody([
        {
          typeUrl: MSG_EXECUTE_CONTRACT,
          value: encodeExecuteContract(address, config.contractAddress, msg, funds),
        },
      ]);
      return { signer, bodyBytes, authInfoBytes: encodeAuthInfo(signer, fee) };
    };

    const estimate = async (msg: ExecuteMsg, funds: Coin[]): Promise<Fee> => {
      if (mockMode) throw new Error("mock mode does not simulate");
      const provisional = await encodeForSigner(msg, funds, {
        gasLimit: 0n,
        amount: 0n,
        denom: "nhash",
      });
      return simulateFee(provisional.bodyBytes, provisional.authInfoBytes);
    };

    return {
      address,
      devnetKeyMode: mockMode,
      mockIdentityLabels: DEVNET_BUILD ? MOCK_IDENTITIES.map((m) => m.label) : [],
      async connect(mockIdentity?: string) {
        if (mockMode) {
          const found = MOCK_IDENTITIES.find((m) => m.label === mockIdentity);
          setAddress(found?.address ?? MOCK_IDENTITIES[0].address);
          return;
        }
        const account = await extensionConnect(config.chainId);
        setAddress(account.address);
        setPubkey(account.pubkeyBase64);
      },
      disconnect() {
        if (!mockMode) void extensionDisconnect();
        setAddress(null);
        setPubkey(null);
      },
      estimateFee: (msg, funds = []) => estimate(msg, funds),
      async signAndBroadcast(msg, funds = []) {
        if (mockMode) {
          if (!config.mock) {
            // Devnet KEY mode connects an identity for role display and guard
            // preflight against a real chain; it holds no key, so it cannot
            // sign — drills broadcast through the dev node's own keyring.
            throw new Error("devnet key mode does not sign — use the dev node keyring");
          }
          // Simulated inclusion for the mock drill; returns a fake txhash.
          return mockTxHash(JSON.stringify(msg));
        }
        // Sequence fetched ONCE, at sign time (C3): a stale sequence fails
        // broadcast and the chain error surfaces verbatim — no auto-retry,
        // no sequence bumping.
        const fee = await estimate(msg, funds);
        const { signer, bodyBytes, authInfoBytes } = await encodeForSigner(msg, funds, fee);
        if (address === null) throw new Error("wallet not connected");
        const { signatureBase64 } = await extensionSignDirect({
          chainId: signer.chainId,
          signerAddress: address,
          bodyBytesBase64: bytesToBase64(bodyBytes),
          authInfoBytesBase64: bytesToBase64(authInfoBytes),
          accountNumber: signer.accountNumber.toString(),
        });
        const outcome = await broadcastAndConfirm(
          encodeTxRaw(bodyBytes, authInfoBytes, [base64ToBytes(signatureBase64)]),
        );
        return outcome.txhash;
      },
    };
  }, [address, pubkey]);

  return <WalletCtx.Provider value={value}>{children}</WalletCtx.Provider>;
}

export function useWallet(): WalletState {
  const c = useContext(WalletCtx);
  if (!c) throw new Error("useWallet outside WalletProvider");
  return c;
}
