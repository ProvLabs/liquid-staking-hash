// Pure composition + route-boundary bounding for the governance center
//. The degradation matrix lives in `governance-data.test.ts`; what
// is here is the arithmetic and the parsing that matrix rests on, tested
// directly so a failure names the cause rather than a symptom two layers up.

import { describe, expect, it } from "vitest";

import { formatDuration, formatInstant, shortAddress } from "~/governance/format";
import { secondsUntil, toWireStatus, toWireVoteOption } from "~/governance/governance.server";
import { parseProposalIdParam, parseStatusParam } from "~/governance/params";
import { EXECUTOR_KEYS, STATUS_KEYS, VOTE_OPTION_KEYS } from "~/governance/labels";
import en from "~/i18n/locales/en";

const locale = "en" as const;

describe("route boundaries reject rather than clamp (SECURITY.md)", () => {
  it("accepts a canonical u64 proposal id and nothing else", () => {
    for (const good of ["0", "7", "18446744073709551615"]) {
      expect(parseProposalIdParam(good)).toBe(good);
    }
    for (const bad of [
      undefined,
      "",
      "-1",
      "1.0",
      "01", // two spellings of one proposal is one proposal too many
      "1e3",
      " 7",
      "7 ",
      "0x7",
      "١٢٣", // non-ASCII digits
      "1".repeat(21), // past uint64's decimal width
    ]) {
      // A 400 Response, not a coerced value: an id that cannot be bounded
      // safely is an error, never a best-effort continue.
      expect(() => parseProposalIdParam(bad as string | undefined), String(bad)).toThrow();
    }
  });

  it("accepts only the closed status union, and treats absence as `all`", () => {
    expect(parseStatusParam(null)).toBeNull();
    expect(parseStatusParam("")).toBeNull();
    expect(parseStatusParam("accepted")).toBe("accepted");
    for (const bad of ["ACCEPTED", "open", "accepted;drop", "unspecified "]) {
      expect(() => parseStatusParam(bad), bad).toThrow();
    }
  });

  it("the id parser and the API's own `id` schema accept the same language", () => {
    // Both bound to uint64's 20-digit decimal width with no leading zeros. If
    // they diverged, this tier would forward an id the API 400s, and an upstream
    // 400 is indistinguishable from a deliberate rejection (M6.4's VALOPER_PATHS
    // lesson).
    const apiShape = /^(0|[1-9][0-9]*)$/;
    for (const value of ["0", "9", "18446744073709551615"]) {
      expect(apiShape.test(value) && value.length <= 20).toBe(true);
      expect(parseProposalIdParam(value)).toBe(value);
    }
  });
});

describe("chain enums map onto the wire union, with `unspecified` as the landing place", () => {
  it("maps every status and vote option the client can produce", () => {
    expect(toWireStatus("SUBMITTED")).toBe("submitted");
    expect(toWireStatus("ACCEPTED")).toBe("accepted");
    expect(toWireStatus("REJECTED")).toBe("rejected");
    expect(toWireStatus("ABORTED")).toBe("aborted");
    expect(toWireStatus("WITHDRAWN")).toBe("withdrawn");
    expect(toWireVoteOption("NO_WITH_VETO")).toBe("no_with_veto");
  });

  it("an enum member a later chain upgrade adds lands on `unspecified`, not a throw", () => {
    expect(toWireStatus("PROPOSAL_STATUS_TIMELOCKED")).toBe("unspecified");
    expect(toWireVoteOption("VOTE_OPTION_MAYBE")).toBe("unspecified");
  });

  it("every label map is total over its union and resolves to real copy", () => {
    for (const key of [
      ...Object.values(STATUS_KEYS),
      ...Object.values(EXECUTOR_KEYS),
      ...Object.values(VOTE_OPTION_KEYS),
    ]) {
      expect(Object.keys(en), key).toContain(key);
    }
  });
});

describe("the countdown is a hint, and never outlives its deadline", () => {
  const end = "2026-07-30T01:00:00.000Z";

  it("counts down in whole seconds against the supplied clock", () => {
    expect(secondsUntil(end, Date.parse("2026-07-30T00:00:00.000Z"))).toBe(3600);
    // Under a second left is null, not "0 seconds": rendering a zero countdown
    // beside a deadline that has not passed reads as expired when it is not.
    expect(secondsUntil(end, Date.parse("2026-07-30T00:59:59.500Z"))).toBeNull();
  });

  it("is null once elapsed — never a negative duration", () => {
    expect(secondsUntil(end, Date.parse("2026-07-30T01:00:00.000Z"))).toBeNull();
    expect(secondsUntil(end, Date.parse("2026-07-30T02:00:00.000Z"))).toBeNull();
  });

  it("is null for an unparseable instant rather than NaN reaching the page", () => {
    expect(secondsUntil("not a date", Date.now())).toBeNull();
  });

  it("renders coarsely, because it is approximate by construction", () => {
    expect(formatDuration(locale, 5)).toBe("5 seconds");
    expect(formatDuration(locale, 1)).toBe("1 second");
    expect(formatDuration(locale, 90)).toBe("1 minute");
    expect(formatDuration(locale, 3 * 3600 + 61)).toBe("3 hours");
    expect(formatDuration(locale, 50 * 3600)).toBe("2 days");
    expect(formatDuration(locale, 25 * 3600)).toBe("1 day");
  });
});

describe("instant formatting is deterministic on both sides of hydration", () => {
  it("renders UTC explicitly, identically wherever it runs", () => {
    // A governance deadline read in the wrong zone is a missed vote, so the zone
    // is on the page rather than assumed — and the format cannot depend on the
    // renderer's locale or timezone, or SSR and the browser would disagree.
    expect(formatInstant("2026-07-29T23:27:10.340382605Z")).toBe("2026-07-29 23:27 UTC");
    expect(formatInstant("2026-07-29T23:27:10Z")).toBe(formatInstant("2026-07-29T16:27:10-07:00"));
  });

  it("returns null for an unparseable instant instead of `Invalid Date`", () => {
    expect(formatInstant("")).toBeNull();
    expect(formatInstant("soon")).toBeNull();
  });

  it("shortens an address for display but never loses it", () => {
    const address = "tp1dlszg2sst9r69my4f84l3mj66zxcf3umcgujys30t84srg95dgvst74vwc";
    const short = shortAddress(address);
    expect(short.length).toBeLessThan(address.length);
    // Both ends survive, so a reader can still tell two policies apart; the full
    // value is always the element's `title`.
    expect(address.startsWith(short.slice(0, 10))).toBe(true);
    expect(address.endsWith(short.slice(-6))).toBe(true);
    expect(shortAddress("tp1short")).toBe("tp1short");
  });
});
