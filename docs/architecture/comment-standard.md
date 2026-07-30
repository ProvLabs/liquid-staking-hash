# Comment standard

Normative for all source in this repository. `CLAUDE.md` carries the short form;
this document is the full rule and the reviewer's reference.

## Principle

A comment must be verifiable against the source file as it exists today. It is
succinct — it is not the system documentation, which lives in `docs/`. If
understanding a comment requires knowing what the code used to be, it belongs in
the commit message, an ADR, or an issue, not in the source.

## Required — interface documentation

Every public/exported type, function, and constant carries a doc comment
specifying the contract:

- what it does,
- parameter meaning and valid ranges,
- return value,
- errors thrown or returned,
- side effects,
- any nullability, concurrency, or ordering guarantee a caller must rely on.

Document the contract, not the implementation. A caller must be able to use the
symbol correctly without reading the body, and the doc must remain true across
any refactor that preserves behavior.

## Permitted — clarifying comments

In-body comments are justified only where the code cannot express the reason
itself:

- a constraint imposed from outside the file (spec section, protocol
  requirement, upstream bug),
- a deliberate deviation from the obvious implementation,
- a non-obvious correctness or performance requirement that a future reader
  would otherwise "clean up".

Phrase these as present-tense constraints on the code, not as narrative.

## Prohibited

- **Historical narrative** — what the code used to do, when it changed, which
  refactor, PR, milestone, or ticket produced it, who wrote it.
- **Delivery provenance** — `PR 6.4 commit A`, `M7.1 plan §2.2`, `added in the
  2026-07-28 review`, `shipped wrong because…`. Plans record delivery; source
  records behavior.
- **Roadmap** — what a later milestone will add, what a scaffold is a
  placeholder for. Speculative descriptions of code that does not exist.
- **Restatement** of what the code plainly says.
- **Commented-out code.**
- **Dated TODOs** without an owning issue reference.

## Permitted references

A comment may cite a durable, external authority that constrains the code:

- a spec section (`app-spec §9.4`, `console-spec §11.2`),
- an ADR (`ADR-001 Decision 2`),
- a measured chain behavior recorded in [`docs/specs/chain-facts.md`](../specs/chain-facts.md),
- a fixture or gating test that pins the behavior (`test/tx-fee.test.ts`).

These are constraints, not history: they stay true independent of how the code
got here. A citation of a **plan** is not in this set — plans are ephemeral.

## The test

Could someone with no knowledge of the repository's history write this comment
from the current source alone? If yes, keep it. If no, either delete it or
rewrite it as a constraint:

```
// BAD:  We tried caching this in the v3 refactor but it broke on reorgs.
// GOOD: Not cacheable: results are invalidated by chain reorg, which this
//       layer cannot observe.
```

```
// BAD:  M6.4 shipped a natural key that was wrong, so this one was measured.
// GOOD: `(proposalId, voter)` is a sound natural key: the chain rejects a
//       second MsgVote from the same voter (chain-facts §x/group 6).
```

## Enforcement

The rewrite rule matters more than the deletion rule. Most "development lore"
comments encode a real constraint under a narrative wrapper; deleting them
wholesale loses the constraint and invites the same mistake. Reject the
phrasing and demand the constraint — do not just strike the line.

Missing docs on exported symbols, commented-out code, and author tags are
lintable. The rest is a review responsibility.

## Where evicted content goes

| Content | Home |
|---|---|
| Why a design was chosen, alternatives measured | `docs/architecture/` (ADR or `*-design-notes.md`) |
| Behavior a caller can depend on | `docs/specs/` |
| Measured chain/protocol behavior | `docs/specs/chain-facts.md` |
| What a PR delivered, in what order | `docs/plans/` |
| Why one line reads the way it does | the commit message |
