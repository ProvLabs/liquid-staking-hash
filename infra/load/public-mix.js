// T1: the 10 public routes + /health under a weighted sustained mix with a
// ramp → sustain → burst shape (8.2 §2.3/§2.4). Runs with a RAISED test
// RATE_LIMIT_MAX — latency numbers must be about the read path, not the
// limiter (the rate-limit scenario measures the limiter, separately).

import { check } from "k6";
import http from "k6/http";
import { API, tagged } from "./lib.js";

export const options = {
  scenarios: {
    public_mix: {
      executor: "ramping-arrival-rate",
      startRate: 5,
      timeUnit: "1s",
      preAllocatedVUs: 30,
      maxVUs: 120,
      stages: [
        { target: 50, duration: __ENV.RAMP || "30s" },
        { target: 50, duration: __ENV.SUSTAIN || "2m" },
        { target: 100, duration: __ENV.BURST || "30s" },
      ],
    },
  },
  thresholds: {
    // T1: p95 ≤ 250 ms at 50 rps sustained; non-429 error rate 0.
    "http_req_duration{scenario:public_mix}": ["p(95)<250"],
    checks: ["rate==1"],
  },
};

// Weighted mix: the heavy governance/validator reads appear less often than
// the chrome's per-request status/incidents pair, the way the web tier fires
// them.
const MIX = [
  ["/status", 4],
  ["/incidents", 4],
  ["/metrics", 2],
  ["/epochs?limit=50", 2],
  ["/validators", 2],
  ["/market", 2],
  ["/redemptions/stats", 1],
  ["/governance/proposals", 1],
  ["/governance/proposal?id=1", 1],
  ["/governance/policies", 1],
  ["/health", 1],
];
const WEIGHTED = MIX.flatMap(([path, weight]) => Array(weight).fill(path));

export default function () {
  const path = WEIGHTED[Math.floor(Math.random() * WEIGHTED.length)];
  const res = http.get(`${API}${path}`, tagged(path.split("?")[0]));
  check(res, { "status 200": (r) => r.status === 200 });
}
