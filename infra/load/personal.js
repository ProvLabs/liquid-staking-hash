// T2: the address-scoped personal surface (8.2 §2.3) — per-VU distinct
// synthetic addresses plus the seeded HEAVY address (the /portfolio/metrics
// full-history fold's worst case, measured separately by tag).

import { check } from "k6";
import http from "k6/http";
import { API, HEAVY_ADDRESS, scoped, vuAddress } from "./lib.js";

export const options = {
  scenarios: {
    personal: {
      executor: "constant-vus",
      vus: 10,
      duration: __ENV.SUSTAIN || "2m",
    },
  },
  thresholds: {
    // T2: typical ≤ 400 ms / heavy ≤ 2.5 s at p95.
    "http_req_duration{endpoint:/portfolio/metrics,weight:typical}": ["p(95)<400"],
    "http_req_duration{endpoint:/portfolio/metrics,weight:heavy}": ["p(95)<2500"],
    checks: ["rate==1"],
  },
};

export default function () {
  // Every 5th iteration hits the heavy address; the rest use the VU's own
  // synthetic address (honest-empty smalls — the auth + read path, cheap).
  const heavy = __ITER % 5 === 0 && HEAVY_ADDRESS !== "";
  const address = heavy ? HEAVY_ADDRESS : vuAddress(__VU);
  const weight = heavy ? "heavy" : "typical";
  for (const path of ["/portfolio", "/portfolio/metrics", "/transactions?limit=50"]) {
    const tagPath = path.split("?")[0];
    const params = scoped(`address:${address}`, tagPath);
    params.tags.weight = weight;
    const url = `${API}${path}${path.includes("?") ? "&" : "?"}address=${address}`;
    const res = http.get(url, params);
    check(res, { "status 200": (r) => r.status === 200 });
  }
}
