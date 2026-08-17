// T5: limiter correctness at PRODUCTION-DEFAULT limits (8.2 §2.3/§2.4) —
// this scenario runs against RATE_LIMIT_MAX=120 / 60 s, never the raised
// latency profile: ceiling exactness, 429 + Retry-After ≤ window, full
// recovery after the window reset, and the anti-scan property (unknown paths
// consume budget — 429 precedes 404 in the pinned pipeline).

import { check, sleep } from "k6";
import http from "k6/http";
import * as lib from "./lib.js";

const MAX = Number(__ENV.RATE_LIMIT_MAX || 120);
const WINDOW_S = Number(__ENV.RATE_LIMIT_WINDOW_MS || 60_000) / 1000;

export const options = {
  scenarios: {
    rate_limit: {
      executor: "per-vu-iterations",
      vus: 1, // ONE client key — the ceiling is per key, and this measures it
      iterations: 1,
      maxDuration: "10m",
    },
  },
  thresholds: {
    checks: ["rate==1"],
  },
};

export default function () {
  // Fresh window: wait out any budget this process already spent.
  sleep(WINDOW_S + 1);

  // 1. The ceiling is exact: MAX requests pass, request MAX+1 is 429.
  let passed = 0;
  let firstLimited = -1;
  for (let i = 0; i < MAX + 10; i += 1) {
    const res = http.get(`${lib.API}/status`, { tags: { endpoint: "/status" } });
    if (res.status === 200) passed += 1;
    else if (res.status === 429 && firstLimited === -1) {
      firstLimited = i;
      const retryAfter = Number(res.headers["Retry-After"] || "-1");
      check(res, {
        "429 carries Retry-After ≤ window": () => retryAfter >= 0 && retryAfter <= WINDOW_S,
      });
    }
  }
  check(null, {
    "ceiling exact (MAX pass, MAX+1 limited)": () => passed === MAX && firstLimited === MAX,
  });

  // 2. Anti-scan: an unknown path consumes budget too (429 precedes 404).
  const unknown = http.get(`${lib.API}/no-such-path`, { tags: { endpoint: "unknown" } });
  check(unknown, { "unknown path limited, not 404": (r) => r.status === 429 });

  // 3. Full recovery after the window reset.
  sleep(WINDOW_S + 1);
  const after = http.get(`${lib.API}/status`, { tags: { endpoint: "/status" } });
  check(after, { "recovers after window reset": (r) => r.status === 200 });
}
