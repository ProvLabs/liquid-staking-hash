// Wallet adapter (spec §10.1). Minimal interface: connect/disconnect/address/signAndBroadcast.
// Production signing happens entirely in the wallet extension; the console never sees keys.
// A devnet direct-key / mock mode (compile-excluded from production by the build profile,
// spec §7) lets drills connect as a chosen on-chain identity without a browser wallet.
import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { config } from "@/config";

export type Role = "observer" | "keeper" | "operator" | "admin";

export interface WalletState {
  address: string | null;
  devnetKeyMode: boolean;
  connect: (mockIdentity?: string) => Promise<void>;
  disconnect: () => void;
  signAndBroadcast: (msg: unknown, funds?: { denom: string; amount: string }[]) => Promise<string>;
}

const WalletCtx = createContext<WalletState | null>(null);

// Mock identities for devnet/mock drills, keyed to the fixture roles (see data/fixtures.ts).
export const MOCK_IDENTITIES: { label: string; address: string }[] = [
  { label: "admin (Ada)", address: "pb1adminadminadminadminadminadminadmin00" },
  { label: "operator (Pat)", address: "pb1operatoroperatoroperatoroperatorop000" },
  { label: "keeper (Kai)", address: "pb1keeperkeeperkeeperkeeperkeeperkeep0000" },
];

export function WalletProvider({ children }: { children: ReactNode }) {
  const [address, setAddress] = useState<string | null>(null);

  const value = useMemo<WalletState>(
    () => ({
      address,
      devnetKeyMode: config.devnetKeyMode || config.mock,
      async connect(mockIdentity?: string) {
        if (config.mock || config.devnetKeyMode) {
          const found = MOCK_IDENTITIES.find((m) => m.label === mockIdentity);
          setAddress(found?.address ?? MOCK_IDENTITIES[0].address);
          return;
        }
        // Real path: hand off to the Provenance-capable extension wallet [DECIDE §14.1].
        throw new Error("extension wallet not configured in this build");
      },
      disconnect() {
        setAddress(null);
      },
      async signAndBroadcast(_msg, _funds) {
        if (config.mock) {
          // Simulated inclusion for the mock drill; returns a fake txhash.
          return "MOCK" + Math.abs(hashString(JSON.stringify(_msg))).toString(16).toUpperCase();
        }
        throw new Error("signing requires a connected wallet");
      },
    }),
    [address],
  );

  return <WalletCtx.Provider value={value}>{children}</WalletCtx.Provider>;
}

export function useWallet(): WalletState {
  const c = useContext(WalletCtx);
  if (!c) throw new Error("useWallet outside WalletProvider");
  return c;
}

// deterministic (no Math.random) fake hash for mock txids
function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h << 5) - h + s.charCodeAt(i);
  return h;
}
