// Minimal Prisma schema-folder parser for the security gates. Reads every
// `prisma/*.prisma` model block and extracts field names + column types. It is
// deliberately dependency-free (no Prisma SDK) so the gate has no way to be
// silently disabled by a toolchain change.

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
export const PRISMA_DIR = join(here, "..", "..", "prisma");

export interface PrismaField {
  name: string;
  /** The declared type token, e.g. `Decimal`, `String`, `BigInt`, `Int`. */
  type: string;
  /** The raw attribute text following the type, e.g. `@db.Decimal(39, 0)`. */
  attributes: string;
}

export interface PrismaModel {
  name: string;
  fields: PrismaField[];
}

/** Read and concatenate every `.prisma` file in the schema folder. */
export function readSchemaSource(): string {
  return readdirSync(PRISMA_DIR)
    .filter((f) => f.endsWith(".prisma"))
    .sort()
    .map((f) => readFileSync(join(PRISMA_DIR, f), "utf8"))
    .join("\n");
}

/** Parse all `model` blocks into their scalar/field declarations. */
export function parseModels(source = readSchemaSource()): PrismaModel[] {
  const models: PrismaModel[] = [];
  const modelRe = /model\s+(\w+)\s*\{([^}]*)\}/g;
  let match: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: the canonical `exec` iteration idiom; `match` is explicitly typed and compared to null.
  while ((match = modelRe.exec(source)) !== null) {
    const name = match[1]!;
    const body = match[2]!;
    const fields: PrismaField[] = [];
    for (const rawLine of body.split("\n")) {
      const line = rawLine.trim();
      // Skip blanks, comments, and block-level attributes (@@id/@@map/…).
      if (line === "" || line.startsWith("//") || line.startsWith("@@")) continue;
      const fieldMatch = /^(\w+)\s+([A-Za-z0-9_]+(?:\[\])?\??)\s*(.*)$/.exec(line);
      if (!fieldMatch) continue;
      fields.push({
        name: fieldMatch[1]!,
        type: fieldMatch[2]!.replace(/[?[\]]/g, ""),
        attributes: fieldMatch[3]!,
      });
    }
    models.push({ name, fields });
  }
  return models;
}
