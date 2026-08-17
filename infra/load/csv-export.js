// T4: the two CSV exports at their heavy identities (8.2 §2.3). The k6-side
// threshold is completion + duration; the RSS half of T4 (API memory delta
// ≤ 64 MB during the stream — the streaming property) is sampled by run.sh
// via `docker stats` around this scenario, since k6 cannot see the server's
// memory.

import { check } from "k6";
import http from "k6/http";
import { API, HEAVY_ADDRESS, HEAVY_VALOPER, scoped } from "./lib.js";

const OPERATOR = __ENV.HEAVY_OPERATOR || "";

export const options = {
  scenarios: {
    csv_export: {
      executor: "per-vu-iterations",
      vus: 2,
      iterations: Number(__ENV.CSV_ITERATIONS || 3),
      maxDuration: "10m",
    },
  },
  thresholds: {
    checks: ["rate==1"],
  },
};

export default function () {
  const tx = http.get(
    `${API}/transactions?address=${HEAVY_ADDRESS}&format=csv`,
    scoped(`address:${HEAVY_ADDRESS}`, "/transactions"),
  );
  check(tx, {
    "tx csv 200": (r) => r.status === 200,
    "tx csv is csv": (r) => String(r.headers["Content-Type"] || "").includes("text/csv"),
    "tx csv complete": (r) => typeof r.body === "string" && r.body.length > 0,
  });

  const pay = http.get(
    `${API}/operator/payments?address=${OPERATOR}&valoper=${HEAVY_VALOPER}&format=csv`,
    scoped(`address:${OPERATOR}`, "/operator/payments"),
  );
  check(pay, {
    "payments csv 200": (r) => r.status === 200,
    "payments csv complete": (r) => typeof r.body === "string" && r.body.length > 0,
  });
}
