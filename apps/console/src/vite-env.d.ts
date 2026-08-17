/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_MOCK?: string;
  readonly VITE_CHAIN_ID?: string;
  readonly VITE_LCD_URL?: string;
  readonly VITE_CONTRACT_ADDRESS?: string;
  readonly VITE_DENOM_EXPONENT?: string;
  readonly VITE_DISPLAY_DENOM?: string;
  readonly VITE_BASE_DENOM?: string;
  readonly VITE_SHARE_EXPONENT?: string;
  readonly VITE_SHARE_DISPLAY_DENOM?: string;
  readonly VITE_SHARE_BASE_DENOM?: string;
  readonly VITE_POLL_FAST_SECS?: string;
  readonly VITE_POLL_MED_SECS?: string;
  readonly VITE_POLL_SLOW_SECS?: string;
  readonly VITE_STALE_AFTER_MISSES?: string;
  readonly VITE_REDEMPTION_MARGIN_BPS?: string;
  readonly VITE_DEVNET_KEY_MODE?: string;
  readonly VITE_EXPLORER_TX_BASE?: string;
  readonly VITE_EXPLORER_ACCOUNT_BASE?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare const __CORPUS_CERTIFIED__: boolean;
