# @nvhash/api-types

The nvHASH App's shared response contract (implementation plan PR 1.2,
[ADR-001](../../docs/architecture/2026-07-14-adr-001-app-component-architecture.md)
Decision 4). Zero runtime dependencies — types plus a small pure builder.

The one type that matters is the **freshness envelope** (app-spec §9.4, §12.1):

```ts
interface Envelope<T> {
  data: T;
  meta: {
    chain_height: number | null;
    indexed_height: number | null;
    generated_at: string; // ISO-8601
    source: "live" | "indexed";
  };
}
```

Every response from `services/api` wraps its payload this way, and `apps/web`
imports the same type — so the freshness contract lives in the API shape, not
just the UI (`SECURITY.md` "never lie about state"). Design rules:

- **`source` is a closed union** (`live | indexed`, spec §9.4). "No data plane
  wired yet" — a cold start, or the M1 scaffold before the M2/M3 workers and
  readers land — is expressed by **null heights**, never a third source value.
  A null height is exactly the "not certified fresh / n/a" signal §12.1 relies
  on.
- **Heights are block heights, not amounts** — small monotonic integers, safe
  in JS `number`. Token amounts stay `BigInt`/`Decimal(39,0)` elsewhere; the
  builder bounds a height to a non-negative safe integer or `null`.
- **`generated_at` is injectable** (`freshness({ …, generatedAt })`) so tests
  are deterministic.

```ts
import { envelope } from "@nvhash/api-types";

// A live read reconciled at head 1_234, with a known indexed height:
envelope(metrics, { source: "live", chainHeight: 1234, indexedHeight: 1230 });

// The scaffold's honest dataless response — heights unknown:
envelope([], { source: "indexed" }); // chain_height: null, indexed_height: null
```

```sh
./dev pnpm --filter @nvhash/api-types typecheck
./dev pnpm --filter @nvhash/api-types test
```
