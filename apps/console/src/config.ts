// Build-time deployment configuration (spec §7). One profile per Vite mode; values
// arrive as VITE_* env vars and are frozen into this typed object at startup.
// The console holds no role list or authority of its own - roles come from chain
// (spec Decision 4) and the contract is the enforcement boundary (spec §12).

export interface AppConfig {
  mock: boolean;
  chainId: string;
  lcdUrl: string;
  contractAddress: string;
  denomExponent: number; // 1 HASH = 1e9 nhash
  displayDenom: string; // HASH
  baseDenom: string; // nhash
  shareExponent: number; // 1 nvHASH = 1e15 nvhash
  shareDisplayDenom: string; // nvHASH
  shareBaseDenom: string; // nvhash
  pollFastSecs: number;
  pollMedSecs: number;
  pollSlowSecs: number;
  staleAfterMisses: number;
  gasPrice: string; // e.g. "1905nhash"
  redemptionMarginBps: number; // display mirror of the contract constant
  devnetKeyMode: boolean;
  explorerTxBase: string;
  explorerAccountBase: string;
}

const env = import.meta.env;

function bool(v: unknown, dflt = false): boolean {
  if (v === undefined || v === null || v === "") return dflt;
  return String(v).toLowerCase() === "true";
}
function num(v: unknown, dflt: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}

export const config: AppConfig = Object.freeze({
  mock: bool(env.VITE_MOCK, true),
  chainId: env.VITE_CHAIN_ID ?? "nvhash-devnet-1",
  lcdUrl: env.VITE_LCD_URL ?? "http://localhost:1317",
  contractAddress: env.VITE_CONTRACT_ADDRESS ?? "",
  denomExponent: num(env.VITE_DENOM_EXPONENT, 9),
  displayDenom: env.VITE_DISPLAY_DENOM ?? "HASH",
  baseDenom: env.VITE_BASE_DENOM ?? "nhash",
  shareExponent: num(env.VITE_SHARE_EXPONENT, 15),
  shareDisplayDenom: env.VITE_SHARE_DISPLAY_DENOM ?? "nvHASH",
  shareBaseDenom: env.VITE_SHARE_BASE_DENOM ?? "nvhash",
  pollFastSecs: num(env.VITE_POLL_FAST_SECS, 10),
  pollMedSecs: num(env.VITE_POLL_MED_SECS, 30),
  pollSlowSecs: num(env.VITE_POLL_SLOW_SECS, 300),
  staleAfterMisses: num(env.VITE_STALE_AFTER_MISSES, 3),
  gasPrice: env.VITE_GAS_PRICE ?? "1905nhash",
  redemptionMarginBps: num(env.VITE_REDEMPTION_MARGIN_BPS, 50),
  devnetKeyMode: bool(env.VITE_DEVNET_KEY_MODE, false),
  explorerTxBase: env.VITE_EXPLORER_TX_BASE ?? "",
  explorerAccountBase: env.VITE_EXPLORER_ACCOUNT_BASE ?? "",
});

export const isMainnet = config.chainId === "pio-mainnet-1";
