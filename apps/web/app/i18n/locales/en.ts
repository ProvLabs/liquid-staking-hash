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
  "learn.chart-caption":
    "HASH per nvHASH at each monthly settlement; flat between settlements by design.",
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
  "stake.unavailable":
    "The vault could not be read right now. Staking is unavailable until it recovers.",
  "stake.paused":
    "Deposits are paused: {reason}. They resume automatically when the vault is unpaused.",
  "stake.paused-generic": "the vault is paused",
  "stake.connect-prompt":
    "Connect a wallet to stake. You approve every transaction in your wallet.",
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
  "stake.confirm-rate-note":
    "nvHASH mints at the execution-time rate; its redemption value grows with each epoch.",
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
  "exit.native-typical":
    "Typically sooner — recently, a median of {median} days (90% within {p90} days). Typical, not guaranteed.",
  "exit.native-typical-withheld":
    "Not enough recent redemptions to show a typical time yet; the {days}-day guarantee stands.",
  "exit.native-risks":
    "None beyond the wait. An unfunded maturity refunds your shares — never a loss.",
  "exit.native-title": "Redeem nvHASH for HASH",
  "exit.unavailable":
    "The vault could not be read right now. Redemption is unavailable until it recovers.",
  "exit.paused":
    "Redemptions are paused: {reason}. They resume automatically when the vault is unpaused.",
  "exit.paused-generic": "the vault is paused",
  "exit.connect-prompt":
    "Connect a wallet to redeem. You approve every transaction in your wallet.",
  "exit.amount-label": "Amount to redeem (nvHASH)",
  "exit.balance": "Your balance: {balance} nvHASH",
  "exit.preview": "Estimated value now: {value} HASH.",
  "exit.preview-reprice-note":
    "This re-prices at payout. Estimates rise if an epoch settles before your redemption matures.",
  "exit.amount-invalid": "Enter a plain nvHASH amount (up to 15 decimal places).",
  "exit.review": "Review redemption",
  "exit.confirm-escrow": "Your {shares} nvHASH escrow now.",
  "exit.confirm-guarantee": "Guaranteed release within {days} days.",
  "exit.confirm-typical":
    "Typically sooner — recently a median of {median} days (typical, not guaranteed).",
  "exit.confirm-typical-withheld": "A typical time is not shown yet; the guarantee above stands.",
  "exit.confirm-refund": "If a maturity is unfunded, your shares are refunded — never a loss.",
  "exit.tracker-title": "Your redemptions",
  "exit.tracker-empty": "No redemptions in flight. When you redeem, its progress shows here.",
  "exit.tracker-enqueued": "In the redemption queue",
  "exit.tracker-expedited": "Expedited — releasing early",
  "exit.tracker-shares": "{shares} nvHASH escrowed",
  "exit.tracker-queue-position": "Queue position {position} of {total}",
  "exit.tracker-countdown": "Guaranteed within {days} days.",
  "exit.tracker-expedite-note":
    "“Expedited” means the vault had funds to release you early, ahead of the guarantee.",
  "exit.tracker-paid": "Paid out",
  "exit.tracker-refunded": "Refunded (unfunded maturity — shares returned, no loss)",
  "exit.tracker-payout-amount": "Received {amount} HASH",
  "exit.tracker-refund-shares": "{shares} nvHASH returned",
  "exit.tracker-alert-note":
    "You'll be alerted here and in the bell when this matures or is expedited.",
  "exit.tracker-alert-settings-link": "Manage in alert settings",

  "alerts.bell-label": "Alerts",
  "alerts.bell-aria": "Alerts, {count} unread",
  "alerts.bell-aria-none": "Alerts, none unread",
  "alerts.loading": "Loading…",
  "alerts.empty": "No notifications yet.",
  "alerts.mark-all-read": "Mark all read",
  "alerts.notif.nav-step-posted": "NAV stepped up — epoch {epoch} settled.",
  "alerts.notif.redemption-matured": "Your redemption matured — request {request}.",
  "alerts.notif.redemption-expedited": "Your redemption was expedited — request {request}.",
  "alerts.notif.redemption-refunded": "Your redemption was refunded, no loss — request {request}.",
  "alerts.notif.vault-status": "Vault status changed: {incident}.",
  "alerts.notif.validator-set-incident": "Validator-set incident: {incident}.",
  "alerts.notif.operator-arrears": "Commission still owed for {valoper} at epoch {epoch}.",
  "alerts.incident.vault-paused": "vault paused",
  "alerts.incident.contract-halted": "contract halted",
  "alerts.incident.jail-report": "validator jailed",
  "alerts.incident.slash-write-down": "slashing write-down",

  "alerts.settings-title": "Alert settings",
  "alerts.settings-lede":
    "Choose what you're alerted about. In-app alerts always appear in the bell; these toggles decide which events create one.",
  "alerts.settings-default": "on by default",
  "alerts.kind.nav-step-posted": "Monthly NAV step",
  "alerts.kind.nav-step-posted-desc": "When an epoch settles and your redemption value steps up.",
  "alerts.kind.redemption-update": "Redemption updates",
  "alerts.kind.redemption-update-desc":
    "When your redemption matures, is expedited, or is refunded. The 60-day guarantee always holds; a “typical” time is never a promise.",
  "alerts.kind.vault-status": "Vault paused or halted",
  "alerts.kind.vault-status-desc": "When the vault is paused or the contract is halted.",
  "alerts.kind.validator-set-incident": "Validator-set incidents",
  "alerts.kind.validator-set-incident-desc":
    "When a program validator is jailed or takes a slashing write-down.",
  "alerts.kind.operator-arrears": "Commission arrears",
  "alerts.kind.operator-arrears-desc":
    "When one of your validators still has commission owed at epoch close.",

  // Web Push, per-browser opt-in. Every honest permission state has
  // its own copy — no silent no-ops.
  "alerts.push.title": "Push notifications on this device",
  "alerts.push.lede":
    "Get the alerts above pushed to this browser, even when nvHASH isn't open. In-app alerts always appear in the bell; push just delivers them faster.",
  "alerts.push.per-browser": "Enabling here turns on push for this browser only.",
  "alerts.push.enable": "Enable push",
  "alerts.push.disable": "Disable push",
  "alerts.push.enabled": "Push is on for this browser.",
  "alerts.push.working": "Working…",
  "alerts.push.checking": "Checking this browser…",
  "alerts.push.unsupported": "This browser doesn't support push notifications.",
  "alerts.push.not-configured": "Push isn't configured for this environment.",
  "alerts.push.denied":
    "Push is blocked for this site in your browser. Allow notifications in your browser settings, then try again.",
  "alerts.push.error": "Something went wrong enabling push. Please try again.",

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
  "portfolio.yield-cold":
    "First epoch not yet settled. Your effective yield appears after the first monthly settlement.",
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
  "portfolio.accrual-cold":
    "Your value chart appears once your position has at least two points of history.",
  "portfolio.accrual-unavailable": "Your accrual history is unavailable right now.",
  "portfolio.yield-truncated":
    "Showing the most recent settlements; earlier yield history is trimmed.",
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
  "portfolio.redemptions-partial":
    "Showing the newest {count} active redemptions — older ones exist but are not shown, and the escrow total covers only what is shown.",
  "portfolio.redemptions-completeness-unknown":
    "Whether this list includes every active redemption could not be determined.",
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

  "tx.reason-vault-paused": "The vault is paused, so this cannot proceed right now.",
  "tx.reason-vault-paused-detail":
    "The vault is paused ({detail}), so this cannot proceed right now.",
  "tx.reason-swaps-disabled": "This action is currently disabled on the vault.",
  "tx.reason-below-minimum": "Below the vault minimum of {minimum}.",
  "tx.reason-above-maximum": "Above the vault maximum of {maximum}.",
  "tx.reason-insufficient-balance":
    "Not enough balance: you have {balance}, this needs {required} including the fee.",
  "tx.reason-vesting-locked":
    "Some of your HASH is still vesting and cannot be deposited. Spendable now: {spendable} HASH.",
  "tx.reason-amount-invalid": "Enter a valid amount.",
  "tx.reason-account-missing":
    "This account has no on-chain activity yet. Receive some HASH first.",
  "tx.reason-chain-unavailable": "The chain could not be reached to check this. Try again shortly.",
  // Operator predicates. Each restates a rule the CONTRACT enforces —
  // these explain in advance, they do not decide (§12.1).
  "tx.reason-not-validator-operator":
    "Only the validator's own operator account can do this, and this wallet is not it.",
  "tx.reason-validator-not-found": "No validator with that operator address exists on chain.",
  "tx.reason-already-enrolled": "This validator is already enrolled in the program.",
  "tx.reason-not-enrolled": "This validator is not enrolled in the program.",
  "tx.reason-validator-not-jailed":
    "This validator is not jailed. Reporting only applies to a validator that is jailed right now, and the contract clears a stale report on its next observation.",
  "tx.reason-no-jail-report":
    "No jail report is on file yet. Report the validator first — that starts the cooldown.",
  "tx.reason-purge-cooldown":
    "The cooldown has not elapsed. A purge becomes possible at {readyAt}.",
  "tx.reason-program-halted":
    "The program's fund-moving cranks are halted, so a purge cannot run right now.",
  "tx.reason-too-many-validators":
    "The program is at its limit of {max} enrolled validators, so no new one can enroll right now.",
  // Governance would-fail reasons.
  "tx.reason-proposal-not-found": "This proposal could not be read from the chain.",
  "tx.reason-proposal-pruned":
    "The chain no longer holds this proposal, so no action can reference it.",
  "tx.reason-proposal-not-open": "This proposal's voting period is over.",
  "tx.reason-already-voted":
    "You already voted {option}. x/group records one vote per member and does not accept a change.",
  "tx.reason-not-group-member": "Only members of this group can vote on its proposals.",
  "tx.reason-proposal-not-passed": "This proposal has not passed, so it cannot be executed.",
  "tx.reason-voting-period-open":
    "Voting is still open until {endsAt}. A proposal can only be executed after its voting period closes.",
  "tx.reason-min-execution-pending":
    "This policy requires a waiting period after passage. This proposal becomes executable at {readyAt}.",
  "tx.reason-min-execution-unknown":
    "This proposal's policy requires a waiting period after passage, and this build could not read it — so we cannot confirm the proposal is executable yet.",
  "tx.reason-already-executed": "This proposal has already been executed.",
  "tx.reason-policy-not-found":
    "That group policy is not one of this program's, so a proposal cannot be submitted to it.",
  "tx.reason-template-invalid": "This action cannot be composed as entered: {detail}",
  "tx.reason-governance-unavailable":
    "The program's governance could not be read right now, so this action cannot be prepared.",
  "tx.reconnect-to-sign":
    "Reconnect your wallet to sign — the session is active but the signing connection was lost.",
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
  "wallet.approve-in-wallet":
    "Approve the login request in your wallet. It signs a one-time message; nothing moves.",
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
  "market.depth-partial": "Partial — the venue reported more depth bands than shown.",
  "market.depth-completeness-unknown":
    "Whether every reported depth band is shown could not be determined.",

  "market.supply-title": "Where nvHASH lives",
  "market.supply-local": "On Provenance",
  "market.supply-local-caption": "Live chain read",
  "market.supply-bridged-empty":
    "All nvHASH lives on Provenance today. Bridged supply appears here when the bridge opens.",
  "market.supply-bridged-partial": "Partial — more bridged chains exist than shown.",
  "market.supply-completeness-unknown":
    "Whether every bridged chain is shown could not be determined.",
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
  "validators.health-partial":
    "From indexed history — partial view: the registry holds more enrollments than this set reflects.",
  "validators.health-completeness-unknown":
    "From indexed history — whether this covers the whole registry could not be determined.",

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
  // Operator view (app-spec §8.6). Copy restates the CONTRACT's own
  // mechanics (contracts/src/msg.rs + validators.rs doc comments), not an
  // invented product story — in particular the commission/TIP asymmetry, which
  // is the thing an operator most easily gets wrong.
  "operator.title": "My validator",
  "operator.na": "n/a",
  "operator.connect-prompt":
    "Connect the wallet that operates your validator to see its standing, economics, and payment history.",
  "operator.roles-degraded":
    "We could not check whether this address operates a program validator — a chain read failed. Nothing is shown rather than a guess; reload in a moment.",
  "operator.not-operator": "This address does not operate a program validator.",
  "operator.enroll-hint":
    "A validator's own operator account enrolls it in the program. Connect that account to see this view.",
  "operator.no-validators":
    "This address is in the program's operator set, but no enrolled validator has been indexed for it yet.",
  "operator.viewing-address": "Showing the operator view for {address}.",
  "operator.indexed-unavailable":
    "Indexed history is unavailable right now, so economics and payment history cannot be shown. Live standing above is unaffected.",
  "operator.inactive-validator":
    "This validator is no longer enrolled in the program. Its history stays here, but program actions do not apply to it — re-enrol it to manage it again.",
  "operator.unregistered-badge": "unregistered",
  "operator.switch-validator": "Switch validator",
  "operator.unnamed-validator": "Your validator",

  "operator.standing-title": "Standing",
  "operator.standing-unavailable":
    "Commission standing is unavailable — the live chain read failed. It is not shown rather than shown stale.",
  "operator.standing-arrears-label": "Commission in arrears",
  "operator.standing-arrears-consequence":
    "The one-epoch grace has passed, which alone makes this validator ineligible until the balance is brought current.",
  "operator.standing-current-label": "Commission current",
  "operator.standing-current-consequence": "Nothing is owed at the current grace boundary.",
  "operator.standing-prepaid-label": "Commission prepaid",
  "operator.standing-prepaid-consequence":
    "You have paid more than has accrued. Program commission is cumulative, so the excess carries forward against future accrual for as many epochs as it covers.",
  "operator.prepaid-credit": "Prepaid credit: {amount} HASH ahead of accrual.",
  "operator.commission-due-label": "Due now",
  "operator.commission-paid-label": "Paid (lifetime)",
  "operator.commission-accrued-label": "Accrued (lifetime)",

  "operator.eligibility-label": "Eligibility",
  "operator.eligibility-caption": "Assessed live from chain state each epoch",
  "operator.eligible-yes": "Eligible",
  "operator.eligible-no": "Ineligible",
  "operator.failing-reasons": "Failing: {reasons}",
  "operator.uptime-label": "Uptime",
  "operator.uptime-caption": "No uptime threshold could be read",
  "operator.uptime-threshold": "{threshold}% required",
  "operator.headroom-uptime-label": "Uptime headroom",
  "operator.headroom-uptime-caption": "Percentage points above the threshold",
  "operator.headroom-label": "Delegation headroom",
  "operator.headroom-caption": "New delegation still allowed under the concentration cap",
  "operator.tip-epoch-label": "TIP this epoch",
  "operator.tip-epoch-caption": "Resets at every epoch completion — it does not carry forward",
  "operator.enrolled-label": "Enrolled",
  "operator.enrolled-caption": "Currently participating",
  "operator.unregistered-caption": "No longer participating",
  "operator.jailed-label": "Jailed",
  "operator.jailed-consequence":
    "A jailed validator is ineligible, and the program's stake can be moved off it after the cooldown.",
  "operator.tombstoned-label": "Tombstoned",
  "operator.tombstoned-consequence": "A tombstoned validator can never return to the program.",
  "operator.jail-report-label": "Jail report open",
  "operator.jail-report-consequence":
    "The program's stake may be moved off this validator from {purgeReadyAt} unless it unjails first.",

  "operator.net-benefit-title": "Net benefit after fees",
  "operator.earnings-label": "Estimated earnings",
  "operator.earnings-estimate": "Estimate — not an exact figure",
  "operator.commission-total-label": "Commission paid",
  "operator.tip-total-label": "TIP paid",
  "operator.exact-fact": "Exact, from indexed payments",
  "operator.net-label": "Net benefit",
  "operator.net-caption": "Estimated earnings minus what you paid",
  "operator.earnings-derivation":
    "Earnings are ESTIMATED: the program's own realized return for each epoch is applied to your delegation over that epoch and multiplied by your current commission rate ({rate}%), across {epochs} epoch steps. Your actual reward stream is not indexed, and rate changes over time are not accounted for.",
  "operator.earnings-unavailable":
    "Earnings cannot be estimated yet — your commission rate or the program's per-epoch return was unavailable. The amounts you paid are exact.",
  "operator.history-truncated":
    "Only the most recent epochs are shown; earlier history is not included in these figures.",

  "operator.delegation-title": "Program delegation",
  "operator.delegation-caption":
    "HASH the program has delegated to this validator, at each epoch settlement. Values change only at settlement.",
  "operator.delegation-unavailable": "Delegation history is unavailable right now.",
  "operator.delegation-cold": "Delegation history appears after a second epoch settles.",
  "operator.delegation-header": "Delegation (HASH)",
  "operator.show-table": "Show table",
  "operator.show-chart": "Show chart",
  "operator.epoch-n": "Epoch {epoch}",
  "operator.epoch-header": "Epoch",

  "operator.payments-title": "Payment history",
  "operator.payments-empty": "No commission or TIP payments have been indexed for this validator.",
  "operator.payments-more": "Only the most recent payments are shown. The CSV export is complete.",
  "operator.export-csv": "Export CSV",
  "operator.payment-time-header": "Date",
  "operator.payment-type-header": "Type",
  "operator.payment-amount-header": "Amount (HASH)",
  "operator.payment-payer-header": "Paid by",
  "operator.payment-tx-header": "Transaction",
  "operator.payment-commission": "Commission",
  "operator.payment-tip": "TIP",
  "operator.paid-by-other": "(not your operator account)",
  "operator.epoch-pending": "pending",

  // Operator ACTIONS (§14.6 flows). Confirm copy restates the CONTRACT's
  // mechanics from its msg.rs doc comments — the counter-intuitive facts
  // (commission carries, TIP does not, purge is two-phase) are the ones an
  // operator most needs before signing.
  "operator.actions-title": "Actions",
  "operator.actions-caption":
    "Each action is built, previewed and signed by your wallet. The exact message is shown before you sign; the contract, not this page, decides whether it succeeds.",
  "operator.actions-connect": "Connect your wallet to take an action on this validator.",
  "operator.flow-pay-commission": "Pay commission",
  "operator.flow-pay-tip": "Pay TIP",
  "operator.flow-enroll": "Enroll validator",
  "operator.flow-unregister": "Withdraw from program",
  "operator.flow-report-jailed": "Report jailed",
  "operator.flow-purge-jailed": "Purge jailed",
  "operator.amount-label": "Amount (HASH)",
  "operator.amount-invalid": "Enter an amount as a plain decimal, e.g. 12.5",
  "operator.claimant-label": "Claimant validator (optional)",
  "operator.claimant-placeholder": "leave empty to unbond the full delegation",
  "operator.claimant-caption":
    "With a claimant you operate, the program redelegates up to that validator's headroom instead of unbonding everything. It appears in the exact message below before you sign.",
  "operator.review-action": "Review action",
  "operator.enroll-valoper-label": "Validator operator address to enroll",

  "operator.confirm-pay-commission-1":
    "This payment is NON-REFUNDABLE. Once signed, it cannot be returned.",
  "operator.confirm-pay-commission-2":
    "Paying more than is currently accrued is not wasted: program commission is cumulative, so the excess prepays future accrual and carries forward.",
  "operator.confirm-pay-commission-3":
    "The funds are held by the contract and swept into vault principal at the next epoch, raising NAV for every holder.",
  "operator.confirm-pay-tip-1":
    "A TIP credits the CURRENT epoch only and resets when that epoch completes — unlike commission, it does not carry forward.",
  "operator.confirm-pay-tip-2":
    "It is NON-REFUNDABLE, and sweeps into vault principal at the next epoch.",
  "operator.confirm-enroll-1":
    "Enrolling makes this validator eligible for program delegation from the next epoch, assessed live against the uptime and commission rules.",
  "operator.confirm-enroll-2":
    "Only the validator's own operator account can enroll it, and the contract checks that on execution.",
  "operator.confirm-unregister-1":
    "The program's stake on this validator is UNBONDED at the next epoch and redeployed to others.",
  "operator.confirm-unregister-2":
    "Re-enrolling later is possible, but the stake does not return automatically — it is redeployed by the normal epoch planning.",
  "operator.confirm-unregister-3":
    "Withdrawing is a CLEAN BREAK: re-enrolling starts a fresh record, so this validator's commission and TIP history does not carry over. Commission already paid is non-refundable, including any amount prepaid beyond what has accrued.",
  "operator.confirm-report-1":
    "Reporting does NOT move any stake. It records the first observation that this validator is jailed and starts the cooldown before a purge becomes possible.",
  "operator.confirm-report-2":
    "If the validator unjails before the cooldown ends, the contract clears the report on its next observation and no purge happens.",
  "operator.confirm-purge-1":
    "This MOVES the program's stake off the validator: redelegated up to a claimant's headroom if you named one, otherwise unbonded in full.",
  "operator.confirm-purge-2":
    "It only succeeds if the validator is still jailed and the cooldown from the report has elapsed.",
  "operator.confirm-purge-3":
    "Stake that is unbonded is unavailable until the unbonding period ends.",

  "operator.epochs-title": "Per-epoch history",
  "operator.epochs-caption":
    "Commission accrued, paid, and due are cumulative lifetime totals at each epoch; TIP is the credit for that epoch alone.",
  "operator.epochs-empty": "No epochs have been sampled for this validator yet.",
  "operator.uptime-header": "Uptime",
  "operator.eligible-header": "Eligible",
  "operator.tip-header": "TIP (HASH)",
  "operator.accrued-header": "Accrued (HASH)",
  "operator.due-header": "Due (HASH)",

  // Governance center (§8.7). Read-only in this milestone: voting and
  // execution arrive with 7.3–7.4, so nothing here offers an action.
  "governance.title": "Governance",
  "governance.lede":
    "Proposals for the program's group policies, with what each one would do, where its tally stands, and how it ended.",
  // Voting, execution and the template composer all ship, so this page must
  // not carry a read-only note.
  "governance.write-note":
    "Members vote and execute from each proposal's page. Proposals are composed from the program's own admin actions.",

  "governance.policies-title": "Policies",
  "governance.policies-empty": "No group policy has been observed for this program yet.",
  "governance.policy-live": "Current",
  "governance.policy-historical": "Historical only",
  "governance.policy-rule-threshold": "Passes at {value} weight in favour",
  "governance.policy-rule-percentage": "Passes at {value} of total weight",
  "governance.policy-rule-unknown": "Decision rule not recognized by this build",
  "governance.policy-voting-period": "Voting period {period}",
  "governance.policy-proposals": "{count} mirrored",
  "governance.policy-proposals-none": "None mirrored",
  "governance.group-summary":
    "Group {groupId}, version {version} · {members} members, total weight {weight}",
  "governance.policies-truncated":
    "More policies exist than this page read. The list below is incomplete.",

  "governance.not-governed":
    "This deployment's program admin is a plain account rather than a group policy, so there is no live group behind it. Mirrored history is shown below.",
  "governance.live-unavailable":
    "The chain could not be read, so current tallies and membership are unavailable. Mirrored values are shown with the height they were observed at.",

  "governance.proposals-title": "Proposals",
  "governance.proposals-empty": "No proposals have been mirrored yet.",
  "governance.proposals-unavailable":
    "The mirrored proposal history could not be read. This is not an empty history.",
  "governance.indexed-from":
    "Mirrored from height {height}. Anything pruned before then is unrecoverable.",
  "governance.indexed-from-unknown":
    "No height certifies how far back this mirror reaches, so it may be incomplete.",

  "governance.filter-label": "Status",
  "governance.filter-all": "All",
  "governance.status-submitted": "Open",
  "governance.status-accepted": "Accepted",
  "governance.status-rejected": "Rejected",
  "governance.status-aborted": "Aborted",
  "governance.status-withdrawn": "Withdrawn",
  "governance.status-unspecified": "Unrecognized status",

  "governance.executor-not-run": "Not executed",
  "governance.executor-success": "Executed successfully",
  "governance.executor-failure": "Execution FAILED",
  "governance.executor-unspecified": "Execution outcome unrecognized",

  "governance.plane-live": "From the chain, now",
  "governance.plane-indexed-fallback":
    "The chain could not be read; mirrored as of height {height}",
  "governance.plane-indexed": "Mirrored record, as of height {height}",
  "governance.plane-pruned": "The chain no longer holds this proposal; mirrored record only",
  "governance.plane-live-only": "On chain now, not mirrored yet",

  "governance.na": "n/a",
  "governance.open-heading": "Open",
  "governance.history-heading": "Outcome history",
  "governance.view-proposal": "View proposal {id}",
  "governance.page-next": "Next",
  "governance.page-previous": "Previous",
  "governance.page-position": "Page {page}",

  "governance.proposal-heading": "Proposal {id}",
  "governance.back-to-list": "All proposals",
  "governance.untitled": "Untitled proposal",
  "governance.no-summary": "The proposer supplied no summary.",
  "governance.proposers": "Proposed by",
  "governance.proposers-truncated":
    "The proposer list was trimmed for transport and is incomplete.",
  "governance.policy-label": "Policy",
  "governance.submitted-at": "Submitted",
  "governance.voting-ends": "Voting ends",
  "governance.voting-ended": "Voting ended",
  "governance.voting-ends-approx": "about {duration} from now",
  "governance.submit-tx": "Submitted in transaction",
  "governance.submit-tx-unknown":
    "No submit transaction is recorded — this proposal was first seen by a state read.",

  "governance.duration-day": "{count} day",
  "governance.duration-days": "{count} days",
  "governance.duration-hour": "{count} hour",
  "governance.duration-hours": "{count} hours",
  "governance.duration-minute": "{count} minute",
  "governance.duration-minutes": "{count} minutes",
  "governance.duration-second": "{count} second",
  "governance.duration-seconds": "{count} seconds",

  "governance.tally-title": "Tally",
  "governance.tally-yes": "Yes",
  "governance.tally-no": "No",
  "governance.tally-abstain": "Abstain",
  "governance.tally-no-with-veto": "No with veto",
  "governance.tally-total": "Total weight cast",
  "governance.tally-threshold": "Passes at {value} weight in favour",
  "governance.tally-percentage": "Passes at {value} of total group weight",
  "governance.tally-rule-unknown":
    "This decision rule is not one this build understands, so whether it passes cannot be stated.",
  "governance.tally-meets-yes": "Meets its threshold",
  "governance.tally-meets-no": "Does not meet its threshold",
  "governance.tally-meets-unknown": "Cannot be decided from what is known",
  "governance.tally-participation": "{percent}% of total group weight has voted",
  "governance.tally-snapshot-note":
    "The rule shown is the one recorded when this proposal was submitted, not the policy's current rule.",

  "governance.members-title": "Member status",
  "governance.members-not-checked":
    "The current member set could not be read, so only recorded votes are shown.",
  "governance.members-changed":
    "Group membership has changed since this proposal (group version {proposalVersion}, now {currentVersion}). Only the recorded votes are shown — today's members were not its electorate.",
  "governance.member-address": "Member",
  "governance.member-weight": "Weight",
  "governance.member-vote": "Vote",
  "governance.member-voted-at": "Voted",
  "governance.member-not-voted": "Has not voted",
  "governance.member-you": "you",

  "governance.vote-yes": "Yes",
  "governance.vote-no": "No",
  "governance.vote-abstain": "Abstain",
  "governance.vote-no-with-veto": "No with veto",
  "governance.vote-unspecified": "Unrecognized option",

  "governance.votes-title": "Recorded votes",
  "governance.votes-empty":
    "No votes are recorded. For a closed proposal this can also mean its votes were pruned before they were mirrored.",
  "governance.votes-truncated": "The vote list was trimmed for transport and is incomplete.",
  "governance.vote-live-only": "on chain, not mirrored yet",
  "governance.vote-weight-unknown": "weight unknown",

  "governance.messages-title": "What this proposal does",
  "governance.messages-empty": "This proposal carries no messages.",
  "governance.messages-truncated":
    "This proposal carries more messages than were transported. What is shown below is incomplete.",
  "governance.message-position": "Message {index} of {total}",
  "governance.message-type": "Type",
  "governance.message-contract": "Contract",
  "governance.message-funds": "Funds attached",
  "governance.message-exact": "Exact message",
  "governance.message-json-truncated":
    "This payload is longer than the page will render; what is shown is the beginning of it.",

  "governance.msg-send": "Send {amount} to {recipient}",
  "governance.msg-send-no-coins": "nothing",
  "governance.msg-pay-commission": "Pay program commission for {valoper}",
  "governance.msg-pay-tip": "Pay a TIP for {valoper}",
  "governance.msg-register-participation": "Enrol {valoper} in the program",
  "governance.msg-unregister-participation": "Withdraw {valoper} from the program",
  "governance.msg-report-jailed": "Report {valoper} as jailed",
  "governance.msg-purge-jailed": "Move the program's stake off jailed {valoper}",
  "governance.msg-set-halted-on": "Halt the program's fund-moving cranks",
  "governance.msg-set-halted-off": "Resume the program's fund-moving cranks",
  "governance.msg-set-halted-unknown": "Change the program's crank halt state",
  "governance.msg-update-config": "Update program configuration: {fields}",
  "governance.msg-update-config-generic": "Update program configuration",
  "governance.msg-pause-vault": "Pause the managed vault",
  "governance.msg-unpause-vault": "Unpause the managed vault",
  "governance.msg-clear-pending-delegations": "Abort a stuck epoch continuation",
  "governance.msg-run-epoch": "Run the epoch crank",
  "governance.msg-claim-rewards": "Claim accrued staking rewards",
  "governance.msg-service-redemptions": "Service queued redemptions",
  "governance.msg-capture-uptime-signal": "Capture the uptime signal",
  "governance.msg-unknown-type":
    "Unrecognized message type — this build cannot say what it does. The exact message is below.",
  "governance.msg-unknown-contract":
    "A call to a contract that is not this program's. This build does not summarize it; the exact message is below.",
  "governance.msg-unknown-variant":
    "An unrecognized action on the program contract. The exact message is below.",
  "governance.msg-malformed":
    "This message could not be read as its declared type. The exact payload is below.",

  // ── The write path: vote, execute, compose ─────────────────────────────
  "governance.actions-title": "Your actions",
  "governance.actions-live-down":
    "Actions are hidden because the current on-chain state could not be read. What is shown above is the mirrored record, and acting on it could submit a transaction that is certain to fail.",
  "governance.actions-connect": "Connect a wallet to vote or execute.",

  "governance.vote-title": "Cast your vote",
  "governance.vote-option-label": "Your vote",
  "governance.vote-submit": "Review and sign",
  "governance.vote-not-member":
    "Voting is limited to this group's members, and the connected wallet is not one.",
  // Placeholder-free on purpose: this key reaches `t()` through the hidden-reason
  // table in `proposal-actions.tsx`, where the i18n scan cannot verify that a
  // placeholder was supplied. `governance.members-changed` says the same thing
  // WITH the two version numbers, and it is rendered from a literal call site.
  "governance.vote-membership-changed":
    "Group membership has changed since this proposal was submitted, so it is no longer open to a vote from today's members.",
  "governance.vote-already":
    "You voted {option} on this proposal. x/group records one vote per member and does not accept a change.",
  "governance.vote-metadata-note":
    "Votes carry no note. Only the option above is recorded on chain.",
  "governance.confirm-vote-1": "You are voting {option} on proposal {id}.",
  "governance.confirm-vote-2": "This vote is recorded on chain permanently and cannot be changed.",
  "governance.confirm-vote-3":
    "This signature votes only. If the proposal passes, executing it is a separate transaction you sign separately.",

  "governance.execute-title": "Execute this proposal",
  "governance.execute-submit": "Review and sign",
  "governance.execute-permissionless":
    "Execution is permissionless: once a proposal has passed, any wallet may execute it. You do not need to be a member.",
  "governance.execute-pending": "This proposal becomes executable at {readyAt}.",
  "governance.execute-pending-unknown":
    "This proposal is not executable yet — its policy requires a waiting period after passage, and its end could not be read.",
  "governance.execute-failed-note":
    "Execution has already been attempted and failed. x/group does not permit another attempt.",
  "governance.confirm-exec-1": "You are executing proposal {id}.",
  "governance.confirm-exec-2": "If it succeeds, the following happens on chain:",
  "governance.confirm-exec-3":
    "Execution is final. The program's own admin actions take effect immediately, and this transaction cannot be undone.",
  "governance.confirm-exec-unknown":
    "This build cannot summarize every message in this proposal. Read the exact payload below before signing.",

  "governance.new-proposal": "New proposal",
  "governance.new-title": "Propose an admin action",
  "governance.new-lede":
    "Proposals are composed from the program's own admin actions. Free-form message building is deliberately not offered here.",
  "governance.new-not-member":
    "Submitting a proposal is limited to this group's members, and the connected wallet is not one.",
  "governance.new-connect": "Connect a wallet to compose a proposal.",
  "governance.new-not-governed":
    "This deployment has no group policy, so there is nothing to propose to.",
  "governance.new-unavailable":
    "The program's governance could not be read right now, so a proposal cannot be composed.",
  "governance.new-policy-label": "Policy",
  "governance.new-submit": "Review and sign",

  "governance.template-picker-label": "Admin action",
  "governance.template-update-config": "Update program configuration",
  "governance.template-set-halted": "Halt or resume the fund-moving cranks",
  "governance.template-pause-vault": "Pause the managed vault",
  "governance.template-unpause-vault": "Unpause the managed vault",
  "governance.template-clear-pending-delegations": "Abort a stuck epoch continuation",
  "governance.template-no-bridge-note":
    "Bridge configuration has no template: no contract action backs it yet.",

  "governance.param-max-delegations-per-run": "Max delegations per epoch run",
  "governance.param-aum-fee-bps": "AUM fee (bps)",
  "governance.param-performance-threshold-bps": "Uptime eligibility threshold (bps)",
  "governance.param-min-capture-interval-secs": "Minimum uptime capture interval (seconds)",
  "governance.param-max-concentration-multiple-bps": "Concentration multiple (bps)",
  "governance.param-min-bonded-cap-bps": "Minimum bonded cap (bps)",
  "governance.param-max-bonded-cap-bps": "Maximum bonded cap (bps)",
  "governance.param-concentration-safety-offset-bps": "Concentration safety offset (bps)",
  "governance.param-commission-bps": "Program commission rate (bps)",
  "governance.param-jail-unbond-delay-secs": "Jail report cooldown (seconds)",
  "governance.param-halted": "Halt the fund-moving cranks",
  "governance.param-pause-reason": "Reason",
  "governance.param-include": "Change this",
  "governance.param-range": "Allowed range {min} to {max}",
  "governance.param-length-range": "Between {min} and {max} characters",

  "governance.diff-title": "What changes",
  "governance.diff-field": "Setting",
  "governance.diff-current": "Current",
  "governance.diff-proposed": "Proposed",
  "governance.diff-untouched": "unchanged (not in this proposal)",
  "governance.diff-same": "supplied, but identical to the current value",
  "governance.diff-current-unknown": "could not be read",
  "governance.diff-note":
    "Only the settings marked as proposed are changed. Every other setting keeps its current value.",

  "governance.compose-title-label": "Title",
  "governance.compose-summary-label": "Rationale",
  "governance.compose-metadata-label": "Additional notes (optional)",
  "governance.compose-public-note":
    "The title, rationale and notes are written to the chain. They are public and permanent.",

  "governance.confirm-submit-1": "You are proposing: {summary}",
  "governance.confirm-submit-2":
    "Submitting is not the same as doing it. If this proposal passes and is then executed, the action above takes effect.",
  "governance.confirm-submit-3":
    "Submitting is not idempotent: signing twice creates two separate proposals, not one.",
  "governance.confirm-submit-min-execution":
    "This policy requires {period} between passage and execution, so the earliest this can take effect is that long after the voting period ends.",
  "governance.confirm-submit-voting-period": "The voting period for this policy is {period}.",

  "governance.confirm-update-config-1":
    "This proposes a change to the program's configuration. Only the settings listed are changed.",
  "governance.confirm-update-config-2":
    "The contract re-checks every value; a value outside its allowed range makes execution fail rather than take partial effect.",
  "governance.confirm-set-halted-1":
    "Halting stops the fund-moving permissionless cranks — the epoch run and redemption servicing.",
  "governance.confirm-set-halted-2":
    "It does NOT pause the vault itself. Deposits and redemptions keep their own pause state.",
  "governance.confirm-pause-vault-1":
    "Pausing the managed vault stops deposits and redemptions for everyone.",
  "governance.confirm-pause-vault-2":
    "The reason you give is shown to users on the affected pages.",
  "governance.confirm-unpause-vault-1":
    "Unpausing the managed vault restores deposits and redemptions.",
  "governance.confirm-clear-pending-1":
    "This drops the persisted delegation targets of a stuck epoch continuation and returns the program to Idle.",
  "governance.confirm-clear-pending-2":
    "No value is lost: the withdrawn HASH stays in the contract balance and the next epoch settles the matching receipt.",

  "governance.submitted-note":
    "Your proposal was submitted. It appears in the list once the chain has it; do not sign again — a second signature creates a second proposal.",

  // --- §8.8 admin analytics -------------------------------------------------
  "admin.title": "Admin analytics",
  "admin.viewing-address": "Signed in as {address}.",
  "admin.connect-prompt":
    "Connect the wallet of a program administrator to view the analytics dashboard.",
  "admin.not-admin": "This address is not a member of the program's administrator group.",
  // NOT a denial. A failed chain read is not evidence that someone is not an
  // admin, and saying so would state a fact we do not have.
  "admin.membership-unknown":
    "We could not check your administrator membership on chain just now. This is not a decision about your access — try again shortly.",
  "admin.unconfigured":
    "Admin analytics are not available in this environment: no API service credential is configured.",
  "admin.freshness": "Indexed as of height {height}, generated {at} UTC.",
  "admin.derivable-note":
    "Every figure here is derived from public chain history and aggregated. Nothing on this page is a record of an individual wallet's behaviour.",
  "admin.support-out-of-scope":
    "Support and complaint signals are out of scope for v1 and are handled outside this tool.",

  // Panel states. Four distinct reasons, never one flat \"no data\": an
  // administrator acts differently on each.
  "admin.panel-na": "n/a —",
  "admin.panel-read-failed": "we could not read this. It may be available on the next reload.",
  "admin.panel-cold-start": "there is no history for this yet.",
  "admin.panel-below-minimum":
    "withheld: the group is too small to report without identifying its members.",
  "admin.panel-not-collected": "this build does not collect the input for this measure.",
  // Distinct from `series-truncated`: that one means the CHART is short, this
  // one means depositors are missing, which biases the newest points downward.
  "admin.holders-truncated":
    "The depositor set was capped for this read, oldest first — the most recent cohorts are not included, so recent adoption reads lower than it was.",
  "admin.upkeep-truncated":
    "Measured over the most recent {count} settled requests, not the whole history.",
  "admin.series-truncated":
    "This series is longer than the page shows and has been trimmed to its cap.",

  // Program health
  "admin.health-title": "Program health",
  "admin.health-depositors": "Depositors (distinct addresses that have deposited)",
  "admin.health-table-caption": "Total value, net APR and net deposit flow per settlement.",
  "admin.col-epoch": "Settlement",
  "admin.col-settled": "Settled",
  "admin.col-tvl": "Total value (HASH)",
  "admin.col-net-apr": "Net APR",
  "admin.col-net-flow": "Net flow (HASH)",
  "admin.net-outflow": "net outflow",

  // Holder cohort
  "admin.holders-title": "Holder cohort",
  "admin.holders-mix": "Redemption mix",
  "admin.mix-matured": "Matured",
  "admin.mix-expedited": "Expedited",
  "admin.mix-refunded": "Refunded",
  "admin.mix-enqueued": "In progress",
  "admin.holders-concentration": "Value concentration",
  "admin.conc-top1": "Largest holder",
  "admin.conc-top5": "Top 5",
  "admin.conc-top10": "Top 10",
  "admin.conc-holders": "Holders",
  "admin.conc-shares-only":
    "Shares of total value only. No addresses and no amounts are shown, and the whole measure is withheld while the program has too few holders to band without identifying one.",
  "admin.holders-adoption": "Adoption",
  "admin.col-new-depositors": "New depositors",
  "admin.holders-retention": "Retention by first-deposit cohort",
  "admin.retention-minimum":
    "Cohorts smaller than {min} depositors are withheld rather than charted: with so few members, a retention figure identifies them.",
  "admin.col-cohort": "Cohort",
  "admin.col-cohort-size": "Size",
  "admin.retention-withheld": "withheld",
  "admin.retention-not-yet": "—",
  "admin.retention-not-yet-long": "This many settlements have not elapsed yet.",

  // Validator cohort
  "admin.validators-title": "Validator cohort",
  "admin.validators-enrolled": "Enrolled now",
  "admin.validators-churned": "Unregistered to date",
  "admin.validators-table-caption":
    "Sampled, eligible, in-arrears, TIP-paying and purged validators per settlement.",
  "admin.col-sampled": "Sampled",
  "admin.col-eligible": "Eligible",
  "admin.col-arrears": "In arrears",
  "admin.col-tip": "Paid TIP",
  "admin.col-purged": "Purged",

  // Evaluator funnel (§14.10)
  "admin.funnel-title": "Evaluator funnel",
  "admin.funnel-window": "Counted over the last {days} days.",
  // The honesty label. It is above the figures, not footnoted below them.
  "admin.funnel-event-totals":
    "These are event totals, not unique people. The counters carry no cookie, no session and no device identifier, so a returning reader is counted again. Treat them as a measure of traffic, never of audience size.",
  "admin.funnel-table-caption": "Event totals per funnel stage.",
  "admin.col-stage": "Stage",
  "admin.col-events": "Events",
  "admin.funnel-visit-learn": "Visited the home page",
  "admin.funnel-visit-validators": "Visited validators",
  "admin.funnel-visit-market": "Visited market",
  "admin.funnel-due-diligence": "Reached a due-diligence page",
  "admin.funnel-connect": "Connected a wallet",
  "admin.funnel-first-deposits": "First deposits",
  // Says BOTH ways the terminal stage differs from the ones above it: it is
  // exact where they are event totals, and it covers the same window as they
  // do. The window clause is not decoration — an all-time figure here would
  // make the bottom of the funnel wider than its top.
  "admin.funnel-first-deposits-note":
    "Addresses whose first deposit fell in the same window as the stages above. Counted from chain history, so this figure is exact and counts distinct addresses — unlike the stage totals, which count events. The two are shown separately because their precision differs, not their period.",

  // Upkeep timeliness
  "admin.upkeep-title": "Upkeep timeliness",
  "admin.upkeep-caption":
    "How long the permissionless cranks take once they become runnable. Derived from the timing of the crank transactions themselves.",
  "admin.upkeep-epoch-lag": "Settlement run after it became eligible",
  "admin.upkeep-redemption": "Redemption request to payout",
  "admin.upkeep-capture": "Capture-signal cadence gaps",
  "admin.upkeep-median": "Median",
  "admin.upkeep-p90": "90th percentile",
  "admin.upkeep-samples": "{count} samples",
  "admin.col-lag": "Lag",
  "admin.col-count": "Count",

  // Incident feed (§9.6)
  "admin.incidents-title": "Incident feed",
  "admin.incidents-empty":
    "No incidents recorded. This list is generated from chain history, not curated.",
  "admin.incident-open": "open",
  "admin.incident-closed": "closed",
  "admin.ack-by": "Acknowledged by {address} on {at}",
  // The C4 distinction the affordance already makes, said in the label too.
  "admin.ack-by-you": "Acknowledged by you on {at}",
  "admin.ack-note-label": "Note (optional)",
  "admin.ack-action": "Acknowledge",
  "admin.unack-action": "Undo my acknowledgement",
  "admin.ack-failed": "That did not go through.",
  // The incidents read succeeded, the acknowledgment read did not. It must not
  // read as "nothing is acknowledged" — that is a fact we do not have, and it
  // would invite acknowledging something a colleague already handled.
  "admin.ack-state-unknown":
    "We could not read acknowledgements just now, so this list does not show who has acknowledged what. The incidents themselves are current. Acknowledging is unavailable until the check succeeds — reload to try again.",

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
