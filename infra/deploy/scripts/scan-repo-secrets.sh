#!/usr/bin/env bash
# repo-secret-scan (plan 8.4 §4 invariant 2; the overview §7 conformance
# row's named check): no NON-PLACEHOLDER secret may exist in any tracked
# file. The repo is audit-shared and heading public — a committed key is
# burned forever (git history), and on a public testnet it is spendable by
# anyone who reads it.
#
# What counts as a finding:
#   * a PEM private-key block anywhere;
#   * an assignment to a credential-named variable (KEY/SECRET/TOKEN/
#     PASSWORD/MNEMONIC/CREDENTIAL) whose value is long enough to be real
#     and does not match the placeholder allowlist below.
#
# The PLACEHOLDER ALLOWLIST is the point (8.1 §7.1 Q6's forward obligation):
# deliberately fake values must PASS — otherwise CI fails on a fake, and the
# team relaxes the scan until it stops catching real keys. Placeholder-shaped
# means any of:
#   * contains a placeholder word: placeholder|not-a-secret|example|
#     change-?me|replace|sentinel|throwaway|test|golden|0123456789 (the dev
#     stack's committed assertion key is
#     "nvhash-dev-placeholder-assertion-key-not-a-secret-0000" and MUST pass;
#     the unit suites' "…-test-assertion-key-0123456789…" constants likewise);
#   * a shell/template substitution (${...}, $(...), <...>);
#   * a single repeated character (the e2e harness's throwaway "1111…" keys);
#   * a short dev-compose literal (< 16 chars, e.g. "indexer-dev").
#
# STATED LIMIT: this is a vocabulary classifier, not entropy analysis — a
# real key deliberately named to carry an allowlisted word would evade it.
# The countermeasure is the review rule it encodes: values in the repo are
# placeholders BY NAMING CONVENTION, and anything real goes to the store.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

fail=0

# 1. PEM private keys — never allowed, placeholder or not.
if git grep -nE -- "-----BEGIN [A-Z ]*PRIVATE KEY-----" -- ':!infra/deploy/scripts/scan-repo-secrets.sh' >/dev/null 2>&1; then
  echo "repo-secret-scan: PEM private-key block found:" >&2
  git grep -nE -- "-----BEGIN [A-Z ]*PRIVATE KEY-----" -- ':!infra/deploy/scripts/scan-repo-secrets.sh' >&2
  fail=1
fi

# 2. Credential-named assignments with realistic values.
#    Matches KEY=..., SECRET: "...", etc. in tracked text files.
pattern='(KEY|SECRET|TOKEN|PASSWORD|MNEMONIC|CREDENTIAL)[A-Z0-9_]*["'"'"']?[[:space:]]*[:=][[:space:]]*["'"'"']?[A-Za-z0-9+/=_-]{16,}'

is_placeholder() {
  local value="$1"
  local lower
  # tr, not ${value,,}: macOS ships bash 3.2 and the scan must run there too
  lower="$(tr '[:upper:]' '[:lower:]' <<<"$value")"
  # explicit placeholder vocabulary (case-insensitive)
  if [[ "$lower" =~ (placeholder|not-a-secret|example|change-?me|replace|sentinel|throwaway|test|golden|0123456789) ]]; then
    return 0
  fi
  # substitution forms
  if [[ "$value" == *'${'* || "$value" == *'$('* || "$value" == *'<'* ]]; then
    return 0
  fi
  # a single repeated character (throwaway harness keys)
  local first="${value:0:1}"
  local stripped="${value//"$first"/}"
  if [[ -z "$stripped" ]]; then
    return 0
  fi
  return 1
}

while IFS= read -r hit; do
  file="${hit%%:*}"
  rest="${hit#*:}"
  line="${rest%%:*}"
  content="${rest#*:}"
  # Extract the value token after the assignment.
  value="$(sed -E 's/.*(KEY|SECRET|TOKEN|PASSWORD|MNEMONIC|CREDENTIAL)[A-Z0-9_]*["'"'"']?[[:space:]]*[:=][[:space:]]*["'"'"']?([A-Za-z0-9+/=_-]{16,}).*/\2/' <<<"$content")"
  if ! is_placeholder "$value"; then
    echo "repo-secret-scan: credential-shaped value at ${file}:${line}: ${content}" >&2
    fail=1
  fi
done < <(git grep -nE -- "$pattern" \
  -- ':!*.lock' ':!pnpm-lock.yaml' ':!*.svg' ':!*.json' \
  ':!infra/deploy/scripts/scan-repo-secrets.sh' 2>/dev/null || true)

if [[ "$fail" -ne 0 ]]; then
  echo "repo-secret-scan: FAILED — real credentials belong ONLY in the secret store (SECURITY.md; D24)" >&2
  exit 1
fi
echo "repo-secret-scan: clean"
