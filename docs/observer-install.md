# Shipboss

Shipboss combines a delegation protocol with a local, read-only observer.
The PM defines testable requirements. Engineers implement in isolated workspaces.
A fresh verifier checks the exact delivery. The user receives a concise result.

Read [the protocol](../PROTOCOL.md), [the Skill](../SKILL.md), and [platform adapters](../platforms/dsh.md).
The protocol and examples are product documentation. Project conversations and runtime data are local.

## Local requirements

The desktop packaging helper targets macOS. Other platforms are not verified here.
Use existing Python 3, Node.js, the locked JavaScript dependencies, and Electron 41.
The installer does not download dependencies or models. Dependency installation is a separate explicit step.
Build from `apps/observer` with `pnpm run build` after supplying dependencies.
Run Python checks with `python3 -m unittest discover -s runtime -p 'test_*.py'`.
The desktop entry is `desktop/main.cjs`. The built renderer entry is `dist/widget.html`.
Run `pnpm run desktop` for the local demo. The menu-bar window stores data under its local artifacts directory.

## Install the protocol and optional observer

`bash install.sh DEST --no-start` installs the complete Shipboss Skill, protocol, resource CLI, launcher, license and self-check into an explicit destination.
To include a locally built observer, add `--with-observer --renderer-dist DIR`.
An existing Electron executable can be specified with `--electron-binary FILE`.
`--skill-source` on the Python installer must point to this reviewed edition.
It accepts only the fixed public kit file set. It does not search parent repositories for evidence.
Use `python3 apps/observer/scripts/observer-install.py --help` for project-local Skill installation.

The text Skill invokes a launcher; it is not a host hook.
External first-load activation requires a warm helper and writer, writable metadata directories,
and a matching official source journal. A queued request does not prove that a window appeared.
Use the actual Codex desktop/CLI thread identity, or the separate Claude session identity.
Never substitute a DSH identity for an external session. Missing or stale sources remain unknown.
The same project/context loads once. An explicit `show` requests display again.
A cold helper requires an initial normal OS launch. No unconditional auto-popup is promised.

User-facing role phrases are local product flavor text. They do not expose private reasoning.
No independent verification or public release is implied by these instructions.

## License

[MIT](../LICENSE). The original copyright notice is retained.
Dependency versions and their notices remain governed by the respective dependency licenses.

## Locked dependencies and upgrades

From `apps/observer`, use `node /path/to/pnpm.mjs install --frozen-lockfile --trust-lockfile` with pnpm 11.28.5.
`--trust-lockfile` skips pnpm 11 registry metadata policy revalidation for this reviewed lockfile; it does not relax frozen dependency matching.
The exact lockfile retains Electron 41.0.0. `allowBuilds` permits the Electron and esbuild postinstall steps.
Do not use `--ignore-scripts` as proof of a complete Electron install. Confirm the installed executable with `node_modules/.bin/electron --version`.
The dependency store and Electron download cache may be reused; an offline install requires all relevant cache entries.

Use `bash install.sh DEST --force --no-start` to upgrade a recognized installation.
The installer verifies a staged complete kit before replacing owned files.
It backs up replaced files and digest-proven retired banner assets in a sibling `.shipboss-backups` directory.
An existing SOURCE must identify Shipboss, a supported schema and a content-bound installed manifest. Unknown, corrupt or mismatched ownership records block before changing the destination.
Retirement requires the actual asset hash to match its prior ownership record. A user-modified same-name banner stays and is not claimed by the new manifest. Modified incoming-file collisions block instead of treating a backup as permission to replace user content.
The private receipt lists retired, replaced and preserved-unowned paths. Legacy records without ownership digests require separate review; filenames alone never establish ownership.
User files and observer preferences remain in place. Existing observer configuration stays unless explicit replacement flags are supplied.
`SOURCE.json` records the exact source manifest digest rather than relying on the package version alone.
An exception during promotion restores replaced files from the private journal. Abrupt process termination may leave that journal for manual recovery.
Readiness is reported separately; a complete text Skill does not imply the optional observer is ready or visible.

## Electron integrity and installed observer refresh

`pnpm install --frozen-lockfile --trust-lockfile` now runs the project's postinstall health gate.
Run `pnpm run check:electron` explicitly after restoring or moving dependencies too.
The gate checks the actual executable version and, on macOS, the native Framework and bundle plist.
An installer log ending in Done does not certify a usable Electron.app.
A missing/truncated Framework or failed version probe returns nonzero and prevents readiness.
The gate does not download, remove cache entries, or retry automatically.
Preserve the first failed install log. Inspect the pinned package's `node_modules/electron/install.js` and official dependency settings.
For a deliberate repair attempt, run `node node_modules/electron/install.js` once, then rerun `pnpm run check:electron` and preserve both results.
If the official installer leaves a partial app again, report that failure; the download/cache/extraction cause remains undetermined.
Installed root `scripts/observer-install.py --skill-source KIT --destination KIT --with-observer --no-start` resolves its payload from `KIT/observer`.
A complete source checkout uses `apps/observer` instead. User runtime/preferences are not payload inputs during this refresh.

## Current support boundaries

The observer is an optional local macOS component. The Markdown protocol can be used without it.
Native DSH and external Codex/Claude paths have separate identities and journal checks.
A queued activation is not proof of display. Claude external identity compatibility still needs verification with the installed host version; do not infer it from another CLI succeeding.
A warm helper/writer and writable metadata directory are required for restricted external first-load requests.
A cold helper needs an ordinary OS startup before those requests can be consumed.
Local tests do not certify other architectures, operating systems, or external host versions.
Background completion and continuation depend on host support. This kit does not promise indefinite unattended recovery.
Interrupted promotion may leave a private journal; exception rollback is not a guarantee of recovery from an abrupt process kill.
Resource tooling preserves unknown, active and paused owners. Read [resource lifecycle](../references/resource-lifecycle.md) before using plan/apply.
