// T3 — CO-20's instrument (8.2 §2.3/§2.4): a dashboard load = all five admin
// panels in parallel, the way apps/web fires them. The holder-cohorts fold is
// the measured superlinear read; its p95 here, at depth2, is what decides the
// CONTINGENT commit D (criteria stated in advance, §2.4 — ratified §7.1).

import { check } from "k6";
import http from "k6/http";
import { API, scoped, tagged, vuAddress } from "./lib.js";

export const options = {
  scenarios: {
    admin: {
      executor: "constant-vus",
      vus: Number(__ENV.ADMIN_VUS || 3),
      duration: __ENV.SUSTAIN || "2m",
      exec: "dashboard",
    },
    // T3(b)'s other half: sustained public traffic DURING the dashboard
    // loads. Its p95 here is compared against the public-mix baseline run in
    // the measurement pass — degradation ≥ 50 % is a breach (the fold's cost
    // exported to the public).
    public_during_admin: {
      executor: "constant-arrival-rate",
      rate: 50,
      timeUnit: "1s",
      preAllocatedVUs: 30,
      maxVUs: 120,
      duration: __ENV.SUSTAIN || "2m",
      exec: "publicRead",
    },
  },
  thresholds: {
    // T3(a): the fold's own cost.
    "http_req_duration{endpoint:/admin/holder-cohorts}": ["p(95)<2500"],
    checks: ["rate==1"],
  },
};

const PANELS = [
  "/admin/program-health",
  "/admin/holder-cohorts",
  "/admin/validator-cohorts",
  "/admin/upkeep",
  "/admin/incidents?limit=50",
];

export function dashboard() {
  // One dashboard load: all five in parallel (http.batch), per-panel tags.
  // The admin scope matches on KIND; the address half is a synthetic bech32.
  const scope = `admin:${vuAddress(999)}`;
  const requests = PANELS.map((path) => {
    const tagPath = path.split("?")[0];
    return { method: "GET", url: `${API}${path}`, params: scoped(scope, tagPath) };
  });
  const responses = http.batch(requests);
  for (const res of responses) {
    check(res, { "status 200": (r) => r.status === 200 });
  }
}

export function publicRead() {
  const res = http.get(`${API}/status`, tagged("/status"));
  check(res, { "status 200": (r) => r.status === 200 });
}
