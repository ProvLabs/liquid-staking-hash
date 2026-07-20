import { setupServer } from "msw/node";

import { handlers } from "./handlers";

/**
 * Node-process interceptor: patches global fetch, so the server-side LCD
 * reads (@nvhash/chain-client) hit the fixture corpus instead of a chain.
 * Consumers: Vitest suites, and entry.server when NVHASH_MOCK=1.
 */
export const server = setupServer(...handlers);
