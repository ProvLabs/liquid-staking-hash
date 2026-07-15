import { PassThrough } from "node:stream";

import { createReadableStreamFromReadable } from "@react-router/node";
import { isbot } from "isbot";
import type { RenderToPipeableStreamOptions } from "react-dom/server";
import { renderToPipeableStream } from "react-dom/server";
import type { AppLoadContext, EntryContext } from "react-router";
import { ServerRouter } from "react-router";

import { getBootedConfig } from "~/config/config.server";

// Offline mode for tests and the MSW-backed e2e suite: serve chain reads from
// the @nvhash/fixtures corpus instead of a live LCD. Never a production
// posture — it exists so the web lane builds offline (plan §3).
if (process.env.NVHASH_MOCK === "1") {
  const { server } = await import("./mocks/node");
  server.listen({ onUnhandledRequest: "bypass" });
  console.warn("[nvhash-web] NVHASH_MOCK=1 — chain reads served from @nvhash/fixtures via MSW");
}

// Boot checks run at process startup, before any request is served: config is
// validated and bounded, the console profile's chain id must match ours, and
// the contract's Config {} must report the configured vault address. A
// mismatch fails startup loudly (app-spec §7, §12.2).
try {
  await getBootedConfig();
} catch (error) {
  console.error("[nvhash-web] BOOT CHECK FAILED — refusing to serve:", error);
  throw error;
}

export const streamTimeout = 5_000;

export default function handleRequest(
  request: Request,
  responseStatusCode: number,
  responseHeaders: Headers,
  routerContext: EntryContext,
  _loadContext: AppLoadContext,
) {
  return new Promise<Response>((resolve, reject) => {
    let shellRendered = false;
    const userAgent = request.headers.get("user-agent");

    // Bots and SPA-mode wait for all content; browsers stream the shell.
    const readyOption: keyof RenderToPipeableStreamOptions =
      (userAgent && isbot(userAgent)) || routerContext.isSpaMode ? "onAllReady" : "onShellReady";

    const { pipe, abort } = renderToPipeableStream(
      <ServerRouter context={routerContext} url={request.url} />,
      {
        [readyOption]() {
          shellRendered = true;
          const body = new PassThrough();
          const stream = createReadableStreamFromReadable(body);
          responseHeaders.set("Content-Type", "text/html");
          resolve(
            new Response(stream, {
              headers: responseHeaders,
              status: responseStatusCode,
            }),
          );
          pipe(body);
        },
        onShellError(error: unknown) {
          reject(error instanceof Error ? error : new Error(String(error)));
        },
        onError(error: unknown) {
          responseStatusCode = 500;
          // Only log post-shell render errors; shell errors reject above.
          if (shellRendered) {
            console.error(error);
          }
        },
      },
    );

    // Abort the render if it outlives the stream timeout.
    setTimeout(abort, streamTimeout + 1_000);
  });
}
