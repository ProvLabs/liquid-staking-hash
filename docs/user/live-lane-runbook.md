# Live-lane runbook — dispatching the lanes and reading a red drill

Operator instructions for the two live lanes in
`.github/workflows/live-lane.yaml` (PR 8.1). Until PR 8.0 pins a released
vault module, both lanes run by `workflow_dispatch` only (Actions → live-lane
→ Run workflow); the PR that lands the release pin turns the crons on.

## What each lane runs

- **live-stack** (weekly once scheduled): boots a fresh devnet, brings up the
  full app stack, provisions throwaway keys, runs the complete e2e-live suite
  (governance write leg included), the degradation-drill sequence
  (`infra/devnet/drills.sh run`), and the indexer's live-transport governance
  suite.
- **jail-lane** (monthly once scheduled): boots a **dedicated** chain with the
  default slash window, runs `contracts/drills/jail-drill.sh` with the
  app-observation hook, and destroys the chain afterwards. It is the only
  place a real jailed validator is ever rendered.

The two lanes never run concurrently (one concurrency group): they must not
share a chain.

## Reading a red drill

A red drill is a **finding about the honesty machinery**, never a flake to
retry, and never a reason to widen a tolerance, threshold, or wait.

| Failing phase | What it means |
| --- | --- |
| `baseline` | A degraded state is ambient on a healthy stack — something upstream of the drills is already lying, or the stack never converged. Fix the stack first; the later phases are meaningless until baseline is green. |
| `corrupt-row` | The alarm chain is broken somewhere between the reconciler loop, the `incidents` table, `/api/v1/incidents`, and the chrome — a corrupted mirror is being presented as authoritative. |
| `repair` | The incident did not close after the row was fixed: the close half of the alarm is stuck, and the banner would cry wolf forever. |
| `indexer-kill` | A dead indexer renders as healthy: the `/status.reconciled_at` exposure or the chrome's stale-heads clause regressed — the exact "frozen heights under a fresh response clock" lie 8.1 §2.2 closed. |
| `indexer-recover` | The banner did not clear after restart — check the indexer resumed from its cursor and a reconciler pass landed. |
| `lcd-kill` | The chrome fabricated program health with the chain unreachable ("status unavailable" absent, or a paused/halted banner with no live read behind it). |
| `lcd-recover` | The stack did not return to healthy **unattended**: the compose `restart:` policy or the reconciler's per-pass tolerance regressed — one LCD blip would permanently silence ingestion and the alarm. |
| `bell` | The drill → notifier tick → bell chain broke: the notifier service is down, missing its key, or the web tier is on the in-memory store. |
| `stale-bundle` (first spec of any prepared run) | The run was about to certify a bundle that is not the code under test. Run through `stack.sh e2e`; never bypass the entry. |
| jail spec | The jail incident lifecycle or the jailed-validator rendering regressed — this is the only live coverage either has. |

A phase that reports **zero executed tests** also fails the driver: a drill
that skips is silence, and silence is the failure mode the drills exist to
catch.

## Local iteration

```bash
infra/devnet/stack.sh up                 # the full stack
eval "$(infra/devnet/actions/e2e-keys.sh)"
infra/devnet/drills.sh run               # or one phase, e.g. drills.sh corrupt-row
```

Every script refuses chains outside the chain-dev family; drill keys are
throwaway devnet material (SECURITY.md).
