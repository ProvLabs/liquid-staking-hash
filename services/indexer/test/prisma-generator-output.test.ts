// Build-correctness gate: every generator in this package's Prisma schema
// declares an explicit `output` resolving outside node_modules, so `apps/web`
// stays the repo's sole writer of the hoisted @prisma/client. Two
// default-output generators race — the last `prisma generate` in a process
// tree wins globally, and a test tier then binds to the wrong schema's
// client. Standing in CI (runs under `pnpm -r test`).

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const prismaDir = resolve(dirname(fileURLToPath(import.meta.url)), "../prisma");

interface GeneratorBlock {
  readonly file: string;
  readonly name: string;
  readonly output: string | null;
}

function parseGenerators(): GeneratorBlock[] {
  const blocks: GeneratorBlock[] = [];
  for (const file of readdirSync(prismaDir).filter((f) => f.endsWith(".prisma"))) {
    const source = readFileSync(join(prismaDir, file), "utf8");
    for (const match of source.matchAll(/generator\s+(\w+)\s*\{([^}]*)\}/g)) {
      const body = match[2] ?? "";
      const output = body.match(/^\s*output\s*=\s*"([^"]+)"/m);
      blocks.push({ file, name: match[1] ?? "", output: output?.[1] ?? null });
    }
  }
  return blocks;
}

const generators = parseGenerators();

describe("prisma generator outputs (sole hoisted-client writer rule)", () => {
  it("parses both generators of the canonical schema", () => {
    // Guards against a parser regression silently passing an empty schema.
    expect(generators.map((g) => g.name).sort()).toEqual(["client", "dbIndexed"]);
  });

  it("every generator declares an explicit output", () => {
    const defaulted = generators.filter((g) => g.output === null).map((g) => `${g.file}#${g.name}`);
    expect(
      defaulted,
      `generators with no output write the hoisted node_modules/@prisma/client and race apps/web's: ${defaulted.join(", ")}`,
    ).toEqual([]);
  });

  it("every output resolves outside node_modules", () => {
    const violations: string[] = [];
    for (const g of generators) {
      if (g.output === null) continue;
      const resolved = resolve(prismaDir, g.output);
      if (resolved.split(sep).includes("node_modules")) {
        violations.push(`${g.file}#${g.name} → ${resolved}`);
      }
    }
    expect(violations).toEqual([]);
  });
});
