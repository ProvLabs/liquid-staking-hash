#!/usr/bin/env bash
# PreToolUse hook (Write|Edit): inject a SECURITY.md reminder into the model's
# context whenever it is about to write under a path SECURITY.md governs —
# including docs/specs and docs/plans, which direct code changes and inherit
# the same requirements. Injects context only; never blocks or auto-allows.
set -euo pipefail

f=$(jq -r '.tool_input.file_path // empty')
[ -z "$f" ] && exit 0

case "$f" in
  *contracts/*|*services/*|*apps/*|*docs/specs/*|*docs/plans/*)
    jq -n '{
      suppressOutput: true,
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        additionalContext: "Project hook reminder: SECURITY.md is normative for this path. If you have not read SECURITY.md this session, read it before this change. Contract/service/app code AND any spec or plan in docs/ that directs such code must satisfy its per-component requirements: security controls expressed as enforced mechanisms with CI-gating tests (never caller/topology assumptions); inputs validated and bounded at the boundary; no PII or key material; spec, invariant assertions, and status ledger amended in the same change as the behavior they describe."
      }
    }'
    ;;
esac
exit 0
