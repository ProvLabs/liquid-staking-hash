// Web Push feature-server module: the seam the
// `/push/subscription` resource route uses. Wraps the PushStore (models layer)
// with the route boundary schema. Everything crosses a zod bound HERE before
// touching the store (SECURITY.md: validate and bound at the boundary; reject,
// never clamp). The acting address AND the session id come only from the
// session (requireSession + the cookie), never from the request body — the
// body carries only the opaque W3C subscription triple.

import { z } from "zod";

import type { WebConfig } from "~/config/config.server";
import { getPushStore } from "~/lib/models/push.server";

/** base64url subscription key material, bounded to its kind's max (plan §2.2). */
const base64urlKey = (max: number) =>
  z.string().regex(/^[A-Za-z0-9_-]+={0,2}$/, "expected base64url key material").min(1).max(max);

/**
 * POST body = the W3C `PushSubscription.toJSON()` subset the App stores:
 * an https endpoint (≤ 1024) plus the p256dh/auth key pair (base64url, length
 * capped). `.strict()` rejects any extra field (e.g. `expirationTime`) — the
 * App stores exactly the triple and nothing that could carry identity.
 */
export const pushSubscriptionBodySchema = z
  .object({
    endpoint: z
      .string()
      .url()
      .max(1024)
      .refine((s) => /^https:\/\//.test(s), "expected an https endpoint"),
    keys: z
      .object({
        p256dh: base64urlKey(256),
        auth: base64urlKey(128),
      })
      .strict(),
  })
  .strict();
export type PushSubscriptionBody = z.infer<typeof pushSubscriptionBodySchema>;

/**
 * Store (opt-in) the session's subscription — replace-by-session, capped per
 * address (the store enforces both). Created only from a validated body behind
 * requireSession; the session id is the deletion-chain key.
 */
export async function saveSubscription(
  config: WebConfig,
  address: string,
  sessionId: string,
  body: PushSubscriptionBody,
): Promise<void> {
  const store = await getPushStore(config);
  await store.upsertForSession(address, sessionId, {
    endpoint: body.endpoint,
    p256dh: body.keys.p256dh,
    auth: body.keys.auth,
  });
}

/**
 * Opt-out: remove the session's subscription(s). Session-scoped by id, so a
 * DELETE can only ever remove the caller's own rows. Returns the count removed.
 */
export async function deleteSubscriptionsForSession(config: WebConfig, sessionId: string): Promise<number> {
  const store = await getPushStore(config);
  return store.deleteForSession(sessionId);
}
