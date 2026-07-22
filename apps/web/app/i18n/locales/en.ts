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
  "learn.chart-show-table": "Table view",
  "learn.chart-show-chart": "Chart view",
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
  "market.title": "Market",
  "market.placeholder":
    "Market data for nvHASH arrives here in a later milestone. This deployment is a development scaffold.",
  "validators.title": "Validators",
  "validators.lede":
    "These validators stake the program's HASH. Their reliability is measured against the program's own thresholds, read live from chain.",
  "validators.na": "n/a",

  "validators.health-title": "Set health",
  "validators.health-eligible-now": "Eligible now",
  "validators.health-joined": "Joined last settlement",
  "validators.health-departed": "Departed last settlement",
  "validators.health-indexed-caption": "From indexed history",
  "validators.health-trend-title": "Eligible validators by monthly settlement",
  "validators.health-trend-empty":
    "No monthly settlements are indexed yet. The trend appears as settlement history lands.",
  "validators.health-trend-unavailable": "Set history is unavailable right now.",
  "validators.trend-show-table": "Table view",
  "validators.trend-show-chart": "Chart view",
  "validators.trend-col-settlement": "Settlement",
  "validators.trend-col-eligible": "Eligible",
  "validators.trend-col-joined": "Joined",
  "validators.trend-col-departed": "Departed",

  "validators.table-unavailable": "The validator set is unavailable right now.",
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
