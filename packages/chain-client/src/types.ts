import { expectObject, expectString, parseU64String, type Coin } from "./amounts.ts";

/** Standard cosmos-sdk pagination envelope. */
export interface Pagination {
  nextKey: string | null;
  total: bigint;
}

export function parsePagination(value: unknown, path = "$.pagination"): Pagination {
  const o = expectObject(value, path);
  const nk = o["next_key"];
  return {
    nextKey: nk === null || nk === undefined ? null : expectString(nk, `${path}.next_key`),
    total: parseU64String(o["total"], `${path}.total`),
  };
}

export type { Coin };
