#!/usr/bin/env bash
# VAPID generation, store-only (plan 8.4 §2.5.1). Generates the per-environment
# web-push key pair in the PINNED container (ADR-002 — never host node), writes
# all three values DIRECTLY into the secret store, and prints only the public
# key. The private key never touches a file, terminal scrollback, or the repo.
# The three vars are all-or-none at boot (app-spec §7 superRefine) — this
# script writes all three or aborts.
#
# Usage: generate-vapid.sh <env> <subject-mailto>
#   env             environment segment for the store path ({env}/WEB_PUSH_…)
#   subject-mailto  the VAPID subject (mailto: URI), treated server-only
#
# Store access: `store_put <path> <value>` is expected on PATH — the thin
# wrapper over the environment's secret-store CLI (ESO's backing store, plan
# §7 Q1). Keeping the store call behind one verb keeps this script identical
# across store products.
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "usage: $0 <env> <subject-mailto>" >&2
  exit 2
fi
env_name="$1"
subject="$2"
[[ "$subject" == mailto:* ]] || { echo "generate-vapid: subject must be a mailto: URI" >&2; exit 1; }
command -v store_put >/dev/null || {
  echo "generate-vapid: no store_put on PATH — the secret store is the ONLY place these keys may exist (D24)" >&2
  exit 1
}

# Generate inside the pinned toolchain image; JSON out, parsed here without
# ever echoing the private key.
pair="$(docker run --rm node:22-bookworm-slim sh -c \
  'npx --yes web-push@3 generate-vapid-keys --json' 2>/dev/null)"

public_key="$(node -e 'const p=JSON.parse(process.argv[1]);process.stdout.write(p.publicKey)' "$pair")"
private_key="$(node -e 'const p=JSON.parse(process.argv[1]);process.stdout.write(p.privateKey)' "$pair")"
[[ -n "$public_key" && -n "$private_key" ]] || { echo "generate-vapid: generation failed" >&2; exit 1; }

# All three or none (the boot guard's contract).
store_put "${env_name}/WEB_PUSH_VAPID_PUBLIC_KEY" "$public_key"
store_put "${env_name}/WEB_PUSH_VAPID_PRIVATE_KEY" "$private_key"
store_put "${env_name}/WEB_PUSH_VAPID_SUBJECT" "$subject"

echo "generate-vapid: stored ${env_name}/WEB_PUSH_VAPID_{PUBLIC_KEY,PRIVATE_KEY,SUBJECT}"
echo "public key (client-safe by design): ${public_key}"
