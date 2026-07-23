// Typed reads for x/group over LCD — the governance surface the App renders
// (spec §8.7) and the admin role detection of the session layer (spec §4,
// plan PR 5.1: admin = session address ∈ the admin group-policy's members,
// re-checked live per session refresh). Proposal/vote reads extend here with
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

export interface GroupPolicyInfo {
  /** The policy account address (what the contract's `Config.admin` names). */
  address: string;
  groupId: bigint;
  admin: string;
  metadata: string;
  version: bigint;
  createdAt: string;
}

export function parseGroupPolicyInfo(value: unknown, path = "$"): GroupPolicyInfo {
  const o = expectObject(value, path);
  return {
    address: expectString(o["address"], `${path}.address`),
    groupId: parseU64String(o["group_id"], `${path}.group_id`),
    admin: expectString(o["admin"], `${path}.admin`),
    metadata: expectString(o["metadata"] ?? "", `${path}.metadata`),
    version: parseU64String(o["version"], `${path}.version`),
    createdAt: expectString(o["created_at"], `${path}.created_at`),
  };
}

export interface GroupMember {
  address: string;
  /** decimal string per x/group */
  weight: string;
  metadata: string;
  addedAt: string;
}

export function parseGroupMember(value: unknown, path = "$"): GroupMember {
  const o = expectObject(value, path);
  // LCD nests the member under `member` alongside `group_id`.
  const m = expectObject(o["member"], `${path}.member`);
  return {
    address: expectString(m["address"], `${path}.member.address`),
    weight: expectString(m["weight"], `${path}.member.weight`),
    metadata: expectString(m["metadata"] ?? "", `${path}.member.metadata`),
    addedAt: expectString(m["added_at"], `${path}.member.added_at`),
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

  /**
   * Resolve a group-policy account address to its policy info (PR 5.1: the
   * contract's `Config.admin` is expected to be a group-policy address; a 404
   * from the LCD means it is a plain account instead — callers treat that as
   * "no group behind the admin").
   */
  async groupPolicyInfo(policyAddress: string): Promise<GroupPolicyInfo> {
    const o = expectObject(
      await this.lcd.get(`cosmos/group/v1/group_policy_info/${encodeURIComponent(policyAddress)}`),
    );
    return parseGroupPolicyInfo(o["info"], "$.info");
  }

  /** Members of a group, paginated (admin-membership check, spec §4). */
  async groupMembers(
    groupId: bigint,
    params?: QueryParams,
  ): Promise<{ members: GroupMember[]; pagination: Pagination }> {
    const o = expectObject(
      await this.lcd.get(`cosmos/group/v1/group_members/${groupId.toString()}`, params),
    );
    return {
      members: expectArray(o["members"], "$.members").map((m, i) =>
        parseGroupMember(m, `$.members[${i}]`),
      ),
      pagination: parsePagination(o["pagination"]),
    };
  }
}
