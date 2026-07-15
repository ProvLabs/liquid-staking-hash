// Unit: the logger only ever serializes allowlisted safe fields, and bigints
// render as decimal strings (amount discipline extends to log output too).

import { afterEach, describe, expect, it, vi } from "vitest";
import { logger } from "../src/logger.ts";

function capture(stream: "stdout" | "stderr", fn: () => void): string[] {
  const written: string[] = [];
  const spy = vi.spyOn(process[stream], "write").mockImplementation((chunk: unknown) => {
    written.push(String(chunk));
    return true;
  });
  try {
    fn();
  } finally {
    spy.mockRestore();
  }
  return written;
}

afterEach(() => vi.restoreAllMocks());

describe("logger", () => {
  it("emits allowlisted fields as JSON on stdout", () => {
    const [line] = capture("stdout", () => logger.info("ingested", { address: "tp1abc", height: 42n }));
    const parsed = JSON.parse(line!);
    expect(parsed).toMatchObject({ level: "info", message: "ingested", address: "tp1abc", height: "42" });
  });

  it("drops keys that are not on the safe-field allowlist", () => {
    // A caller bypassing the type with a forbidden key must not leak it.
    const [line] = capture("stdout", () =>
      // @ts-expect-error — deliberately passing a non-safe key to prove it is dropped
      logger.info("tx", { address: "tp1abc", ip: "203.0.113.7" }),
    );
    const parsed = JSON.parse(line!);
    expect(parsed.address).toBe("tp1abc");
    expect(parsed).not.toHaveProperty("ip");
  });

  it("routes error to stderr, not stdout", () => {
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const errLines = capture("stderr", () => logger.error("boom", { error: "nope" }));
    expect(stdoutSpy).not.toHaveBeenCalled();
    expect(JSON.parse(errLines[0]!)).toMatchObject({ level: "error", message: "boom", error: "nope" });
  });
});
