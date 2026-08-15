// The pre-certification caveat's ONE input (plan 8.4 §2.7.2; D22/D27): the
// fixture-corpus manifest status. `@nvhash/fixtures` manifest.json is
// PROVISIONAL until PR 8.0's re-capture against the formal vault release
// flips it — so the caveat retires only when the artifact that DEFINES
// certification changes, in the same commit. No per-environment "certified"
// config flag exists to forget or to lie with. The import is unconditional:
// a build without the manifest fails to compile (C4 — there is no
// "input unavailable" cell). Gated by test/certification-caveat.test.ts.
import manifest from "@nvhash/fixtures/manifest";

/** The one rule: a manifest status beginning `PROVISIONAL` is uncertified. */
export function corpusCertified(status: string): boolean {
  return !status.startsWith("PROVISIONAL");
}

/** True once the corpus is re-captured against a formal vault release (8.0). */
export const CORPUS_CERTIFIED: boolean = corpusCertified(String(manifest.status));
