// Web Push fan-out (plan 6.3 §2.3). A notifier-only module (OUTSIDE `app/`, so
// the React Router build never bundles it — and `web-push`, imported only
// here, never reaches the client). After a stream's `commitTick` returns the
// NEWLY-INSERTED notifications, the tick's delivery phase — OUTSIDE any DB
// transaction (the two-phase rule) — sends each to the recipient address's
// push subscriptions.
//
// Push is additive latency, NEVER load-bearing (§10.4, invariant 7): every kind
// already rendered in-app when the notification row was inserted. So fan-out:
//   * degrades silently — a failure logs (endpoint SCRUBBED) and drops; there
//     is NO retry queue in v1 (in-app is the guaranteed channel);
//   * prunes dead endpoints — a 404/410 deletes the subscription row (the
//     revocability mechanism working in reverse);
//   * never fails the tick — this module does not throw.
//
// The push body is the closed `{ kind, url }` derived from the kind alone
// (toPushPayload) — no amounts, no addresses, no ids reach the third-party push
// service (invariant 3).

import { toPushPayload, type Candidate } from "../app/lib/services/alerts.server.ts";
import type { PushStore, PushSubscriptionRecord } from "../app/lib/models/push.server.ts";

/** Minimal logger surface (structurally compatible with the notifier Logger). */
interface PushLogger {
  error(message: string, fields?: Record<string, unknown>): void;
}

/** VAPID triple the production sender signs with (server-only material). */
export interface VapidDetails {
  subject: string;
  publicKey: string;
  privateKey: string;
}

/**
 * One push delivery. Resolves on success; REJECTS on failure, carrying a
 * numeric `statusCode` for HTTP errors (404/410 → prune). Injectable so a tick
 * is testable with a fake transport (the notifier's clock/fetch precedent).
 */
export interface PushSender {
  send(sub: PushSubscriptionRecord, payload: string): Promise<void>;
}

/**
 * Production `PushSender` over the `web-push` package (VAPID signing +
 * `aes128gcm` encryption). Lazily imported so importing this module (for the
 * fan-out and its fake) never loads `web-push`, and so the client bundle — from
 * which this module is already absent — can never reach it.
 */
export function webPushSender(vapid: VapidDetails): PushSender {
  return {
    async send(sub, payload) {
      const webpush = (await import("web-push")).default;
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        payload,
        { vapidDetails: vapid, TTL: 60 },
      );
    },
  };
}

function statusOf(err: unknown): number | undefined {
  if (err !== null && typeof err === "object" && "statusCode" in err) {
    const code = (err as { statusCode: unknown }).statusCode;
    return typeof code === "number" ? code : undefined;
  }
  return undefined;
}

function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Fan the newly-inserted notifications out to push subscriptions. No-op when
 * push is unconfigured (`sender === undefined`) or nothing was inserted. Never
 * throws — a failed lookup/send is logged (endpoint scrubbed) and dropped; a
 * dead endpoint (404/410) is pruned.
 */
export async function fanOutPush(params: {
  inserted: readonly Candidate[];
  pushStore: PushStore;
  sender: PushSender | undefined;
  log: PushLogger;
}): Promise<void> {
  const { inserted, pushStore, sender, log } = params;
  if (sender === undefined || inserted.length === 0) return;

  // One subscription lookup per recipient address.
  const byAddress = new Map<string, Candidate[]>();
  for (const c of inserted) {
    const list = byAddress.get(c.address);
    if (list !== undefined) list.push(c);
    else byAddress.set(c.address, [c]);
  }

  for (const [address, cands] of byAddress) {
    let subs: PushSubscriptionRecord[];
    try {
      subs = await pushStore.listForAddress(address);
    } catch (err) {
      // SCRUB: log the reason only, never the address's endpoints/keys.
      log.error("push subscription lookup failed", { reason: reasonOf(err) });
      continue;
    }
    for (const sub of subs) {
      for (const c of cands) {
        try {
          await sender.send(sub, JSON.stringify(toPushPayload(c.kind)));
        } catch (err) {
          const status = statusOf(err);
          if (status === 404 || status === 410) {
            // Dead endpoint: prune it and stop sending to it this tick.
            try {
              await pushStore.deleteForEndpoint(sub.endpoint);
            } catch (pruneErr) {
              log.error("push endpoint prune failed", { reason: reasonOf(pruneErr) });
            }
            break;
          }
          // Transient (timeout/5xx): drop with a SCRUBBED line — never the
          // endpoint or keys (they can fingerprint the browser vendor).
          log.error("push send failed", { kind: c.kind, status: status ?? null });
        }
      }
    }
  }
}
