// Unit: the rate-limit client key ignores a client-supplied X-Forwarded-For
// unless proxy trust is explicitly on — otherwise a client could spoof its key
// and evade rate limiting (SECURITY.md: APIs are defensive).

import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import { clientKey } from "../src/http-server.ts";

function fakeReq(headers: Record<string, string | string[] | undefined>, remoteAddress?: string): IncomingMessage {
  return { headers, socket: { remoteAddress } } as unknown as IncomingMessage;
}

describe("clientKey", () => {
  it("uses the socket address and ignores X-Forwarded-For when proxy is untrusted", () => {
    const req = fakeReq({ "x-forwarded-for": "1.2.3.4" }, "10.0.0.1");
    expect(clientKey(req, false)).toBe("10.0.0.1");
  });

  it("honors the first X-Forwarded-For hop only when proxy is trusted", () => {
    const req = fakeReq({ "x-forwarded-for": "1.2.3.4, 5.6.7.8" }, "10.0.0.1");
    expect(clientKey(req, true)).toBe("1.2.3.4");
  });

  it("falls back to the socket address when the trusted header is absent", () => {
    expect(clientKey(fakeReq({}, "10.0.0.1"), true)).toBe("10.0.0.1");
  });

  it("falls back to 'unknown' when no address is available", () => {
    expect(clientKey(fakeReq({}), false)).toBe("unknown");
  });
});
