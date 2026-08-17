// The internal:notifier surface (all 25 registry routes are covered — §2.3's
// "every auth surface"): the three alert-facts reads at the notifier's own
// page size, plus the 401 posture on a bad assertion (invariant 8).

import { check } from "k6";
import http from "k6/http";
import { API, scoped } from "./lib.js";

export const options = {
  scenarios: {
    internal: {
      executor: "constant-vus",
      vus: 2,
      duration: __ENV.SUSTAIN || "1m",
    },
  },
  thresholds: {
    "http_req_duration{scenario:internal}": ["p(95)<500"],
    checks: ["rate==1"],
  },
};

const FACTS = [
  "/internal/alert-facts/redemptions?since_height=0&limit=200",
  "/internal/alert-facts/incidents?since_id=0&limit=200",
  "/internal/alert-facts/arrears",
];

export default function () {
  for (const path of FACTS) {
    const tagPath = path.split("?")[0];
    const res = http.get(`${API}${path}`, scoped("internal:notifier", tagPath));
    check(res, { "status 200": (r) => r.status === 200 });
  }
  // A bad assertion stays a bare 401 (never a differentiated error).
  const bad = http.get(`${API}/internal/alert-facts/arrears`, {
    headers: { Authorization: "Bearer bogus.bogus" },
    tags: { endpoint: "/internal/alert-facts/arrears", weight: "bad-assertion" },
  });
  check(bad, { "bad assertion 401": (r) => r.status === 401 });
}
