// Session service (app-spec §3 decision 5, §12.3): nonce mint →
// ADR-36 verify → opaque-id cookie over a server-side row. Business logic
// only — persistence is the SessionStore port (models layer), crypto is
// adr36-verify.server.ts, and every input crosses a zod bound HERE before
// touching either (SECURITY.md: validate and bound at the boundary; reject,
// never clamp).
//
// Cookie discipline (§12.3, gated by test/session.test.ts):
//   * value = the opaque 256-bit session id, nothing else (never a claims
//     token; the row is the session)
//   * HttpOnly always; SameSite=Lax; Path=/; Secure outside development
// * absolute ceiling 7 days + 24 h sliding inactivity bound (§7 Q6
//     proposal values — the mechanism is spec-pinned, the numbers are not)
//
// requireSession / getSessionContext are the ONLY paths into personal
// loaders (standing session-scope gate): the acting address
// is always the session row's address, never a query param.

import { randomBytes } from "node:crypto";
import { z } from "zod";

import { loginChallenge } from "~/lib/adr36";
import { verifyAdr36 } from "~/lib/adr36-verify.server";
import { getSessionStore, type SessionRow, type SessionStore } from "~/lib/models/session.server";
import { getPushStore, type PushStore } from "~/lib/models/push.server";
import type { WebConfig } from "~/config/config.server";

export const NONCE_TTL_SECONDS = 5 * 60;
export const SESSION_ABSOLUTE_TTL_SECONDS = 7 * 24 * 60 * 60;
/** Refresh cadence: role re-check + lastRefreshAt update at most this often. */
export const SESSION_REFRESH_INTERVAL_SECONDS = 60;

export const SESSION_COOKIE_NAME = "nvhash_session";

// Boundary schemas. Addresses reuse the config boundary's bech32 shape;
// base64 fields are length-bounded to their exact decoded sizes.
export const bech32AddressSchema = z
  .string()
  .regex(/^(tp|pb)1[02-9ac-hj-np-z]{38,90}$/, "expected a bech32 Provenance address");
const base64 = /^[A-Za-z0-9+/]+={0,2}$/;
export const nonceSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/, "expected a 32-byte nonce");
export const pubkeySchema = z.string().length(44).regex(base64); // 33 bytes
export const signatureSchema = z.string().length(88).regex(base64); // 64 bytes

export const loginBodySchema = z.object({
  address: bech32AddressSchema,
  nonce: nonceSchema,
  pubkey: pubkeySchema,
  signature: signatureSchema,
});
export type LoginBody = z.infer<typeof loginBodySchema>;

export interface SessionContext {
  address: string;
}

/** Injectable seams (tests pin the clock; production uses the defaults). */
export interface SessionDeps {
  store: SessionStore;
  now?: () => Date;
  /**
   * Push-token deletion chain: removing a session removes its
   * push subscriptions. Injected so the deletion gate can assert it
   * (test/push-token-deletion.test.ts).
   */
  pushStore?: PushStore;
}

interface ResolvedDeps {
  store: SessionStore;
  now: () => Date;
  pushStore: PushStore;
}

async function deps(config: WebConfig, override?: Partial<SessionDeps>): Promise<ResolvedDeps> {
  return {
    store: override?.store ?? (await getSessionStore(config)),
    now: override?.now ?? (() => new Date()),
    pushStore: override?.pushStore ?? (await getPushStore(config)),
  };
}

/** Mint an address-bound single-use nonce (POST /session/nonce). */
export async function mintNonce(
  config: WebConfig,
  address: string,
  override?: Partial<SessionDeps>,
): Promise<{ nonce: string; challenge: string; expiresInSeconds: number }> {
  const { store, now } = await deps(config, override);
  const nonce = randomBytes(32).toString("base64url");
  const at = now!();
  await store.createNonce(nonce, address, new Date(at.getTime() + NONCE_TTL_SECONDS * 1000));
  return {
    nonce,
    challenge: loginChallenge(config.chainId, nonce),
    expiresInSeconds: NONCE_TTL_SECONDS,
  };
}

export type LoginResult =
  | { ok: true; address: string; setCookie: string }
  | { ok: false }; // one undifferentiated failure → 401 (auth.ts precedent)

/** Verify a signed challenge and establish a session (POST /session/login). */
export async function login(
  config: WebConfig,
  body: LoginBody,
  override?: Partial<SessionDeps>,
): Promise<LoginResult> {
  const { store, now } = await deps(config, override);
  const at = now!();

  // Single-use gate: consume first, so even a verification failure burns the
  // nonce (a captured challenge cannot be retried with a fixed signature).
  const consumed = await store.consumeNonce(body.nonce, at);
  if (consumed === null || consumed.address !== body.address) return { ok: false };

  const verified = verifyAdr36({
    address: body.address,
    challengeText: loginChallenge(config.chainId, body.nonce),
    pubkeyBase64: body.pubkey,
    signatureBase64: body.signature,
  });
  if (!verified) return { ok: false };

  const id = randomBytes(32).toString("base64url");
  const row: SessionRow = {
    id,
    address: body.address,
    createdAt: at,
    expiresAt: new Date(at.getTime() + SESSION_ABSOLUTE_TTL_SECONDS * 1000),
    lastRefreshAt: at,
  };
  await store.createSession(row);
  await store.touchAddressActivity(body.address, at);
  return { ok: true, address: body.address, setCookie: sessionCookie(config, id, row.expiresAt, at) };
}

/** Destroy the session row and clear the cookie (POST /session/logout). */
export async function logout(
  config: WebConfig,
  request: Request,
  override?: Partial<SessionDeps>,
): Promise<{ setCookie: string }> {
  const { store, pushStore } = await deps(config, override);
  const id = sessionIdFromCookieHeader(request.headers.get("Cookie"));
  if (id !== null) await destroySession(store, pushStore, id);
  return { setCookie: clearSessionCookie(config) };
}

/**
 * Remove a session AND its push subscriptions (the deletion
 * chain, a standing SECURITY.md-exception gate). Fired from logout and from the
 * expiry-sweep path below; idempotent (a no-op for an already-gone id).
 *
 * NB: this is a two-step delete, not one DB transaction — 5.1/6.2 give the
 * session and push stores SEPARATE Prisma clients, so cross-store atomicity is
 * not available without unifying them (the recorded post-milestone follow-on).
 * The security property (no push token outlives its session) holds by two
 * mechanisms instead:
 *   * ORDER: push rows are deleted FIRST, so a failure between the steps
 *     strands a harmless session remnant (retried on the next logout attempt
 *     or swept by the stale-cookie path below) — never a live token;
 *   * the notifier tick's invariant sweep (`PushStore.sweepOrphans`) deletes
 *     any subscription whose session is missing or expired, every tick —
 *     covering crash remnants AND browsers that never present their stale
 *     cookie. Push is latency-sugar (§10.4), never load-bearing.
 */
async function destroySession(store: SessionStore, pushStore: PushStore, id: string): Promise<void> {
  await pushStore.deleteForSession(id);
  await store.deleteSession(id);
}

/**
 * Resolve the request's session, refreshing the sliding bound at most once
 * per SESSION_REFRESH_INTERVAL_SECONDS. Null for anonymous/expired — public
 * pages render their anonymous state; personal loaders prompt-and-explain.
 */
export async function getSessionContext(
  config: WebConfig,
  request: Request,
  override?: Partial<SessionDeps>,
): Promise<SessionContext | null> {
  const { store, now, pushStore } = await deps(config, override);
  const id = sessionIdFromCookieHeader(request.headers.get("Cookie"));
  if (id === null) return null;
  const at = now!();
  const row = await store.getSession(id, at);
  if (row === null) {
    // A well-formed cookie that resolves to no live session is an expired or
    // already-removed session presented by a stale cookie: sweep its remnant
    // and, via the deletion chain, its push subscriptions. A no-op
    // for a never-existed id, so a forged cookie costs only two empty deletes.
    await destroySession(store, pushStore, id);
    return null;
  }
  if (at.getTime() - row.lastRefreshAt.getTime() >= SESSION_REFRESH_INTERVAL_SECONDS * 1000) {
    await store.refreshSession(id, at);
    await store.touchAddressActivity(row.address, at);
  }
  return { address: row.address };
}

/**
 * The only entry into personal resource routes: session or a reasonless 401.
 * (Personal PAGE loaders use getSessionContext and render the connect
 * prompt instead — never blank, never another address's data.)
 */
export async function requireSession(
  config: WebConfig,
  request: Request,
  override?: Partial<SessionDeps>,
): Promise<SessionContext> {
  const context = await getSessionContext(config, request, override);
  if (context === null) {
    throw new Response(JSON.stringify({ error: "session required" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }
  return context;
}

// ── Cookie helpers ───────────────────────────────────────────────────────

function cookieAttributes(config: WebConfig): string {
  const secure = config.appEnv === "development" ? "" : "; Secure";
  return `; Path=/; HttpOnly; SameSite=Lax${secure}`;
}

function sessionCookie(config: WebConfig, id: string, expiresAt: Date, now: Date): string {
  const maxAge = Math.max(0, Math.floor((expiresAt.getTime() - now.getTime()) / 1000));
  return `${SESSION_COOKIE_NAME}=${id}; Max-Age=${maxAge}${cookieAttributes(config)}`;
}

function clearSessionCookie(config: WebConfig): string {
  return `${SESSION_COOKIE_NAME}=; Max-Age=0${cookieAttributes(config)}`;
}

/** Extract and bound the session id from a Cookie header (null if absent). */
export function sessionIdFromCookieHeader(header: string | null): string | null {
  if (header === null) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== SESSION_COOKIE_NAME) continue;
    const value = part.slice(eq + 1).trim();
    // 256-bit base64url id — anything else is not ours (reject, not clamp).
    if (/^[A-Za-z0-9_-]{43}$/.test(value)) return value;
    return null;
  }
  return null;
}
