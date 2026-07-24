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
  "chrome.nav-exit": "Redeem",
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
  "stake.educate-what":
    "You deposit HASH into the vault and receive nvHASH at the current rate. Value accrues in monthly steps as each epoch settles, and you can redeem back to HASH at any time.",
  "stake.educate-fixed": "Your nvHASH amount stays fixed; its redemption value grows.",
  "stake.next-epoch": "Next expected epoch step: {date}.",
  "stake.unavailable": "The vault could not be read right now. Staking is unavailable until it recovers.",
  "stake.paused": "Deposits are paused: {reason}. They resume automatically when the vault is unpaused.",
  "stake.paused-generic": "the vault is paused",
  "stake.connect-prompt": "Connect a wallet to stake. You approve every transaction in your wallet.",
  "stake.amount-label": "Amount to deposit (HASH)",
  "stake.balance": "Spendable balance: {balance} HASH",
  "stake.limits": "Vault limits — min {min} HASH, max {max} HASH.",
  "stake.preview": "You would receive about {shares} nvHASH.",
  "stake.preview-empty-vault": "The vault has no value yet, so a rate cannot be shown.",
  "stake.preview-estimate-note":
    "Estimate at the current rate. The mint happens at the execution-time rate, which may differ slightly.",
  "stake.amount-invalid": "Enter a plain HASH amount (up to 9 decimal places).",
  "stake.review": "Review deposit",
  "stake.confirm-deposit": "Deposit {amount} HASH into the vault.",
  "stake.confirm-rate-note": "nvHASH mints at the execution-time rate; its redemption value grows with each epoch.",
  "exit.title": "Redeem & Exit",
  "exit.lede":
    "Two ways out. Compare them before you choose — the native redemption pays full value at a guaranteed date; the market path will arrive once nvHASH is bridged.",
  "exit.comparison-caption": "Comparison of the two exit paths: DEX trade and native redemption",
  "exit.coming-soon": "Coming soon",
  "exit.col-dex": "Trade on a DEX (instant)",
  "exit.col-native": "Redeem natively (protocol rate)",
  "exit.row-you-get": "You get",
  "exit.row-timing": "Timing",
  "exit.row-risks": "Risks",
  "exit.dex-you-get": "Market price minus slippage — available once nvHASH is bridged to a DEX.",
  "exit.dex-timing": "Instant on the destination chain, after bridging. Not available yet.",
  "exit.dex-risks": "Premium or discount to value, pool depth, and bridge transit.",
  "exit.native-you-get": "Full value at maturity, re-priced at payout.",
  "exit.native-guarantee": "Guaranteed within {days} days.",
  "exit.native-typical": "Typically sooner — recently, a median of {median} days (90% within {p90} days). Typical, not guaranteed.",
  "exit.native-typical-withheld": "Not enough recent redemptions to show a typical time yet; the {days}-day guarantee stands.",
  "exit.native-risks": "None beyond the wait. An unfunded maturity refunds your shares — never a loss.",
  "exit.native-title": "Redeem nvHASH for HASH",
  "exit.unavailable": "The vault could not be read right now. Redemption is unavailable until it recovers.",
  "exit.paused": "Redemptions are paused: {reason}. They resume automatically when the vault is unpaused.",
  "exit.paused-generic": "the vault is paused",
  "exit.connect-prompt": "Connect a wallet to redeem. You approve every transaction in your wallet.",
  "exit.amount-label": "Amount to redeem (nvHASH)",
  "exit.balance": "Your balance: {balance} nvHASH",
  "exit.preview": "Estimated value now: {value} HASH.",
  "exit.preview-reprice-note":
    "This re-prices at payout. Estimates rise if an epoch settles before your redemption matures.",
  "exit.amount-invalid": "Enter a plain nvHASH amount (up to 15 decimal places).",
  "exit.review": "Review redemption",
  "exit.confirm-escrow": "Your {shares} nvHASH escrow now.",
  "exit.confirm-guarantee": "Guaranteed release within {days} days.",
  "exit.confirm-typical": "Typically sooner — recently a median of {median} days (typical, not guaranteed).",
  "exit.confirm-typical-withheld": "A typical time is not shown yet; the guarantee above stands.",
  "exit.confirm-refund": "If a maturity is unfunded, your shares are refunded — never a loss.",
  "exit.tracker-title": "Your redemptions",
  "exit.tracker-empty": "No redemptions in flight. When you redeem, its progress shows here.",
  "exit.tracker-enqueued": "In the redemption queue",
  "exit.tracker-expedited": "Expedited — releasing early",
  "exit.tracker-shares": "{shares} nvHASH escrowed",
  "exit.tracker-queue-position": "Queue position {position} of {total}",
  "exit.tracker-countdown": "Guaranteed within {days} days.",
  "exit.tracker-expedite-note": "“Expedited” means the vault had funds to release you early, ahead of the guarantee.",
  "exit.tracker-paid": "Paid out",
  "exit.tracker-refunded": "Refunded (unfunded maturity — shares returned, no loss)",
  "exit.tracker-payout-amount": "Received {amount} HASH",
  "exit.tracker-refund-shares": "{shares} nvHASH returned",

  "portfolio.title": "Portfolio",
  "portfolio.placeholder":
    "Your position and history arrive here in a later milestone, after wallet connection lands. This deployment is a development scaffold.",
  "portfolio.connect-prompt":
    "Connect a wallet to see your position. Your portfolio is read from the chain and shown only for the connected address.",
  "portfolio.connected-as": "Connected as {address}. Position details arrive in a later milestone.",
  "portfolio.position-title": "Your position",
  "portfolio.balance": "{shares} nvHASH",
  "portfolio.value-at-nav": "≈ {value} HASH at the current rate",
  "portfolio.no-position": "No nvHASH yet. Stake HASH to begin.",
  "portfolio.value-unavailable": "Position value is unavailable right now.",
  "portfolio.full-page-note": "Your full history, yield panel, and CSV export arrive in a later milestone.",

  "tx.reason-vault-paused": "The vault is paused, so this cannot proceed right now.",
  "tx.reason-vault-paused-detail": "The vault is paused ({detail}), so this cannot proceed right now.",
  "tx.reason-swaps-disabled": "This action is currently disabled on the vault.",
  "tx.reason-below-minimum": "Below the vault minimum of {minimum}.",
  "tx.reason-above-maximum": "Above the vault maximum of {maximum}.",
  "tx.reason-insufficient-balance": "Not enough balance: you have {balance}, this needs {required} including the fee.",
  "tx.reason-vesting-locked": "Some of your HASH is still vesting and cannot be deposited. Spendable now: {spendable} HASH.",
  "tx.reason-amount-invalid": "Enter a valid amount.",
  "tx.reason-account-missing": "This account has no on-chain activity yet. Receive some HASH first.",
  "tx.reason-chain-unavailable": "The chain could not be reached to check this. Try again shortly.",
  "tx.reconnect-to-sign": "Reconnect your wallet to sign — the session is active but the signing connection was lost.",
  "tx.status-signing": "Approve the transaction in your wallet…",
  "tx.view-explorer": "View on explorer",
  "tx.status-confirmed": "Confirmed on chain.",
  "tx.go-portfolio": "Go to your portfolio",
  "tx.failed-simulate": "The transaction could not be estimated and was not sent.",
  "tx.failed-sign": "Signing was declined or failed. Nothing was sent.",
  "tx.failed-broadcast": "The transaction was rejected before inclusion. Nothing moved.",
  "tx.failed-execute": "The transaction was included but failed on chain.",
  "tx.try-again": "Try again",

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
