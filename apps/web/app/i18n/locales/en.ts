// English catalog — the reference locale. Every other locale must carry
// exactly this key set (test/i18n-coverage.test.ts). Voice per app-spec §11:
// plain, concrete, no exclamation points, no yield hype.

export default {
  "app.name": "nvHASH",
  "app.tagline": "Liquid staking for HASH",

  "home.title": "nvHASH liquid staking",
  "home.lede":
    "Deposit HASH, receive nvHASH, and redeem it for more HASH as staking rewards settle each epoch.",
  "home.scaffold-note":
    "This deployment is a development scaffold. Program pages arrive in a later milestone.",

  "chrome.console-link": "Verify on the console",
  "chrome.chain-label": "Chain",
  "chrome.env-development": "development",
  "chrome.env-staging": "staging",
  "chrome.env-production": "production",

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
