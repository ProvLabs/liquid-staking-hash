import { useState } from "react";
import { NavLink, useParams } from "react-router";

import { t, type Locale, type MessageKey } from "~/i18n";

// §8.0 top nav: Learn · Stake · Redeem · Portfolio · Market · Validators ·
// Governance (Redeem/`/exit` is grouped with Stake as its
// transacting counterpart). Links are locale-prefixed (a reader on /en stays
// on /en); the active route gets aria-current="page" via NavLink. On narrow
// viewports the list collapses behind a keyboard-operable disclosure button.
const NAV_ITEMS: ReadonlyArray<{ key: MessageKey; path: string }> = [
  { key: "chrome.nav-learn", path: "" },
  { key: "chrome.nav-stake", path: "stake" },
  { key: "chrome.nav-exit", path: "exit" },
  { key: "chrome.nav-portfolio", path: "portfolio" },
  { key: "chrome.nav-market", path: "market" },
  { key: "chrome.nav-validators", path: "validators" },
  { key: "chrome.nav-governance", path: "governance" },
];

export function Nav({ locale }: { locale: Locale }) {
  const { lang } = useParams();
  const prefix = lang ? `/${lang}` : "";
  const [open, setOpen] = useState(false);

  return (
    <nav
      aria-label={t(locale, "chrome.nav-label")}
      className="order-last basis-full md:order-none md:basis-auto"
    >
      <button
        type="button"
        aria-expanded={open}
        aria-controls="primary-nav-list"
        onClick={() => setOpen((value) => !value)}
        className="inline-flex items-center rounded-md border px-2.5 py-1.5 text-sm md:hidden"
      >
        {t(locale, "chrome.nav-menu")}
      </button>
      <div
        id="primary-nav-list"
        className={`${open ? "mt-2 flex flex-col items-start gap-1" : "hidden"} md:mt-0 md:flex md:flex-row md:items-center md:gap-1`}
      >
        {NAV_ITEMS.map(({ key, path }) => (
          <NavLink
            key={key}
            to={path === "" ? prefix || "/" : `${prefix}/${path}`}
            end={path === ""}
            onClick={() => setOpen(false)}
            className="rounded px-2 py-1 text-sm text-muted-foreground hover:text-foreground aria-[current=page]:font-medium aria-[current=page]:text-foreground"
          >
            {t(locale, key)}
          </NavLink>
        ))}
      </div>
    </nav>
  );
}
