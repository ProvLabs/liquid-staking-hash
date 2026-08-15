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
import {
  smartQuery,
  vaultQuery,
  pendingSwapOuts,
  stakingTotals,
  latestBlock,
  groupPolicyInfo,
  groupInfo,
  groupPoliciesByGroup,
  groupMembers,
  proposalsByPolicy,
  proposalTally,
  votesByProposal,
} from "@/data/lcd";
import { ledgerAll, ledgerAppend, ledgerSeed } from "@/data/ledger";

/** Mock rendering exists ONLY in the devnet build profile — a compile-time
 *  constant Vite folds, so the fixture corpus (and its mock identities) is
 *  dead-code-eliminated from test/production bundles (spec §10.1, enforced
 *  by scripts/check-bundle.mjs; the fixtures arrive via a dynamic import
 *  inside the folded branch so no chunk is even emitted). VITE_MOCK in a
 *  non-devnet profile is inert. */
const MOCK_AVAILABLE = import.meta.env.MODE === "devnet";
import type { GovProposalRow, GovProposals, GovTopology } from "@/lib/governance";
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
  // /governance (§2.2): topology on the slow tier, proposals+tally on medium.
  // A topology cell ERROR is "could not check"; `state: "no-group"` is the
  // 404 plain-account FACT — the two must never conflate (§x/group 8).
  govTopology: Cell<GovTopology>;
  govProposals: Cell<GovProposals>;
}

interface StoreState extends StoreData {
  nowSecs: number;
  stale: boolean;
  role: Role;
  /** True once the persisted epoch ledger has been read (even if empty) —
   *  "no rows" is a fact only after this; before it, absence is unknown. */
  ledgerLoaded: boolean;
  refresh: (keys?: (keyof StoreData)[]) => void;
}

const StoreCtx = createContext<StoreState | null>(null);

/** Wall clock in ms. Module scope: it captures nothing, so hook dependency
 *  arrays stay stable across renders. */
const now = () => Date.now();

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
    govTopology: empty(),
    govProposals: empty(),
  });
  const [nowSecs, setNowSecs] = useState(Math.floor(Date.now() / 1000));
  const missesRef = useRef(0);
  const [stale, setStale] = useState(false);
  const [ledgerLoaded, setLedgerLoaded] = useState(false);

  // ticking clock for countdowns (§11.5)
  useEffect(() => {
    const id = window.setInterval(() => setNowSecs(Math.floor(Date.now() / 1000)), 1000);
    return () => window.clearInterval(id);
  }, []);

  // Mutable mirror of the store for the async loaders. The poll intervals are
  // mount-scoped, so an interval-held closure reading `d` directly would be
  // frozen at the first (empty) state forever: vault/swapOuts would never see
  // config, deployment would compute against zero balances, and the ledger
  // would never append. `set` updates the mirror synchronously (ahead of the
  // React commit) so loaders always read the latest cells, including ones
  // written earlier in the same poll pass.
  const dRef = useRef(d);

  const set = useCallback(<K extends keyof StoreData>(key: K, value: StoreData[K]) => {
    dRef.current = { ...dRef.current, [key]: value };
    setD((cur) => ({ ...cur, [key]: value }));
  }, []);

  const loadMock = useCallback(async () => {
    if (!MOCK_AVAILABLE) return;
    const fx = await import("@/data/fixtures");
    set("config", { data: fx.mockConfig, fetchedAt: now(), error: null });
    set("epoch", { data: fx.mockEpochStatus, fetchedAt: now(), error: null });
    set("validators", { data: fx.mockValidators, fetchedAt: now(), error: null });
    set("jail", { data: fx.mockJailReports, fetchedAt: now(), error: null });
    set("snapshot", { data: fx.mockSnapshot, fetchedAt: now(), error: null });
    set("apr", { data: fx.mockApr, fetchedAt: now(), error: null });
    set("vault", { data: fx.mockVault, fetchedAt: now(), error: null });
    set("swapOuts", { data: fx.mockSwapOuts, fetchedAt: now(), error: null });
    set("deployment", { data: fx.mockDeployment, fetchedAt: now(), error: null });
    set("govTopology", { data: fx.mockGovTopology, fetchedAt: now(), error: null });
    set("govProposals", { data: fx.mockGovProposals, fetchedAt: now(), error: null });
    set("block", {
      data: { height: fx.mockSnapshot.end_height, timeSecs: nowSecs },
      error: null,
      fetchedAt: now(),
    });
    await ledgerSeed(fx.mockLedger);
    set("ledger", await ledgerAll());
  }, [set, nowSecs]);

  const loadReal = useCallback(
    async (keys?: (keyof StoreData)[]) => {
      const want = (k: keyof StoreData) => !keys || keys.includes(k);
      const fetchCell = async <T,>(key: keyof StoreData, fn: () => Promise<T>) => {
        try {
          const data = await fn();
          set(key, { data, fetchedAt: now(), error: null } as StoreData[typeof key]);
          missesRef.current = 0;
        } catch (e) {
          set(key, {
            ...(dRef.current[key] as Cell<T>),
            error: e instanceof Error ? e.message : String(e),
          } as StoreData[typeof key]);
          missesRef.current += 1;
        }
      };
      const one = async <T,>(key: keyof StoreData, fn: () => Promise<T>) => {
        if (!want(key)) return;
        await fetchCell(key, fn);
      };
      // Config gates the vault/swapOut queries (it carries the vault address),
      // so resolve it before the concurrent pass whenever it is wanted or has
      // never loaded — the first real-mode poll then completes in one pass.
      if (want("config") || !dRef.current.config.data) {
        await fetchCell("config", () => smartQuery<ConfigResponse>({ config: {} }));
      }
      // The proposal read is gated on the topology (it enumerates the
      // discovered policies), so resolve topology first the same way config
      // gates the vault reads — the first pass then completes in one poll.
      if (want("govTopology") || (want("govProposals") && !dRef.current.govTopology.data)) {
        await fetchCell("govTopology", async () => {
          const cfg = dRef.current.config.data;
          if (!cfg) throw new Error("config not loaded");
          // A 404 returns the plain-account fact; anything else THROWS into
          // the cell's error channel and renders "could not check".
          const lookup = await groupPolicyInfo(cfg.admin);
          if (!lookup.found) return { state: "no-group" } as GovTopology;
          const groupId = lookup.info.group_id;
          const [policies, members, group] = await Promise.all([
            groupPoliciesByGroup(groupId),
            groupMembers(groupId),
            // group_info enriches (total weight); its failure degrades the
            // figure, not the topology (§9.6 per-section failure).
            groupInfo(groupId).catch(() => null),
          ]);
          return { state: "governed", groupId, group, policies, members } as GovTopology;
        });
      }
      await Promise.all([
        one("epoch", () => smartQuery<EpochStatusResponse>({ epoch_status: {} })),
        one("validators", () => smartQuery<ValidatorsResponse>({ validators: {} })),
        one("jail", () => smartQuery<JailReportsResponse>({ jail_reports: {} })),
        one("snapshot", () =>
          smartQuery<{ snapshot: EpochSnapshot | null }>({ epoch_snapshot: {} }).then(
            (r) => r.snapshot,
          ),
        ),
        one("apr", () => smartQuery<AprResponse>({ apr: {} }).catch(() => null)),
        one("block", () => latestBlock()),
        one("vault", async () => {
          const cfg = dRef.current.config.data;
          if (!cfg) throw new Error("config not loaded");
          return vaultQuery(cfg.vault_address);
        }),
        one("swapOuts", async () => {
          const cfg = dRef.current.config.data;
          if (!cfg) throw new Error("config not loaded");
          return pendingSwapOuts(cfg.vault_address);
        }),
        one("govProposals", async () => {
          const topo = dRef.current.govTopology.data;
          if (!topo) throw new Error("group topology not loaded");
          if (topo.state !== "governed") return { rows: [], truncated: false } as GovProposals;
          let truncated = false;
          const rows: GovProposalRow[] = [];
          for (const policy of topo.policies.items) {
            const page = await proposalsByPolicy(policy.address);
            truncated = truncated || page.truncated;
            for (const proposal of page.items) {
              const row: GovProposalRow = {
                proposal,
                policyAddress: policy.address,
                liveTally: null,
                liveTallyError: null,
                votes: null,
              };
              // Tally and votes exist only while SUBMITTED (§x/group 2, 7);
              // a failed per-row read degrades that row's cell, not the list.
              if (proposal.status === "PROPOSAL_STATUS_SUBMITTED") {
                try {
                  row.liveTally = await proposalTally(proposal.id);
                } catch (e) {
                  row.liveTallyError = e instanceof Error ? e.message : String(e);
                }
                row.votes = await votesByProposal(proposal.id).catch(() => null);
              }
              rows.push(row);
            }
          }
          return { rows, truncated } as GovProposals;
        }),
        one("deployment", async () => {
          // delegated + unbonding fetched fresh; liquid/pending use last-known vault/epoch
          // (they converge within a tick). Falls back to 0 before those first resolve.
          const { delegated, unbonding } = await stakingTotals(config.contractAddress);
          const liquid = dRef.current.vault.data?.principal_liquid_nhash ?? "0";
          const pending = (dRef.current.epoch.data?.pending_delegations ?? []).reduce(
            (a, p) => (BigInt(a) + BigInt(p.amount)).toString(),
            "0",
          );
          return { delegated, unbonding, liquid, pending };
        }),
      ]);
      setStale(missesRef.current >= config.staleAfterMisses);
      // append snapshot to the ledger when epoch_index advances
      const snap = dRef.current.snapshot.data;
      const apr = dRef.current.apr.data;
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
    [set],
  );

  const refresh = useCallback(
    (keys?: (keyof StoreData)[]) => {
      if (MOCK_AVAILABLE && config.mock) void loadMock();
      else void loadReal(keys);
    },
    [loadMock, loadReal],
  );

  // Persisted-ledger read on mount, both modes: the epoch anchor's miss
  // decision (use-anchor.ts) is made once, so it must wait for this read —
  // an empty array before IndexedDB answers is "unknown", not "no history".
  useEffect(() => {
    void ledgerAll().then((rows) => {
      if (rows.length > 0) set("ledger", rows);
      setLedgerLoaded(true);
    });
  }, [set]);

  // initial load + real-mode poll tiers (§9.2)
  useEffect(() => {
    refresh();
    if (MOCK_AVAILABLE && config.mock) return;
    const fast = window.setInterval(
      () => loadReal(["epoch", "block", "vault"]),
      config.pollFastSecs * 1000,
    );
    const med = window.setInterval(
      () => loadReal(["validators", "jail", "swapOuts", "deployment", "govProposals"]),
      config.pollMedSecs * 1000,
    );
    const slow = window.setInterval(
      () => loadReal(["config", "snapshot", "apr", "govTopology"]),
      config.pollSlowSecs * 1000,
    );
    return () => {
      window.clearInterval(fast);
      window.clearInterval(med);
      window.clearInterval(slow);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refresh, loadReal]);

  // role detection = on-chain fact (spec Decision 4)
  const role = useMemo<Role>(() => {
    const addr = wallet.address;
    if (!addr) return "observer";
    if (d.config.data && addr === d.config.data.admin) return "admin";
    if (d.validators.data?.validators.some((v) => v.operator === addr)) return "operator";
    return "keeper";
  }, [wallet.address, d.config.data, d.validators.data]);

  const value: StoreState = { ...d, nowSecs, stale, role, ledgerLoaded, refresh };
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
export const useLedgerLoaded = () => useStore().ledgerLoaded;
export const useGovTopology = () => useStore().govTopology;
export const useGovProposals = () => useStore().govProposals;
export const useNow = () => useStore().nowSecs;
export const useRole = () => useStore().role;
