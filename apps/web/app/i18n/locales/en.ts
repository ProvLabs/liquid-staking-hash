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
  "learn.incident-contract-halted": "Program halted",
  "learn.incident-vault-paused": "Vault paused",
  "learn.incident-slash-write-down": "Slash write-down",
  "learn.incident-redemption-refund": "Redemption refund",
  "learn.incident-jail-report": "Validator jail report",
  "learn.incident-epoch-overdue": "Settlement overdue",
  "learn.incident-reconciler-divergence": "Reconciler divergence",
  "learn.incident-indexer-lag": "Indexer lag",
  "learn.incident-desc-contract-halted":
    "The staking contract halted operations until operators cleared the condition.",
  "learn.incident-desc-vault-paused":
    "The vault was paused: deposits and redemptions were suspended until unpaused.",
  "learn.incident-desc-slash-write-down":
    "A validator slash reduced principal. The loss was written down at once and NAV stepped down.",
  "learn.incident-desc-redemption-refund":
    "A redemption matured without funds in the marker, so the escrowed shares were refunded to the owner.",
  "learn.incident-desc-jail-report":
    "A program validator was jailed. Its report stays open until it recovers or is removed from the set.",
  "learn.incident-desc-epoch-overdue":
    "A monthly settlement became eligible but had not run within its expected window.",
  "learn.incident-desc-reconciler-divergence":
    "The indexed view disagreed with chain state until reconciliation caught up.",
  "learn.incident-desc-indexer-lag":
    "Indexed history fell behind the chain, so indexed figures were stale while open.",
  "learn.incident-severity-info": "info",
  "learn.incident-severity-warning": "warning",
  "learn.incident-severity-critical": "critical",
  "learn.incidents-col-incident": "Incident",
  "learn.incidents-col-severity": "Severity",
  "learn.incidents-col-opened": "Opened",
  "learn.incidents-col-resolved": "Resolved",
  "learn.incidents-col-duration": "Duration",
  "learn.incidents-col-height": "Block",
  "learn.incident-na": "n/a",
  "learn.incidents-page": "Page {page} of {pages}",
  "learn.incidents-prev": "Previous",
  "learn.incidents-next": "Next",
  "learn.incidents-pagination": "Incident history pages",

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
  "portfolio.connected-as": "Connected as {address}. Position details arrive in a later milestone.",

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
