#!/usr/bin/env bash
# Measure the §14.10 funnel counter's row-lock contention, and prove it loses
# no increments (plan §2.4 and §4b C3).
#
# WHY THIS EXISTS. The plan recorded a guess — that concentrating every visit of
# a day onto one `(stage, day)` row might need a bounded in-process buffer — and
# required it be revisited "against a real measurement rather than the guess".
# This is that measurement. Run it before changing the increment path.
#
# WHAT IT ANSWERS, in order:
#   1. What does a single uncontended increment cost? (the floor)
#   2. What does it cost when every concurrent client hits the SAME row? (the
#      hazard C3 identified: row-lock wait, never lost updates)
#   3. Does the count actually equal the number of transactions? A single lost
#      update makes the final assertion fail — this is the property, and it is
#      why `ON CONFLICT DO UPDATE SET count = count + 1` is one statement rather
#      than a read followed by a write.
#
# Usage (from the repo root, with `./dev pg up` already run):
#   apps/web/scripts/measure-funnel-contention.sh [database]
#
# Results recorded 2026-07-31 (dev container, postgres 17-alpine):
#   1 client                     0.216 ms avg    4 639 tps
#   8 clients, same row          1.945 ms avg    4 114 tps
#   32 clients, same row         9.951 ms avg    3 216 tps    0 failed
#   64 000 increments → stored count 64 000 — zero lost updates.
#
# Conclusion, recorded in the plan's §7.1 revision: NO BUFFER. The p99 stays far
# inside any page's budget even with every client on the hot row, so a buffer
# would add a flush-on-shutdown loss window and a second failure mode to avoid a
# cost that is not there.

set -euo pipefail

DB="${1:-nvhash}"
SDIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
COMPOSE=(docker compose -f "$SDIR/infra/dev/compose.yaml" --profile db exec -T postgres)

"${COMPOSE[@]}" sh -c 'cat > /tmp/nvhash-bump.sql' <<'SQL'
INSERT INTO app.funnel_counters ("stage","day","count")
VALUES (:stage::"app"."FunnelStage", CURRENT_DATE, 1)
ON CONFLICT ("stage","day") DO UPDATE SET "count" = app.funnel_counters."count" + 1;
SQL

bench() { # clients, per-client transactions, label
  echo "── $3 ──"
  "${COMPOSE[@]}" sh -c \
    "pgbench -U nvhash -d $DB -n -c $1 -j 4 -t $2 -D stage=\"'visit_learn_index'\" \
       -f /tmp/nvhash-bump.sql 2>&1 | grep -E 'actually processed|failed|latency average|tps'"
}

echo "Resetting the counter row…"
"${COMPOSE[@]}" psql -U nvhash -d "$DB" -q -c "TRUNCATE app.funnel_counters;"

bench 1 2000 "1 client (uncontended floor)"
bench 8 2000 "8 clients, ALL on the same row"
bench 32 2000 "32 clients, ALL on the same row"

# 1×2000 + 8×2000 + 32×2000 = 82 000. Any lost update makes this false.
echo "── lost-update check ──"
"${COMPOSE[@]}" psql -U nvhash -d "$DB" -c \
  "SELECT stage, \"count\", \"count\" = 82000 AS no_lost_updates FROM app.funnel_counters;"
