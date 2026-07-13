# CLAUDE.md — web app

End-user web interface. Production quality.

## Conventions

- Audience is end users: clear language, guarded flows, and graceful error
  handling. Raw contract/debug detail belongs in `apps/console/`, not here.
- Read indexed data through `services/api/`; only talk to the chain directly
  for wallet signing and transaction broadcast.
- Accessibility and responsive layout are requirements, not nice-to-haves.
- Security ([`SECURITY.md`](../../SECURITY.md)): never touch private keys or
  mnemonics — wallet adapters own signing; everything in the client bundle
  and `VITE_*` env is public; UI guards are convenience, the contract is the
  enforcement boundary.

## Commands

To be filled in when the app scaffold lands.
