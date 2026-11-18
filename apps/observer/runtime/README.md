# Local observer setup

This edition provides local launchers and a read-only observer.
Desktop packaging targets macOS and requires existing Python, Node, locked dependencies and Electron.
Build the renderer before installation: from `apps/observer`, run `pnpm run build`.
Run `python3 apps/observer/scripts/observer-install.py --help` for supported flags.

Install with `--destination DEST --skill-source ROOT --no-start`.
Use `--observer-home APP` for an existing local observer app.
Use `--with-observer --renderer-dist DIR` to copy a locally built renderer and runtime.
Project-local installs use `--project-skill codex` or `--project-skill claude` and an explicit `--project`.
The release Skill is named `shipboss`.

Codex uses `CODEX_THREAD_ID`; Claude uses its host-substituted `CLAUDE_SESSION_ID`.
DSH uses `DSH_SESSION_ID`. These identities are separate.
A real official journal must corroborate external identity and activity.
The activation queue requires a warm helper/writer and writable metadata directory.
External start returns `queued=true, shown=false` until the helper consumes a verified request.
Duplicate first loads do not show the window again. Use explicit `show` when desired.
A cold helper needs normal OS startup first. Missing journals remain unverified.

The observer stores project metadata locally and reads only supported source records.
Use `--exclude-project NAME` to omit a project before decoding its records.
Runtime config and installation receipts are local outputs and should stay out of published source.
