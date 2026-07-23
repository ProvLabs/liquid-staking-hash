// The chrome wallet slot (fills the M4.1 recorded deferred delta; plan 5.1
// §3): connect entry point, vendor picker (the closed §14.1 registry — the
// UI renders the registry, it cannot invent a vendor), WC pairing QR, and
// the connected state (truncated address in Geist Mono + vendor badge +
// disconnect). Brand names are not translated; everything else is i18n.
//
// Accessibility: the picker/pairing panel is a native <dialog>-free inline
// popover with aria-expanded on the trigger and focus-visible styling from
// the shared Button; the axe e2e scan covers the closed state on every
// route, and the connect flow is exercised by the §14.1 checklist runbook.

import { useId, useState } from "react";
import { renderSVG } from "uqr";

import { Button } from "~/components/ui/button";
import { t, type Locale } from "~/i18n";
import { VENDOR_IDS, WALLET_VENDORS } from "~/wallet/adapter";
import { useWallet } from "~/wallet/provider";

function truncateAddress(address: string): string {
  return address.length <= 16 ? address : `${address.slice(0, 9)}…${address.slice(-6)}`;
}

export function WalletButton({ locale }: { locale: Locale }) {
  const { state, connect, disconnect } = useWallet();
  const [open, setOpen] = useState(false);
  const panelId = useId();

  if (state.phase === "connected") {
    return (
      <div className="flex items-center gap-2">
        <span className="rounded-md border px-2 py-1 font-mono text-xs" title={state.address}>
          {truncateAddress(state.address)}
        </span>
        {state.vendor !== null ? (
          <span className="hidden text-xs text-muted-foreground md:inline">
            {WALLET_VENDORS[state.vendor].label}
          </span>
        ) : null}
        <Button variant="ghost" size="sm" onClick={() => void disconnect()}>
          {t(locale, "wallet.disconnect")}
        </Button>
      </div>
    );
  }

  return (
    <div className="relative">
      <Button
        size="sm"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((v) => !v)}
      >
        {t(locale, "wallet.connect")}
      </Button>
      {open ? (
        <div
          id={panelId}
          className="absolute right-0 top-full z-50 mt-2 w-72 rounded-lg border bg-card p-3 shadow-md"
        >
          {state.phase === "connecting" && state.pairingUri !== null ? (
            <div className="flex flex-col items-center gap-2">
              <p className="text-sm text-muted-foreground">{t(locale, "wallet.scan-qr")}</p>
              <div
                className="w-48 rounded bg-white p-2 [&_svg]:h-auto [&_svg]:w-full"
                // uqr renders a self-contained static SVG of the pairing URI —
                // no external fetch, no script (CSP-safe).
                dangerouslySetInnerHTML={{ __html: renderSVG(state.pairingUri) }}
              />
              <p className="break-all font-mono text-[10px] text-muted-foreground">
                {state.pairingUri.slice(0, 64)}…
              </p>
            </div>
          ) : state.phase === "connecting" || state.phase === "signing" ? (
            <p className="text-sm text-muted-foreground" role="status">
              {t(
                locale,
                state.phase === "signing" ? "wallet.approve-in-wallet" : "wallet.connecting",
              )}
            </p>
          ) : (
            <ul className="flex flex-col gap-1" aria-label={t(locale, "wallet.pick-vendor")}>
              {VENDOR_IDS.map((vendor) => (
                <li key={vendor}>
                  <Button
                    variant="outline"
                    size="sm"
                    className="w-full justify-start"
                    onClick={() => void connect(vendor)}
                  >
                    {WALLET_VENDORS[vendor].label}
                  </Button>
                </li>
              ))}
            </ul>
          )}
          {state.phase === "error" ? (
            <p className="mt-2 text-xs text-muted-foreground" role="alert">
              {t(
                locale,
                state.reason === "walletconnect-unconfigured"
                  ? "wallet.error-wc-unconfigured"
                  : state.reason === "extension-not-found"
                    ? "wallet.error-extension-missing"
                    : "wallet.error-failed",
              )}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
