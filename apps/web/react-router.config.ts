import type { Config } from "@react-router/dev/config";

export default {
  // SSR is normative (app-spec §6): public pages render fully with no wallet
  // and no client JS requirement for first paint.
  ssr: true,
} satisfies Config;
