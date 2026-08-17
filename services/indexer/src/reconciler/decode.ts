// Local mirror of the vault pause state — never a chain-client import
// (indexer-design-notes "Local mirrors over cross-package imports").

import { expectObject } from "../decode/scalars.ts";

export interface VaultPause {
  readonly paused: boolean;
  readonly reason: string;
}

/** Parse `GET vault/v1/vaults/{id}` pause facts; proto3 omits falsy, so
 * absent `paused` = false, absent `paused_reason` = "". */
export function parseVaultPause(body: unknown, path = "$"): VaultPause {
  const vault = expectObject(expectObject(body, path)["vault"], `${path}.vault`);
  return {
    paused: vault["paused"] === true,
    reason: typeof vault["paused_reason"] === "string" ? vault["paused_reason"] : "",
  };
}
