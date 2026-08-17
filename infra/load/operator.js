// The operator surface (8.2 §2.3), including the seeded heavy valoper — the
// recorded cursor-depth and planner-flip condition (api-design-notes) lives
// here. The operator scope is keyed by the OPERATOR's account address; the
// API resolves address → valoper server-side, so the harness authenticates as
// the heavy valoper's operator (printed by seed:load).

import { check } from "k6";
import http from "k6/http";
import { API, HEAVY_VALOPER as VALOPER, scoped } from "./lib.js";

const OPERATOR = __ENV.HEAVY_OPERATOR || "";

export const options = {
  scenarios: {
    operator: {
      executor: "constant-vus",
      vus: 5,
      duration: __ENV.SUSTAIN || "2m",
    },
  },
  thresholds: {
    "http_req_duration{scenario:operator}": ["p(95)<2500"],
    checks: ["rate==1"],
  },
};

export default function () {
  for (const path of [
    "/operator/summary",
    `/operator/epochs?valoper=${VALOPER}&limit=50`,
    `/operator/payments?valoper=${VALOPER}&limit=200`,
  ]) {
    const tagPath = path.split("?")[0];
    const url = `${API}${path}${path.includes("?") ? "&" : "?"}address=${OPERATOR}`;
    const res = http.get(url, scoped(`address:${OPERATOR}`, tagPath));
    check(res, { "status 200": (r) => r.status === 200 });
  }
}
