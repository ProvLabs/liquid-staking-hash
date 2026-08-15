// Local parse of the vault module's pause state (app-spec §9.6
// "vault paused/unpaused (with reason)"). A LOCAL mirror, not a chain-client
// import — the indexer runtime keeps a zero cross-package dependency surface
// (indexer-design-notes: "Local mirrors over cross-package imports"). The
// jail-report parse is a same-package reuse of
// workers/validator-sampler/decode.ts, not duplicated here.

import { expectObject } from "../decode/scalars.ts";

export interface VaultPause {
  readonly paused: boolean;
  readonly reason: string;
}

/**
 * Parse `GET vault/v1/vaults/{id}` → `{vault: {paused, paused_reason}}` into
 * the pause facts the reconciler derives `vault_paused` from. Both fields are
 * absent-tolerant the way the chain serializes them (proto3 omits falsy):
 * absent `paused` is false, absent `paused_reason` is "".
 */
export function parseVaultPause(body: unknown, path = "$"): VaultPause {
  const vault = expectObject(expectObject(body, path)["vault"], `${path}.vault`);
  return {
    paused: vault["paused"] === true,
    reason: typeof vault["paused_reason"] === "string" ? vault["paused_reason"] : "",
  };
}
