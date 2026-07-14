// Typed reads for x/group over LCD — the governance surface the App renders
// (spec §8.7). v1 needs group metadata; proposal/vote reads extend here with
// plan PR 7.1.

import {
  expectArray,
  expectObject,
  expectString,
  parseU64String,
} from "./amounts.ts";
import { LcdClient, type QueryParams } from "./lcd.ts";
import { parsePagination, type Pagination } from "./types.ts";

export interface GroupInfo {
  id: bigint;
  admin: string;
  metadata: string;
  version: bigint;
  /** decimal string per x/group */
  totalWeight: string;
  createdAt: string;
}

export function parseGroupInfo(value: unknown, path = "$"): GroupInfo {
  const o = expectObject(value, path);
  return {
    id: parseU64String(o["id"], `${path}.id`),
    admin: expectString(o["admin"], `${path}.admin`),
    metadata: expectString(o["metadata"] ?? "", `${path}.metadata`),
    version: parseU64String(o["version"], `${path}.version`),
    totalWeight: expectString(o["total_weight"], `${path}.total_weight`),
    createdAt: expectString(o["created_at"], `${path}.created_at`),
  };
}

export class GroupClient {
  constructor(private readonly lcd: LcdClient) {}

  async groups(params?: QueryParams): Promise<{ groups: GroupInfo[]; pagination: Pagination }> {
    const o = expectObject(await this.lcd.get("cosmos/group/v1/groups", params));
    return {
      groups: expectArray(o["groups"], "$.groups").map((g, i) => parseGroupInfo(g, `$.groups[${i}]`)),
      pagination: parsePagination(o["pagination"]),
    };
  }
}
