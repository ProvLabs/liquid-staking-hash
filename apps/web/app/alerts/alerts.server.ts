// Alerts feature-server module (plan 6.2 §2.6): the seam the two `/alerts/*`
// resource routes and the root loader's unread count use. Wraps the AlertStore
// (models layer) with the pure effective-settings merge (services layer) and
// the route boundary schemas. The acting address is ALWAYS the session address
// (the routes pass `session.address`); nothing here reads an address from user
// input (the standing session-scope gate, plan §4.6).

import { z } from "zod";
import type { WebConfig } from "~/config/config.server";
import { getAlertStore, type MarkReadSelector } from "~/lib/models/alerts.server";
import {
  alertKindSchema,
  effectiveSettings,
  type AlertKind,
  type EffectiveSetting,
} from "~/lib/services/alerts.server";

/** Notifications page size (bell popover; bounded, the portfolio precedent). */
export const NOTIFICATIONS_PAGE_SIZE = 30;
/** Max ids one mark-read call may carry (plan §2.6). */
export const MAX_MARK_READ_IDS = 100;

/**
 * `?page=` bound: a non-negative integer, reject-never-clamp (400 on bad).
 * 1 000 pages × 30 rows = a 30 000-row offset ceiling — well inside the
 * cross-system `MAX_PAGE_OFFSET` (1 000 000) and generous against a log the
 * retention sweep caps at 180 days.
 */
export const MAX_NOTIFICATIONS_PAGE = 1_000;
export const notificationsPageSchema = z.coerce.number().int().min(0).max(MAX_NOTIFICATIONS_PAGE);

/** POST /alerts/notifications body: explicit ids or the whole unread set. */
export const markReadBodySchema = z.union([
  z.object({ ids: z.array(z.string().regex(/^\d+$/, "expected a numeric id")).min(1).max(MAX_MARK_READ_IDS) }),
  z.object({ all: z.literal(true) }),
]);
export type MarkReadBody = z.infer<typeof markReadBodySchema>;

/** POST /alerts/rules body: a closed-enum kind + the preference bit. */
export const ruleUpsertBodySchema = z.object({
  kind: alertKindSchema, // unknown kind → 400 (reject, never guess)
  enabled: z.boolean(),
});
export type RuleUpsertBody = z.infer<typeof ruleUpsertBodySchema>;

/** A notification serialized for the client (bell renders copy from these). */
export interface NotificationView {
  /** BigInt id as a decimal string (JSON-safe; the mark-read key). */
  id: string;
  kind: AlertKind;
  /** Closed per-kind payload (identifiers/ordinals only, never amounts). */
  payload: unknown;
  delivered_at: string;
  read_at: string | null;
}

function toView(record: {
  id: bigint;
  kind: AlertKind;
  payload: unknown;
  deliveredAt: Date;
  readAt: Date | null;
}): NotificationView {
  return {
    id: record.id.toString(),
    kind: record.kind,
    payload: record.payload,
    delivered_at: record.deliveredAt.toISOString(),
    read_at: record.readAt === null ? null : record.readAt.toISOString(),
  };
}

/** The session address's notifications for a page (newest first). */
export async function loadNotifications(
  config: WebConfig,
  address: string,
  page: number,
): Promise<{ notifications: NotificationView[]; unread: number }> {
  const store = await getAlertStore(config);
  const [rows, unread] = await Promise.all([
    store.listNotifications(address, { limit: NOTIFICATIONS_PAGE_SIZE, offset: page * NOTIFICATIONS_PAGE_SIZE }),
    store.countUnread(address),
  ]);
  return { notifications: rows.map(toView), unread };
}

/** Unread count only (the root loader — only the integer crosses to the client). */
export async function countUnread(config: WebConfig, address: string): Promise<number> {
  const store = await getAlertStore(config);
  return store.countUnread(address);
}

/**
 * Mark the session address's notifications read. The store scopes the UPDATE by
 * `address`, so ids belonging to another address are never touched (§2.6).
 */
export async function markNotificationsRead(
  config: WebConfig,
  address: string,
  body: MarkReadBody,
): Promise<{ marked: number; unread: number }> {
  const store = await getAlertStore(config);
  const selector: MarkReadSelector = "all" in body ? { all: true } : { ids: body.ids.map((id) => BigInt(id)) };
  const marked = await store.markRead(address, selector, new Date());
  const unread = await store.countUnread(address);
  return { marked, unread };
}

/** The effective settings view (closed kind list × override × default). */
export async function loadEffectiveSettings(
  config: WebConfig,
  address: string,
): Promise<EffectiveSetting[]> {
  const store = await getAlertStore(config);
  return effectiveSettings(await store.listOverrides(address));
}

/** Upsert one override and return the recomputed effective settings. */
export async function setAlertRule(
  config: WebConfig,
  address: string,
  kind: AlertKind,
  enabled: boolean,
): Promise<EffectiveSetting[]> {
  const store = await getAlertStore(config);
  await store.upsertRule(address, kind, enabled);
  return effectiveSettings(await store.listOverrides(address));
}
