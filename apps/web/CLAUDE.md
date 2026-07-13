# CLAUDE.md — web app

End-user web interface. Production quality.

## Conventions

- Audience is end users: clear language, guarded flows, and graceful error
  handling. Raw contract/debug detail belongs in `apps/console/`, not here.
- Read indexed data through `services/api/`; only talk to the chain directly
  for wallet signing and transaction broadcast.
- Accessibility and responsive layout are requirements, not nice-to-haves.

## Commands

To be filled in when the app scaffold lands.
