// Data layer store (spec §9). Owns polling, cache, freshness, the epoch ledger, and role
// detection. Hooks return { data, fetchedAt, error }. Mock mode loads fixtures once and
// seeds the ledger; real mode polls the LCD in three tiers (§9.2) and appends snapshots.
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { config } from "@/config";
import { smartQuery, vaultQuery, pendingSwapOuts, stakingTotals, latestBlock } from "@/data/lcd";
import { ledgerAll, ledgerAppend, ledgerSeed } from "@/data/ledger";
import * as fx from "@/data/fixtures";
import { useWallet, type Role } from "@/tx/wallet";
import type {
  AprResponse,
  ConfigResponse,
  DeploymentSplit,
  EpochSnapshot,
  EpochStatusResponse,
  JailReportsResponse,
  LedgerRow,
  PendingSwapOut,
  ValidatorsResponse,
  VaultInfo,
} from "@/lib/types";

export interface Cell<T> {
  data: T | null;
  fetchedAt: number; // ms; 0 = never
  error: string | null;
}
function empty<T>(): Cell<T> {
  return { data: null, fetchedAt: 0, error: null };
}

interface StoreData {
  config: Cell<ConfigResponse>;
  epoch: Cell<EpochStatusResponse>;
  validators: Cell<ValidatorsResponse>;
  jail: Cell<JailReportsResponse>;
  snapshot: Cell<EpochSnapshot | null>;
  apr: Cell<AprResponse | null>;
  vault: Cell<VaultInfo>;
  swapOuts: Cell<PendingSwapOut[]>;
  deployment: Cell<DeploymentSplit>;
  block: Cell<{ height: number; timeSecs: number }>;
  ledger: LedgerRow[];
}

interface StoreState extends StoreData {
  nowSecs: number;
  stale: boolean;
  role: Role;
  refresh: (keys?: (keyof StoreData)[]) => void;
}

const StoreCtx = createContext<StoreState | null>(null);

export function StoreProvider({ children }: { children: ReactNode }) {
  const wallet = useWallet();
  const [d, setD] = useState<StoreData>({
    config: empty(),
    epoch: empty(),
    validators: empty(),
    jail: empty(),
    snapshot: empty(),
    apr: empty(),
    vault: empty(),
    swapOuts: empty(),
    deployment: empty(),
    block: empty(),
    ledger: [],
  });
  const [nowSecs, setNowSecs] = useState(Math.floor(Date.now() / 1000));
  const missesRef = useRef(0);
  const [stale, setStale] = useState(false);

  // ticking clock for countdowns (§11.5)
  useEffect(() => {
    const id = window.setInterval(() => setNowSecs(Math.floor(Date.now() / 1000)), 1000);
    return () => window.clearInterval(id);
  }, []);

  const set = useCallback(<K extends keyof StoreData>(key: K, value: StoreData[K]) => {
    setD((cur) => ({ ...cur, [key]: value }));
  }, []);

  const now = () => Date.now();

  const loadMock = useCallback(async () => {
    set("config", { data: fx.mockConfig, fetchedAt: now(), error: null });
    set("epoch", { data: fx.mockEpochStatus, fetchedAt: now(), error: null });
    set("validators", { data: fx.mockValidators, fetchedAt: now(), error: null });
    set("jail", { data: fx.mockJailReports, fetchedAt: now(), error: null });
    set("snapshot", { data: fx.mockSnapshot, fetchedAt: now(), error: null });
    set("apr", { data: fx.mockApr, fetchedAt: now(), error: null });
    set("vault", { data: fx.mockVault, fetchedAt: now(), error: null });
    set("swapOuts", { data: fx.mockSwapOuts, fetchedAt: now(), error: null });
    set("deployment", { data: fx.mockDeployment, fetchedAt: now(), error: null });
    set("block", { data: { height: fx.mockSnapshot.end_height, timeSecs: nowSecs }, error: null, fetchedAt: now() });
    await ledgerSeed(fx.mockLedger);
    set("ledger", await ledgerAll());
  }, [set, nowSecs]);

  const loadReal = useCallback(
    async (keys?: (keyof StoreData)[]) => {
      const want = (k: keyof StoreData) => !keys || keys.includes(k);
      const one = async <T,>(key: keyof StoreData, fn: () => Promise<T>) => {
        if (!want(key)) return;
        try {
          const data = await fn();
          set(key, { data, fetchedAt: now(), error: null } as StoreData[typeof key]);
          missesRef.current = 0;
        } catch (e) {
          set(key, { ...(d[key] as Cell<T>), error: e instanceof Error ? e.message : String(e) } as StoreData[typeof key]);
          missesRef.current += 1;
        }
      };
      await Promise.all([
        one("config", () => smartQuery<ConfigResponse>({ config: {} })),
        one("epoch", () => smartQuery<EpochStatusResponse>({ epoch_status: {} })),
        one("validators", () => smartQuery<ValidatorsResponse>({ validators: {} })),
        one("jail", () => smartQuery<JailReportsResponse>({ jail_reports: {} })),
        one("snapshot", () =>
          smartQuery<{ snapshot: EpochSnapshot | null }>({ epoch_snapshot: {} }).then((r) => r.snapshot),
        ),
        one("apr", () => smartQuery<AprResponse>({ apr: {} }).catch(() => null)),
        one("block", () => latestBlock()),
        one("vault", async () => {
          const cfg = d.config.data;
          if (!cfg) throw new Error("config not loaded");
          return vaultQuery(cfg.vault_address);
        }),
        one("swapOuts", async () => {
          const cfg = d.config.data;
          if (!cfg) throw new Error("config not loaded");
          return pendingSwapOuts(cfg.vault_address);
        }),
        one("deployment", async () => {
          // delegated + unbonding fetched fresh; liquid/pending use last-known vault/epoch
          // (they converge within a tick). Falls back to 0 before those first resolve.
          const { delegated, unbonding } = await stakingTotals(config.contractAddress);
          const liquid = d.vault.data?.principal_liquid_nhash ?? "0";
          const pending = (d.epoch.data?.pending_delegations ?? []).reduce((a, p) => (BigInt(a) + BigInt(p.amount)).toString(), "0");
          return { delegated, unbonding, liquid, pending };
        }),
      ]);
      setStale(missesRef.current >= config.staleAfterMisses);
      // append snapshot to the ledger when epoch_index advances
      const snap = d.snapshot.data;
      const apr = d.apr.data;
      if (snap) {
        await ledgerAppend({
          ...snap,
          net_apr_bps: apr?.net_apr_bps ?? 0,
          gross_apr_bps: apr?.gross_apr_bps ?? 0,
          observed_at: Math.floor(now() / 1000),
        });
        set("ledger", await ledgerAll());
      }
    },
    [set, d],
  );

  const refresh = useCallback(
    (keys?: (keyof StoreData)[]) => {
      if (config.mock) void loadMock();
      else void loadReal(keys);
    },
    [loadMock, loadReal],
  );

  // initial load + real-mode poll tiers (§9.2)
  useEffect(() => {
    refresh();
    if (config.mock) return;
    const fast = window.setInterval(() => loadReal(["epoch", "block", "vault"]), config.pollFastSecs * 1000);
    const med = window.setInterval(
      () => loadReal(["validators", "jail", "swapOuts", "deployment"]),
      config.pollMedSecs * 1000,
    );
    const slow = window.setInterval(() => loadReal(["config", "snapshot", "apr"]), config.pollSlowSecs * 1000);
    return () => {
      window.clearInterval(fast);
      window.clearInterval(med);
      window.clearInterval(slow);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // role detection = on-chain fact (spec Decision 4)
  const role = useMemo<Role>(() => {
    const addr = wallet.address;
    if (!addr) return "observer";
    if (d.config.data && addr === d.config.data.admin) return "admin";
    if (d.validators.data?.validators.some((v) => v.operator === addr)) return "operator";
    return "keeper";
  }, [wallet.address, d.config.data, d.validators.data]);

  const value: StoreState = { ...d, nowSecs, stale, role, refresh };
  return <StoreCtx.Provider value={value}>{children}</StoreCtx.Provider>;
}

export function useStore(): StoreState {
  const c = useContext(StoreCtx);
  if (!c) throw new Error("useStore outside StoreProvider");
  return c;
}

// thin accessors
export const useConfig = () => useStore().config;
export const useEpoch = () => useStore().epoch;
export const useValidators = () => useStore().validators;
export const useJail = () => useStore().jail;
export const useSnapshot = () => useStore().snapshot;
export const useApr = () => useStore().apr;
export const useVault = () => useStore().vault;
export const useSwapOuts = () => useStore().swapOuts;
export const useDeployment = () => useStore().deployment;
export const useLedger = () => useStore().ledger;
export const useNow = () => useStore().nowSecs;
export const useRole = () => useStore().role;
