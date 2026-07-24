// English catalog — the reference locale. Every other locale must carry
// exactly this key set (test/i18n-coverage.test.ts). Voice per app-spec §11:
// plain, concrete, no exclamation points, no yield hype.

export default {
  "app.name": "nvHASH",
  "app.tagline": "Liquid staking for HASH",

  "home.title": "nvHASH liquid staking",
  "home.lede":
    "Deposit HASH, receive nvHASH, and redeem it for more HASH as staking rewards settle each month.",

  "learn.hero-step-note":
    "Value lands in monthly steps when the epoch settles. Between settlements your redemption value is flat, and that is normal.",
  "learn.flow-label": "How nvHASH works",
  "learn.flow-deposit": "Deposit HASH",
  "learn.flow-pool": "Pooled vault",
  "learn.flow-stake": "Staked across validators",
  "learn.flow-rewards": "Rewards restaked to compound",

  "learn.proof-title": "The program right now",
  "learn.stat-nav": "NAV",
  "learn.stat-nav-caption": "HASH per nvHASH",
  "learn.stat-apr": "Net APR",
  "learn.stat-apr-caption": "Gross {gross}% over {window}",
  "learn.stat-apr-na": "n/a (insufficient history)",
  "learn.stat-tvl": "Total value",
  "learn.stat-tvl-caption": "HASH",
  "learn.stat-participants": "Participants",
  "learn.stat-age": "Program age",
  "learn.stat-validators": "Eligible validators",
  "learn.stat-indexed-caption": "From indexed history",
  "learn.stat-na": "n/a",

  "learn.chart-title": "Redemption value by monthly settlement",
  "learn.chart-caption": "HASH per nvHASH at each monthly settlement; flat between settlements by design.",
  "learn.chart-empty":
    "No monthly settlements are indexed yet. The step chart appears as settlement history lands.",
  "learn.chart-unavailable": "Settlement history is unavailable right now.",
  "learn.chart-col-settlement": "Settlement",
  "learn.chart-col-ended": "Settled",
  "learn.chart-col-nav": "NAV (HASH)",

  "learn.yield-title": "Where the yield comes from",
  "learn.yield-body":
    "At each monthly settlement, staking rewards, validator-paid commission, and tips flow into the vault, and the AUM fee is deducted. Validators fund commission and tips from their own pockets; that is why the vault can out-yield staking on your own.",
  "learn.yield-rewards": "Staking rewards",
  "learn.yield-commission": "Validator commission",
  "learn.yield-tips": "Tips",
  "learn.yield-fee": "AUM fee (deducted)",
  "learn.yield-window-note": "Figures are from the current settlement window, in HASH.",
  "learn.yield-unavailable": "The yield decomposition is unavailable right now.",
  "learn.compare-title": "Compared with self-staking",
  "learn.compare-body":
    "Self-staking earns the base staking reward minus each validator's commission. nvHASH adds validator-paid commission and tips on top and handles delegation for you, at the cost of the AUM fee and monthly stepped settlement. A numeric side-by-side arrives when indexed history can support one.",

  "learn.trust-title": "Security and trust",
  "learn.trust-preaudit":
    "This program is pre-audit. A third-party audit of the staking contract is mandatory before mainnet launch; until a report is published here, treat this deployment as unaudited.",
  "learn.trust-governance":
    "Program authority is held by a multisig group on chain (x/group). Parameter changes and admin actions are group proposals, visible on the console.",
  "learn.trust-risk-title": "What can go wrong",
  "learn.trust-risk-contract":
    "Smart-contract risk: a defect in the vault or staking contract could impair funds. The contract source is public and the deployed build is verifiable on the console.",
  "learn.trust-risk-slashing":
    "Validator slashing: if a program validator is slashed, the loss is recognized immediately and NAV steps down. Write-downs appear in settlement history.",
  "learn.trust-risk-bridge":
    "Bridge boundary: cross-chain holders trust the bridge operator for custody of bridged supply. Native holders on Provenance do not.",

  "learn.incidents-title": "Incidents and slashing history",
  "learn.incidents-empty":
    "No slash events or program incidents in indexed history. This list is generated from chain history, not curated.",
  "learn.incidents-unavailable": "Incident history is unavailable right now.",
  "learn.incident-open": "open",
  "learn.incident-closed": "resolved",
  "learn.incident-contract-halted": "Program halted",
  "learn.incident-vault-paused": "Vault paused",
  "learn.incident-slash-write-down": "Slash write-down",
  "learn.incident-redemption-refund": "Redemption refund",
  "learn.incident-jail-report": "Validator jail report",
  "learn.incident-epoch-overdue": "Settlement overdue",
  "learn.incident-reconciler-divergence": "Reconciler divergence",
  "learn.incident-indexer-lag": "Indexer lag",

  "learn.exit-title": "Getting out",
  "learn.exit-native-title": "Native redemption",
  "learn.exit-native-body":
    "Redeem nvHASH with the program at protocol rate (NAV). Payout is guaranteed within 60 days of the request; when marker liquidity allows, redemptions complete sooner. The 60-day ceiling is the only promise.",
  "learn.exit-dex-title": "DEX trade",
  "learn.exit-dex-body":
    "Selling nvHASH on an exchange would be instant, at the market's price rather than NAV. No bridged nvHASH market exists in v1; this path opens when one does.",

  "learn.cta-title": "Ready to stake",
  "learn.cta-body": "Staking opens with wallet support in a later milestone.",
  "learn.cta-link": "Go to Stake",

  "chrome.console-link": "Verify on the console",
  "chrome.chain-label": "Chain",
  "chrome.env-development": "development",
  "chrome.env-staging": "staging",
  "chrome.env-production": "production",

  "chrome.nav-label": "Primary",
  "chrome.nav-menu": "Menu",
  "chrome.nav-learn": "Learn",
  "chrome.nav-stake": "Stake",
  "chrome.nav-portfolio": "Portfolio",
  "chrome.nav-market": "Market",
  "chrome.nav-validators": "Validators",
  "chrome.nav-governance": "Governance",

  "chrome.banner-paused-label": "Vault paused",
  "chrome.banner-paused-consequence":
    "Deposits, redemption payouts, and new redemption requests are on hold.",
  "chrome.banner-paused-reason": "Reason: {reason}",
  "chrome.banner-halted-label": "Program halted",
  "chrome.banner-halted-consequence":
    "Epoch processing is stopped. Staked funds stay where they are; nothing moves until operators resume the program.",
  "chrome.banner-degraded-label": "Data degraded",
  "chrome.banner-degraded-consequence":
    "Recent history may lag the chain. Live figures remain authoritative.",

  "chrome.alerts-advert": "Alerts arrive with wallet support",

  "chrome.freshness-indexed": "Indexed to block {height} ({age} ago)",
  "chrome.freshness-na": "Indexed to block n/a",
  "chrome.status-unavailable": "Program status unavailable",

  "stake.title": "Stake",
  "stake.placeholder":
    "Staking opens here in a later milestone. This deployment is a development scaffold; nothing can be deposited yet.",
  "portfolio.title": "Portfolio",
  "portfolio.placeholder":
    "Your position and history arrive here in a later milestone, after wallet connection lands. This deployment is a development scaffold.",
  "portfolio.connect-prompt":
    "Connect a wallet to see your position. Your portfolio is read from the chain and shown only for the connected address.",
  "portfolio.viewing-address": "Showing the position for {address}.",
  "portfolio.na": "n/a",

  "portfolio.summary-title": "Your position",
  "portfolio.balance-label": "nvHASH balance",
  "portfolio.balance-caption": "Your share balance",
  "portfolio.value-label": "Current value",
  "portfolio.value-caption-live": "Priced live at current NAV",
  "portfolio.value-caption-indexed": "From indexed history (live price unavailable)",
  "portfolio.nav-label": "Current NAV",
  "portfolio.nav-caption": "HASH per nvHASH",
  "portfolio.gain-label": "Accrued gain",
  "portfolio.gain-caption": "Since your first deposit",
  "portfolio.gain-up": "up",
  "portfolio.gain-down": "down",
  "portfolio.gain-flat": "flat",
  "portfolio.basis-label": "Cost basis",
  "portfolio.basis-aid": "Shown as an aid; the CSV export is the authoritative record.",
  "portfolio.realized-label": "Realized gain",
  "portfolio.realized-caption": "From completed redemptions",
  "portfolio.market-value-label": "Value at market price",
  "portfolio.market-value-soon": "Coming soon: activates when a bridged nvHASH market opens.",
  "portfolio.history-incomplete":
    "History incomplete: this address has activity the program's indexer does not track (transfers). Basis-derived figures may be understated and are shown as an aid only.",
  "portfolio.history-inconsistent":
    "Basis-derived figures are unavailable: the indexed history for this address is inconsistent and the program will not fabricate a number.",
  "portfolio.indexed-unavailable":
    "Your transaction history and derived figures are temporarily unavailable. The live balance and value above remain authoritative.",

  "portfolio.yield-title": "Effective yield",
  "portfolio.yield-apr-label": "Your effective APR",
  "portfolio.yield-apr-caption": "Annualized since your first deposit",
  "portfolio.yield-cold": "First epoch not yet settled. Your effective yield appears after the first monthly settlement.",
  "portfolio.yield-chart-title": "Your APR vs the program, by settlement",
  "portfolio.yield-chart-caption": "Percent per year at each monthly settlement.",
  "portfolio.yield-series-personal": "Your APR",
  "portfolio.yield-series-program": "Program net APR",
  "portfolio.yield-below-two":
    "Your per-settlement APR chart appears once at least two settlements have figures for your position.",
  "portfolio.yield-gap-note":
    "A gap between the two lines is usually timing: a deposit made partway through a settlement earns for only part of it, so your first settlements read low.",
  "portfolio.yield-col-personal": "Your APR",
  "portfolio.yield-col-program": "Program APR",

  "portfolio.accrual-title": "Position value over time",
  "portfolio.accrual-caption":
    "Your HASH value at each event and monthly settlement; flat between settlements by design.",
  "portfolio.accrual-cold": "Your value chart appears once your position has at least two points of history.",
  "portfolio.accrual-unavailable": "Your accrual history is unavailable right now.",
  "portfolio.accrual-truncated":
    "Showing the most recent events; earlier deposit and redeem markers are not listed.",
  "portfolio.accrual-history-truncated":
    "Showing the most recent points; earlier history is trimmed to keep the chart responsive.",
  "portfolio.accrual-col-time": "Time",
  "portfolio.accrual-col-value": "Value (HASH)",
  "portfolio.accrual-col-event": "Event",
  "portfolio.marker-in": "Deposit",
  "portfolio.marker-out": "Redeem",
  "portfolio.marker-label": "{event}: {shares} nvHASH",

  "portfolio.redemptions-title": "Active redemptions",
  "portfolio.redemptions-empty": "No active redemptions.",
  "portfolio.redemption-shares": "{shares} nvHASH",
  "portfolio.redemption-enqueued-at": "Requested {time}",
  "portfolio.redemption-expedited-at": "Expedited {time}",
  "portfolio.redemption-matured-at": "Matured {time}",
  "portfolio.redemption-refunded-at": "Refunded {time}",
  "portfolio.redemption-status-enqueued": "Enqueued",
  "portfolio.redemption-status-expedited": "Expedited",
  "portfolio.redemption-status-matured": "Matured",
  "portfolio.redemption-status-refunded": "Refunded",
  "portfolio.redemptions-tracker-note": "Full redemption tracking arrives with the Exit page.",

  "portfolio.history-title": "Transaction history",
  "portfolio.history-empty": "No transactions yet for this address.",
  "portfolio.history-col-time": "Time",
  "portfolio.history-col-kind": "Type",
  "portfolio.history-col-shares": "nvHASH",
  "portfolio.history-col-hash": "HASH",
  "portfolio.history-col-nav": "NAV at event",
  "portfolio.history-col-tx": "Transaction",
  "portfolio.history-explorer": "View on explorer",
  "portfolio.history-export": "Export CSV",
  "portfolio.history-prev": "Previous",
  "portfolio.history-next": "Next",
  "portfolio.history-page": "Page {page}",
  "portfolio.kind-swap-in": "Deposit",
  "portfolio.kind-swap-out-request": "Redemption request",
  "portfolio.kind-redemption-payout": "Redemption payout",
  "portfolio.kind-redemption-refund": "Redemption refund",
  "portfolio.kind-transfer-in": "Transfer in",
  "portfolio.kind-transfer-out": "Transfer out",

  "portfolio.alerts-title": "Alert settings",
  "portfolio.alerts-deferred": "Per-address alert rules arrive with a later milestone.",

  "wallet.connect": "Connect wallet",
  "wallet.disconnect": "Disconnect",
  "wallet.pick-vendor": "Choose a wallet",
  "wallet.connecting": "Waiting for the wallet…",
  "wallet.approve-in-wallet": "Approve the login request in your wallet. It signs a one-time message; nothing moves.",
  "wallet.scan-qr": "Scan with your wallet app",
  "wallet.error-wc-unconfigured":
    "Mobile wallet pairing is not configured on this deployment. The browser extension still works.",
  "wallet.error-extension-missing":
    "The Figure browser extension was not found. Install it, or pair a mobile wallet instead.",
  "wallet.error-failed": "The wallet declined or the connection failed. Nothing was signed.",

  "tx.confirm-title": "Review before signing",
  "tx.confirm-fee": "Estimated network fee: {fee}",
  "tx.confirm-disclosure": "Show the exact message your wallet will sign",
  "tx.confirm-cancel": "Cancel",
  "tx.confirm-sign": "Sign in wallet",
  "tx.pending-label": "Pending — waiting for the chain",
  "market.title": "Market",
  "market.lede":
    "Where nvHASH trades and where its supply lives. Market prices come from exchanges, not the chain, so every market figure here carries its venue and sample time.",

  "market.status-title": "Market price",
  "market.status-forthcoming":
    "No bridged nvHASH market exists yet; this section activates when nvHASH bridges and a market opens. Native redemption at protocol rate is available today.",
  "market.status-unavailable": "Market data is unavailable right now.",
  "market.sample-label": "{venue} · sampled {age} ago",
  "market.price-label": "Price",
  "market.price-caption": "HASH per nvHASH",
  "market.premium-label": "Premium / discount",
  "market.premium-caption": "vs the redemption value at the sample's time",
  "market.premium-na": "n/a",

  "market.explainer-title": "Why a spread exists",
  "market.explainer-body":
    "nvHASH's redemption value moves in monthly steps at settlement, while a market trades continuously, so a gap opens on either side of each step. Liquidity depth and bridge-transit costs widen it. Native redemption at protocol rate is always available and is the anchor a market prices against.",

  "market.depth-title": "Pool depth",
  "market.depth-col-side": "Side",
  "market.depth-col-slippage": "Slippage (bps)",
  "market.depth-col-size": "Size (nvHASH)",
  "market.depth-side-buy": "Buy",
  "market.depth-side-sell": "Sell",

  "market.supply-title": "Where nvHASH lives",
  "market.supply-local": "On Provenance",
  "market.supply-local-caption": "Live chain read",
  "market.supply-bridged-empty":
    "All nvHASH lives on Provenance today. Bridged supply appears here when the bridge opens.",
  "market.supply-col-chain": "Chain",
  "market.supply-col-supply": "Supply (nvHASH)",
  "market.supply-col-sampled": "Sampled",

  "market.history-title": "Program history",
  "market.history-nav-title": "Redemption value by monthly settlement",
  "market.history-nav-caption":
    "HASH per nvHASH at each settlement. The market price line joins this chart when a market opens.",
  "market.history-tvv-title": "Total vault value by monthly settlement",
  "market.history-tvv-caption": "HASH held by the program at each settlement.",
  "market.history-apr-title": "Net APR by monthly settlement",
  "market.history-apr-caption":
    "Percent per year for the window ending at each settlement; settlements without an APR figure are omitted.",
  "market.history-tvv-col": "Total value (HASH)",
  "market.history-apr-col": "Net APR",
  "market.history-unavailable": "Settlement history is unavailable right now.",
  "market.history-empty": "No monthly settlements are indexed yet.",

  "chart.show-table": "Table view",
  "chart.show-chart": "Chart view",
  "validators.title": "Validators",
  "validators.lede":
    "These validators stake the program's HASH. Their reliability is measured against the program's own thresholds, read live from chain.",
  "validators.na": "n/a",

  "validators.health-title": "Set health",
  "validators.health-eligible-now": "Eligible now",
  "validators.health-active": "Active in set",
  "validators.health-total": "Enrollments all-time",
  "validators.health-indexed-caption": "From indexed history",

  "validators.table-unavailable": "The validator set is unavailable right now.",
  "validators.table-empty": "No validators are enrolled in the program yet.",
  "validators.col-validator": "Validator",
  "validators.col-status": "Status",
  "validators.col-uptime": "Uptime",
  "validators.col-delegation": "Program delegation",
  "validators.col-tenure": "In program for",
  "validators.status-eligible": "Eligible",
  "validators.status-ineligible": "Ineligible",
  "validators.status-jailed": "Jailed",
  "validators.status-tombstoned": "Tombstoned",
  "validators.uptime-vs-threshold": "{uptime}% / {threshold}% required",
  "validators.uptime-na": "n/a (no capture yet)",
  "governance.title": "Governance",
  "governance.placeholder":
    "Governance participation arrives here in a later milestone. This deployment is a development scaffold.",

  "theme.toggle-label": "Theme",
  "theme.auto": "Auto",
  "theme.light": "Light",
  "theme.dark": "Dark",

  "error.not-found-title": "Page not found",
  "error.not-found-body": "There is nothing at this address.",
  "error.boot-title": "The app could not start",
  "error.generic-title": "Something went wrong",
  "error.generic-body": "The error has been logged. Try again shortly.",
} as const;
