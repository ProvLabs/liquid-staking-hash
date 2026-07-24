import {
  isRouteErrorResponse,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  useParams,
  useRouteLoaderData,
} from "react-router";

import stylesheet from "./app.css?url";
import { loadChromeState } from "~/chrome/chrome.server";
import { AlertsBell } from "~/components/chrome/alerts-bell";
import { Banner } from "~/components/chrome/banner";
import { EnvBadge } from "~/components/chrome/env-badge";
import { FreshnessFooter } from "~/components/chrome/freshness-footer";
import { Nav } from "~/components/chrome/nav";
import { WalletButton } from "~/components/chrome/wallet-button";
import { ThemeToggle } from "~/components/theme-toggle";
import { getBootedConfig, toClientConfig } from "~/config/config.server";
import { DEFAULT_LOCALE, isLocale, t, type Locale } from "~/i18n";
import { countUnread } from "~/alerts/alerts.server";
import { getSessionContext } from "~/lib/services/session.server";
import { themeFromCookieHeader } from "~/theme/theme";
import { WalletProvider } from "~/wallet/provider";
import type { Route } from "./+types/root";

export const links: Route.LinksFunction = () => [{ rel: "stylesheet", href: stylesheet }];

// The root loader is the ONLY place server config crosses to the client, and
// it crosses only as the §7 client-safe subset (toClientConfig is
// allowlist-gated; see test/client-config.test.ts and check-bundle-secrets).
// getBootedConfig has already run the boot checks — a failed boot means this
// throws and the app serves nothing rather than something misconfigured.
// ChromeState is public chain data (not config) and crosses alongside it.
export async function loader({ request }: Route.LoaderArgs) {
  const config = await getBootedConfig();
  const [chrome, session] = await Promise.all([
    loadChromeState(config),
    // PR 5.1: the session context is the server truth the wallet slot renders
    // from. Only the public address crosses (never the session id — the
    // cookie is HttpOnly and the id never appears in loader data).
    getSessionContext(config, request),
  ]);
  // M6.2: the bell's unread badge — only the integer crosses to the client
  // (never the notifications themselves; the popover fetches those on open).
  const unreadCount = session === null ? null : await countUnread(config, session.address);
  return {
    clientConfig: toClientConfig(config),
    theme: themeFromCookieHeader(request.headers.get("Cookie")),
    chrome,
    session: session === null ? null : { address: session.address },
    unreadCount,
  };
}

/** Locale for the current URL — resolved from the validated `:lang?` param. */
export function useLocale(): Locale {
  const { lang } = useParams();
  return isLocale(lang) ? lang : DEFAULT_LOCALE;
}

export function Layout({ children }: { children: React.ReactNode }) {
  const data = useRouteLoaderData<typeof loader>("root");
  const locale = useLocale();
  const theme = data?.theme ?? "auto";

  return (
    <html lang={locale} data-theme={theme === "auto" ? undefined : theme}>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <Meta />
        <Links />
      </head>
      <body className="flex min-h-svh flex-col antialiased">
        <WalletProvider
          chainId={data?.clientConfig.chainId ?? ""}
          walletConnectProjectId={data?.clientConfig.walletConnectProjectId ?? null}
          sessionAddress={data?.session?.address ?? null}
        >
          <header className="border-b">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-6 py-3">
              <span className="font-semibold">{t(locale, "app.name")}</span>
              <Nav locale={locale} />
              <div className="ml-auto flex items-center gap-3">
                {data ? (
                  <EnvBadge
                    locale={locale}
                    appEnv={data.clientConfig.appEnv}
                    chainId={data.clientConfig.chainId}
                  />
                ) : null}
                {data ? <WalletButton locale={locale} /> : null}
                <AlertsBell
                  locale={locale}
                  sessionAddress={data?.session?.address ?? null}
                  unreadCount={data?.unreadCount ?? null}
                />
                <ThemeToggle locale={locale} initialTheme={theme} />
              </div>
            </div>
          </header>
          <Banner locale={locale} banner={data?.chrome.banner ?? null} />
          <main className="flex-1">{children}</main>
        </WalletProvider>
        {data ? (
          <FreshnessFooter
            locale={locale}
            chainId={data.clientConfig.chainId}
            consoleUrl={data.clientConfig.consoleUrl}
            chrome={data.chrome}
          />
        ) : (
          <footer className="border-t px-6 py-3" />
        )}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  return <Outlet />;
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  const locale = useLocale();
  let title = t(locale, "error.generic-title");
  let body: string = t(locale, "error.generic-body");

  if (isRouteErrorResponse(error) && error.status === 404) {
    title = t(locale, "error.not-found-title");
    body = t(locale, "error.not-found-body");
  } else if (error instanceof Error && error.name === "BootCheckError") {
    // Boot-check failures are loud and specific in server logs; the page says
    // only that startup was refused (no config internals leave the server).
    title = t(locale, "error.boot-title");
    body = "";
  }

  return (
    <section className="mx-auto flex w-full max-w-2xl flex-col gap-3 px-6 py-16">
      <h1 className="text-2xl font-semibold">{title}</h1>
      {body ? <p className="text-muted-foreground">{body}</p> : null}
    </section>
  );
}
