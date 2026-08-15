// T6: the deep-OFFSET sweep (8.2 §2.3) at MAX_PAGE_LIMIT over the recorded
// accepted-linear decision's own re-open terms: {0, 10 k, 100 k,
// MAX_PAGE_OFFSET = 1 000 000} — re-measure, never "fix" (no per-route
// MAX_PAGE_OFFSET lowering; api-design-notes).

import { check } from "k6";
import http from "k6/http";
import { API, HEAVY_ADDRESS, HEAVY_VALOPER, scoped } from "./lib.js";

const OPERATOR = __ENV.HEAVY_OPERATOR || "";
const OFFSETS = [0, 10_000, 100_000, 1_000_000];

export const options = {
  scenarios: {
    deep_offset: {
      executor: "per-vu-iterations",
      vus: 1,
      iterations: Number(__ENV.OFFSET_ITERATIONS || 5),
      maxDuration: "10m",
    },
  },
  thresholds: {
    // T6: worst case ≤ 2 s (growth-vs-linear judged from the per-offset tags
    // in the measurement pass).
    "http_req_duration{scenario:deep_offset}": ["p(95)<2000"],
    checks: ["rate==1"],
  },
};

export default function () {
  for (const offset of OFFSETS) {
    const tx = http.get(`${API}/transactions?address=${HEAVY_ADDRESS}&limit=200&offset=${offset}`, {
      ...scoped(`address:${HEAVY_ADDRESS}`, "/transactions"),
      tags: { endpoint: "/transactions", offset: String(offset) },
    });
    check(tx, { "tx page 200": (r) => r.status === 200 });

    const pay = http.get(
      `${API}/operator/payments?address=${OPERATOR}&valoper=${HEAVY_VALOPER}&limit=200&offset=${offset}`,
      {
        ...scoped(`address:${OPERATOR}`, "/operator/payments"),
        tags: { endpoint: "/operator/payments", offset: String(offset) },
      },
    );
    check(pay, { "payments page 200": (r) => r.status === 200 });
  }
}
