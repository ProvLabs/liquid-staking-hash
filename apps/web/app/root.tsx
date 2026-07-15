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
import { ThemeToggle } from "~/components/theme-toggle";
import { getBootedConfig, toClientConfig } from "~/config/config.server";
import { DEFAULT_LOCALE, isLocale, t, type Locale } from "~/i18n";
import { themeFromCookieHeader } from "~/theme/theme";
import type { Route } from "./+types/root";

export const links: Route.LinksFunction = () => [{ rel: "stylesheet", href: stylesheet }];

// The root loader is the ONLY place server config crosses to the client, and
// it crosses only as the §7 client-safe subset (toClientConfig is
// allowlist-gated; see test/client-config.test.ts and check-bundle-secrets).
// getBootedConfig has already run the boot checks — a failed boot means this
// throws and the app serves nothing rather than something misconfigured.
export async function loader({ request }: Route.LoaderArgs) {
  const config = await getBootedConfig();
  return {
    clientConfig: toClientConfig(config),
    theme: themeFromCookieHeader(request.headers.get("Cookie")),
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
        <header className="flex items-center justify-between border-b px-6 py-3">
          <span className="font-semibold">{t(locale, "app.name")}</span>
          <ThemeToggle locale={locale} initialTheme={theme} />
        </header>
        <main className="flex-1">{children}</main>
        <footer className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t px-6 py-3 text-sm text-muted-foreground">
          {data ? (
            <>
              <span>
                {t(locale, "chrome.chain-label")}: {data.clientConfig.chainId}
              </span>
              <a
                className="underline underline-offset-4 hover:text-foreground"
                href={data.clientConfig.consoleUrl}
                rel="noreferrer"
              >
                {t(locale, "chrome.console-link")} ↗
              </a>
            </>
          ) : null}
        </footer>
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
