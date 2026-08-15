// Global chrome (spec §8.0): top bar, computed banner stack, grouped role-gated nav,
// freshness footer. Environment certainty and program health are ambient, never hidden.
import { useEffect, useState } from "react";
import { NavLink } from "react-router-dom";
import { config, isMainnet } from "@/config";
import { relTime } from "@/lib/format";
import { useStore } from "@/data/store";
import { useWallet } from "@/tx/wallet";
import { Pill } from "@/components/ui";

type ThemeChoice = "auto" | "light" | "dark";

function useTheme(): [ThemeChoice, (c: ThemeChoice) => void] {
  const [choice, setChoice] = useState<ThemeChoice>(() => {
    try {
      const t = localStorage.getItem("nvhash.theme");
      return t === "light" || t === "dark" ? t : "auto";
    } catch {
      return "auto";
    }
  });
  useEffect(() => {
    try {
      if (choice === "auto") {
        localStorage.removeItem("nvhash.theme");
        document.documentElement.removeAttribute("data-theme");
      } else {
        localStorage.setItem("nvhash.theme", choice);
        document.documentElement.setAttribute("data-theme", choice);
      }
    } catch {
      /* ignore */
    }
  }, [choice]);
  return [choice, setChoice];
}

function ThemeToggle() {
  const [choice, setChoice] = useTheme();
  const opts: ThemeChoice[] = ["auto", "light", "dark"];
  return (
    // biome-ignore lint/a11y/useSemanticElements: <fieldset> is for form controls; this is a button toolbar, where role="group" is correct.
    <div role="group" aria-label="theme" style={{ display: "flex", gap: 2 }}>
      {opts.map((o) => (
        <button
          type="button"
          key={o}
          className={`btn btn--sm ${choice === o ? "btn--secondary" : "btn--ghost"}`}
          aria-pressed={choice === o}
          onClick={() => setChoice(o)}
        >
          {o}
        </button>
      ))}
    </div>
  );
}

function WalletButton() {
  const wallet = useWallet();
  const { role } = useStore();
  const [open, setOpen] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  if (!wallet.address) {
    // Devnet builds offer the mock-identity picker (labels come from the
    // wallet, never from importing the identities module — that would defeat
    // its compile-time exclusion, §10.1); every other build connects the
    // extension directly, with its failure shown verbatim.
    if (!wallet.devnetKeyMode) {
      return (
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 2 }}>
          <button
            type="button"
            className="btn btn--secondary btn--sm"
            onClick={() => {
              setConnectError(null);
              wallet.connect().catch((e) => {
                setConnectError(e instanceof Error ? e.message : String(e));
              });
            }}
          >
            Connect wallet
          </button>
          {connectError && (
            <span role="status" style={{ color: "var(--status-serious)", fontSize: 11 }}>
              {connectError}
            </span>
          )}
        </div>
      );
    }
    return (
      <div style={{ position: "relative" }}>
        <button
          type="button"
          className="btn btn--secondary btn--sm"
          onClick={() => setOpen((v) => !v)}
        >
          Connect wallet
        </button>
        {open && (
          <div
            className="panel"
            style={{
              position: "absolute",
              right: 0,
              top: "110%",
              zIndex: 30,
              padding: 8,
              width: 200,
            }}
          >
            <div className="muted-3" style={{ fontSize: 11, padding: "2px 6px" }}>
              {config.mock ? "mock identities" : "devnet identities"}
            </div>
            {wallet.mockIdentityLabels.map((label) => (
              <button
                type="button"
                key={label}
                className="sidenav__link"
                onClick={() => {
                  void wallet.connect(label);
                  setOpen(false);
                }}
              >
                {label}
              </button>
            ))}
          </div>
        )}
      </div>
    );
  }
  return (
    <button
      type="button"
      className="btn btn--secondary btn--sm"
      onClick={() => wallet.disconnect()}
      title="disconnect"
    >
      <span className="mono">{wallet.address.slice(0, 10)}…</span>
      <span className="muted-3" style={{ fontSize: 11 }}>
        {role}
      </span>
    </button>
  );
}

export function TopBar() {
  const { block, stale } = useStore();
  const age = block.fetchedAt ? Math.floor((Date.now() - block.fetchedAt) / 1000) : null;
  return (
    <header className="topbar">
      <span className="topbar__title">nvHASH Console</span>
      <Pill tone={isMainnet ? "neutral" : "warning"}>{config.chainId}</Pill>
      {wallet_devnet_chip()}
      <span className="topbar__spacer" />
      <span
        className={`freshness${stale ? " stale" : ""}`}
        title={block.data ? `block ${block.data.height}` : ""}
      >
        {stale ? "STALE" : age === null ? "…" : `fetched ${age}s ago`}
      </span>
      <ThemeToggle />
      <WalletButton />
    </header>
  );

  function wallet_devnet_chip() {
    return config.devnetKeyMode || config.mock ? (
      <Pill tone="warning">{config.mock ? "mock data" : "devnet key mode"}</Pill>
    ) : null;
  }
}

export function BannerStack() {
  const { epoch, vault, jail, stale } = useStore();
  const banners: { tone: "critical" | "serious" | "warning"; icon: string; text: string }[] = [];
  if (epoch.data?.halted)
    banners.push({
      tone: "critical",
      icon: "■",
      text: "Contract HALTED. RunEpoch, continuations, ServiceRedemptions, and purge are stopped.",
    });
  if (vault.data?.paused)
    banners.push({
      tone: "serious",
      icon: "⏸",
      text: `Vault PAUSED${vault.data.pause_reason ? `: ${vault.data.pause_reason}` : ""}. User swaps and pending payouts are blocked.`,
    });
  if ((jail.data?.reports.length ?? 0) > 0)
    banners.push({
      tone: "warning",
      icon: "▲",
      text: `${jail.data!.reports.length} open jail report(s). See Jail Watch.`,
    });
  if (stale)
    banners.push({
      tone: "warning",
      icon: "◷",
      text: "Data is stale; writes are disabled until reads recover.",
    });
  return (
    <div className="bannerstack">
      {banners.slice(0, 2).map((b, i) => (
        <div key={i} className={`banner banner--${b.tone}`}>
          <span className="banner__icon" aria-hidden>
            {b.icon}
          </span>
          <span>{b.text}</span>
        </div>
      ))}
    </div>
  );
}

export function SideNav() {
  const { role } = useStore();
  const wallet = useWallet();
  const link = (to: string, label: string) => (
    <NavLink
      to={to}
      end={to === "/"}
      className={({ isActive }) => `sidenav__link${isActive ? " active" : ""}`}
    >
      {label}
    </NavLink>
  );
  return (
    <nav className="sidenav" aria-label="sections">
      <div className="sidenav__group">
        <div className="sidenav__caption">Monitor</div>
        {link("/", "Overview")}
        {link("/validators", "Validators")}
        {link("/redemptions", "Redemptions")}
        {link("/jail", "Jail Watch")}
        {link("/governance", "Governance")}
      </div>
      <div className="sidenav__group">
        <div className="sidenav__caption">Operate</div>
        {link("/epoch", "Epoch & Ops")}
        {wallet.address && link("/desk", "Validator Desk")}
        {role === "admin" && link("/admin", "Admin")}
      </div>
    </nav>
  );
}

export function Footer() {
  const { block, nowSecs, config: cfg } = useStore();
  return (
    <footer className="footer">
      <span>block {block.data?.height ?? "—"}</span>
      <span>
        {block.fetchedAt ? relTime(Math.floor(block.fetchedAt / 1000), nowSecs) : "—"} fetched
      </span>
      <span className="mono">{config.contractAddress.slice(0, 16)}…</span>
      <span>vault {cfg.data ? `${cfg.data.vault_address.slice(0, 12)}…` : "—"}</span>
      <span>console spec v2.0-RC1</span>
      {/* Pre-certification caveat (plan 8.4 §2.7.2, D22): the fixture-corpus
          manifest status is BAKED at build time by vite.config.ts — the same
          fact the App reads at runtime, no per-environment flag to lie with.
          Retires only when 8.0's re-capture flips the manifest. */}
      {__CORPUS_CERTIFIED__ ? null : (
        <span className="pill pill--warning" data-certification-caveat>
          pre-certification build (feature-probe vetted, no formal vault release)
        </span>
      )}
    </footer>
  );
}
