# @nvhash/chain-client

Typed chain reads for the nvHASH App (implementation plan PR 0.3): the
asset-manager contract's smart queries, the vault module, x/staking, and
x/group over LCD REST. Zero runtime dependencies — a plain `fetch` wrapper
plus hand-written decoders.

Design rules:

- **BigInt amount discipline** (app-spec §13): every `Uint128`/amount decodes
  to `bigint` at the boundary; a JSON *number* where an amount belongs is a
  `DecodeError`, never a lossy accept. Signed values (`net_deposits`) use
  `parseInt128`; proto-JSON string uint64s (heights, seconds, totals) use
  `parseU64String`; contract u64 JSON numbers are bounded safe integers.
- **Shapes are fixture-locked.** Every decoder is tested against the
  [`@nvhash/fixtures`](../fixtures/README.md) corpus verbatim — when the
  formal vault release changes a shape, tests here break first (spec §9.2;
  re-vet gate PR 8.0).
- **Transport facts are encoded, not assumed:** vault REST lives under
  `/vault/v1`; `estimate_swap_out` serves over REST; **`estimate_swap_in`
  throws `UnsupportedTransportError`** — grpc-gateway rejects
  `Coin`/`math.Int` query params on the current dev build, so swap-in
  estimates need a server-side gRPC path (M5 wallet lane) until the upstream
  release fixes the annotation.

```ts
import { LcdClient, VaultClient, NvhashContractClient } from "@nvhash/chain-client";

const lcd = new LcdClient(process.env.LCD_URL!);
const vault = await new VaultClient(lcd).getVault(vaultAddr);
const snapshot = await new NvhashContractClient(lcd, contractAddr).epochSnapshot();
// vault.totalVaultValue.amount and snapshot.tvvAfter are bigint
```

```sh
pnpm --filter @nvhash/chain-client typecheck
pnpm --filter @nvhash/chain-client test
```
