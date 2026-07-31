# Documentation

- [`specs/`](specs/) — durable technical specifications: protocol behavior,
  contract interfaces, API shapes, invariants. Includes
  [`specs/chain-facts.md`](specs/chain-facts.md), the measured chain and
  protocol behaviors that constrain more than one tier.
- [`plans/`](plans/) — working plans, primarily for Claude Code sessions.
  Ephemeral by nature; records what a PR delivered and in what order.
- [`architecture/`](architecture/) — system-level architecture documents and
  architecture decision records (ADRs), plus the per-area `*-design-notes.md`
  that hold rationale, measured alternatives, and recorded decisions;
  [`architecture/history/`](architecture/history/) preserves design records
  migrated from the exploratory repository.
- [`user/`](user/) — end-user and operator documentation.

## Which file does this belong in?

The `CLAUDE.md` files are loaded into every session, so they carry only what a
contributor needs *while editing that area*: conventions, layout, commands, CI
gates. Everything else lives here.

| Content | Home |
|---|---|
| Working conventions, commands, CI gates | the area's `CLAUDE.md` |
| Why a design was chosen; alternatives measured; accepted-as-is decisions | `architecture/<area>-design-notes.md` |
| A decision between technologies or structures, with consequences | an ADR in `architecture/` |
| Behavior a caller can depend on | `specs/` |
| Measured chain/protocol behavior | [`specs/chain-facts.md`](specs/chain-facts.md) |
| What a PR delivered, in what order | `plans/` |
| Why one line reads the way it does | the commit message |

Source comments follow
[`architecture/comment-standard.md`](architecture/comment-standard.md).
