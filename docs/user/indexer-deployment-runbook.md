# nvHASH Indexer Deployment Runbook

Operational guide for deploying and promoting `services/indexer`.

**Status:** DRAFT 2026-08-17 (created with the 8.4 indexer leg). Topology and
rationale: [ADR-003](../architecture/2026-08-17-adr-003-deployment-topology.md).
Service conventions: [`services/indexer/CLAUDE.md`](../../services/indexer/CLAUDE.md).

## What is deployed

One Deployment, one replica, no Service. The indexer serves no HTTP, holds no
keys and signs nothing — nothing routes to it and nothing should be able to
reach it. A Pod contains three containers:

| Container | Kind | Role |
| --- | --- | --- |
| `cloud-sql-proxy` | native sidecar | Cloud SQL connection with `--auto-iam-authn`; starts first and stays running |
| `migrate` | init | `prisma migrate deploy`, on the app container's own image digest |
| `nvhash-indexer` | app | the worker supervisor |

## Before the first deploy

None of these are deliverable from this repository, and the deploy does not work
without them.

- [ ] **GCP service account** `nvhash-indexer@<project>.iam.gserviceaccount.com`
      with `roles/cloudsql.client` and `roles/cloudsql.instanceUser`,
      Workload-Identity-bound to the `nvhash-indexer` KSA in the target namespace.
- [ ] **Cloud SQL**: an `nvhash` database and the IAM user
      `nvhash-indexer@<project>.iam`.
- [ ] **Role bootstrap applied**: `infra/cloudsql/roles.sql`, project substituted.
      See [its README](../../infra/cloudsql/README.md) — the
      `ALTER ROLE … SET role` line is the one that is easy to skip and fails
      silently.
- [ ] **ArgoCD Application** `nvhash-indexer`, `spec.source.path:
      services/indexer/argocd`, `valueFiles: [values-test.yaml,
      values-gha-test.yaml]`. The filename **must** contain `gha` — the shared
      workflow locates it with `select(contains("gha"))` and fails otherwise.

      **Do not create the prod Application until its values are fillable.** The
      chart ships fail-closed placeholders, so an Application created early sits
      permanently Degraded in `CrashLoopBackOff` — real alert noise for no
      benefit. Fail-closed is preserved either way; not creating it yet is
      simply quieter.
- [ ] **Org secrets visible to this repository**: `ARGOCD_API_KEY`,
      `ARGOCD_API_KEY_PROD`, `ARGOCD_IMAGE_UPDATER_APP_ID`,
      `ARGOCD_IMAGE_UPDATER_PRIVATE_KEY`.
- [ ] **The ARGOCD image-updater GitHub App installed on this repository**, with
      contents and pull-request write. It opens the image-bump PR.
- [ ] **An archive node reachable from the namespace.** Required, not preferred:
      the epoch-history, validator-sampler and governance streams read
      height-pinned state via `x-cosmos-block-height`, which a pruning node
      cannot serve.

### One blocker that is not infrastructure

**Do not sync to an environment whose database must survive** until the
migration-mode change lands. The `indexed` schema is currently one *regenerated*
baseline migration, and a regenerated baseline cannot be applied to a populated
database — the first schema change after the first deploy fails the `migrate`
initContainer and the Pod will not start. A first sync against an **empty**
database is safe. See `services/indexer/CLAUDE.md`.

## Setting the start height

The chart ships `chain.startHeight: 0` and `chain.govStartHeight: 0`, which the
process **rejects**. That is deliberate.

- `0` is out of bounds, so the Pod fails closed and says so.
- `1` is *valid* and starts a replay of the entire chain in 500-height windows.
  On a live network that never converges.

Set both to the **contract's instantiate height**. Blocks before it hold no
program events, and the epoch-history and validator-sampler streams anchor to
`run_epoch` cranks that cannot precede it.

Find it from the instantiate transaction:

```
provenanced query tx --type=hash <instantiate-tx-hash> --output json \
  | jq -r '.height'
```

Then edit `services/indexer/argocd/values-<env>.yaml`. It is a values-only
change: no rebuild, and the ConfigMap checksum annotation restarts the Pod so the
new value takes effect.

Set `contract.address`, `contract.vaultAddress` and `contract.receiptDenom` in
the same edit — the process rejects blanks, so the Pod stays down until all of
them are present.

> **Note:** the read endpoints other than governance do not yet report the height
> their history begins at, so a non-1 start height means those pages present a
> partial window without saying so. That is recorded as CO-54 in the milestone
> overview and should be dispositioned before setting a real start height.

## Deploying to test

1. Merge to `main`. Any change under `services/indexer/**` except `argocd/**`
   triggers `indexer · build and deploy (test)`.
2. The workflow builds, pushes to
   `us-central1-docker.pkg.dev/provlabs-test/docker/nvhash-indexer`, and opens a
   PR bumping `values-gha-test.yaml` with the tag and digest.
3. **A human merges that PR** (`auto-merge: false`).
4. ArgoCD syncs the chart.

To force a build without a qualifying change, dispatch the workflow manually.

A chart-only change (anything under `services/indexer/argocd/`) deliberately does
**not** rebuild the image — ArgoCD reads the chart from git directly.

## Promoting to prod

Promotion is a decision, never a consequence of a merge.

1. Note the test tag you want, in `git-<sha>` form (visible in
   `values-gha-test.yaml`).
2. From `main`, dispatch `indexer · promote and deploy (prod)` with that tag.
3. The workflow re-tags the **existing** image into the prod registry — no
   rebuild, so the artifact running in prod is the digest that ran in test — and
   opens the `values-gha-prod.yaml` bump PR.
4. Merge it; ArgoCD syncs.

## Verifying a deploy

```
kubectl -n <ns> get pods -l app.kubernetes.io/name=nvhash-indexer
kubectl -n <ns> logs <pod> -c migrate
kubectl -n <ns> logs <pod> -c nvhash-indexer
```

In order:

1. **`migrate` completed.** "All migrations have been successfully applied" or
   "No pending migrations". A failure here blocks the app container by design.
2. **The supervisor logged `indexer started`** with a worker `count`. Reaching
   that line means the database is connected and the per-`(chain_id, contract)`
   isolation check passed.
3. **The liveness probe is passing.** It execs the heartbeat check, which only
   succeeds if the supervisor has written a heartbeat within 45 s — so a passing
   probe proves the process *and* its database connection.
4. **Checkpoints are advancing.** `window committed` log lines, with
   `indexedHeight` climbing toward `chainHeight`.

### The alarm cannot report its own absence

The reconciler is the honesty alarm and the sole source of `indexer_lag` and
divergence incidents — and it runs **inside this supervisor process**. When the
pod is down, no incident is written, so indexer downtime is invisible to the
system's own alerting rather than reported by it.

**External alerting on pod availability is therefore required**, not optional:
alert on the Deployment having zero available replicas (Datadog). With
`replicas: 1` and no PodDisruptionBudget, every node drain produces a gap.

### Common failure modes

`config.ts` validates in declaration order and throws on the first problem, so
these surface **one at a time** — with nothing configured you will see the
`CONTRACT_ADDRESS` error first and the start-height error only after you fix it.
Set the whole identity block and both heights in a single edit.

| Symptom | Cause |
| --- | --- |
| `Missing required environment variable: CONTRACT_ADDRESS` | contract identity not yet set in values — expected before bootstrap |
| `Invalid INDEX_START_HEIGHT: expected an integer >= 1` | `startHeight` still `0`; set it to the instantiate height |
| Boot aborts on chain isolation | the database holds history from a different chain or contract than the values name; this is a misconfiguration, not a resume |
| `worker crashed … fetch failed` | the RPC/LCD endpoint is unreachable from the namespace |
| Height-pinned reads fail | the node is not an archive |
| Pod fails immediately after a schema change | the baseline-migration blocker above |

## Rollback

Dispatch the promote workflow with an earlier `git-<sha>` tag, or revert the
`values-gha-*.yaml` bump.

**No data restore is needed.** Indexed data is rebuildable from chain by
definition, so the recovery path for corrupt or suspect indexed state is to reset
the checkpoints (or the database) and let the workers re-derive it. That is why
this service can be rolled back freely while a stateful service could not.
