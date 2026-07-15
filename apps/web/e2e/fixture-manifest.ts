// The @nvhash/fixtures manifest for e2e config/assertions. Loaded via
// createRequire because Playwright evaluates config/specs in plain Node ESM,
// where a JSON `import` needs import attributes our TS module target
// (ES2022) cannot emit; CJS require resolves the package exports map fine.
import { createRequire } from "node:module";

interface FixtureManifest {
  chain_id: string;
  contract: string;
  vault: string;
}

export const manifest = createRequire(import.meta.url)(
  "@nvhash/fixtures/manifest",
) as FixtureManifest;
