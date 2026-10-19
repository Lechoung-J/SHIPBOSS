# Codex Platform Mapping

[English](codex.md) | [中文](codex.zh-CN.md)

This document maps the abstract concepts of [`PROTOCOL.md`](../PROTOCOL.md) to OpenAI Codex CLI primitives. When principles conflict, `PROTOCOL.md` prevails. Flags and event fields follow the currently installed version's `codex --help` / `codex exec --help`.

## Dispatch

### Workspace

The engineer and the verifier each use an independent worktree, started from explicit commits:

```bash
git worktree add ../<repo>-<task-id>-engineer <baseline-commit>
git worktree add ../<repo>-<task-id>-verify <engineer-commit>
```

`codex exec` is the non-interactive entry point; write the brief under the main repository's absolute path (`$ROOT`) and pass it in via command substitution, avoiding an overlong inline prompt. Do not write evidence into the workspace (worktree) either, since it will be deleted when no longer needed:

```text
$ROOT/.delegate/<TASK-ID>/engineer-brief.md
$ROOT/.delegate/<TASK-ID>/verification-brief.md
$ROOT/.delegate/<TASK-ID>/evidence/
```

The approval option `-a/--ask-for-approval` belongs to the **top-level** `codex` and must be written **before** `exec`; `--sandbox` is **declared at both the top level and on `codex exec`**, is not exclusive to `exec`, and parses whether written before or after `exec`; `--json` and `--output-last-message` belong to `codex exec` and are written after `exec`. The `codex exec` subcommand itself does not expose an approval switch.

### Engineer dispatch

```bash
# Evidence must land at an absolute path under the main repository; do not write it into the workspace (worktree), which will be deleted when no longer needed.
ROOT="<absolute path to the main repository>"
EVIDENCE="$ROOT/.delegate/<TASK-ID>/evidence"
mkdir -p "$EVIDENCE"

# Code execution still enters the engineer workspace.
cd "$ENGINEER_WORKTREE"
codex -a never exec \
  --sandbox workspace-write \
  --output-last-message "$EVIDENCE/engineer-final.md" \
  --json \
  "$(cat "$ROOT/.delegate/<TASK-ID>/engineer-brief.md")" \
  > "$EVIDENCE/engineer-events.jsonl" \
  2> "$EVIDENCE/engineer-stderr.log"
echo "exit=$?"
```

Key points:

- The engineer needs to write code and run tests, so use `workspace-write`; do not use `danger-full-access` by default. Whether `workspace-write` can actually write has not been tested in this version.
- `-a never` must be placed before `exec`. `--ask-for-approval` is an option of the top-level `codex` (values `untrusted` / `on-request` / `never`); writing it after `exec` reports `error: unexpected argument '--ask-for-approval' found` (codex-cli 0.144.1, tested on 2026-10-18).
- The `config.toml` key names corresponding to the approval policy have not been tested; currently only the CLI form `-a/--ask-for-approval` is guaranteed to work. Whether `-a never` really suppresses approval prompts is likewise untested; do not mistake "the command parses" for "approval is off".
- When dependencies need to be installed or network access is needed, prefer to pre-provision the environment before dispatch; if network access is unavoidable during the task, record the specific reason and scope, and do not open the whole network by default.
- The JSONL event stream from `--json` is written to disk as process evidence; the final message from `--output-last-message` serves as the input to the one-pager.
- One independent workspace per task; do not share it with the verifier.

### Verifier dispatch

```bash
# Evidence must likewise land at an absolute path under the main repository; do not write it into the workspace (worktree), which will be deleted when no longer needed.
ROOT="<absolute path to the main repository>"
EVIDENCE="$ROOT/.delegate/<TASK-ID>/evidence"
mkdir -p "$EVIDENCE"

# Verification execution still enters the verification workspace.
cd "$VERIFY_WORKTREE"
codex -a never exec \
  --sandbox read-only \
  --output-last-message "$EVIDENCE/verifier-final.md" \
  --json \
  "$(cat "$ROOT/.delegate/<TASK-ID>/verification-brief.md")" \
  > "$EVIDENCE/verifier-events.jsonl" \
  2> "$EVIDENCE/verifier-stderr.log"
echo "exit=$?"
```

Key points:

- The verifier must use the `read-only` sandbox; it may only read, inspect, and run verification commands on the whitelist. Whether `read-only` actually prevents writes has not been tested in this version; when strong isolation is needed, add a container or a separate user.
- Codex does not have per-tool whitelists like Claude Code; tool boundaries are mainly formed jointly by the sandbox mode + approval policy + the command whitelist in the brief. When finer restrictions are needed, use a wrapper script that exposes only the allowed commands.
- The verifier's workspace is based on the commit delivered by the engineer, either newly created or a read-only copy; the directory the engineer is editing cannot be used.
- The verifier must itself re-run `verify.sh` and the commands corresponding to the ACs, keeping its own exit codes and JSON event stream.

### Other available options in 0.144.1

The following are all listed by `codex exec --help` (codex-cli 0.144.1, checked on 2026-10-18); for exact semantics, refer to that help text:

- `-c/--config <key=value>`: override `~/.codex/config.toml`, supporting dotted paths;
- `-C/--cd <DIR>`: specify the working root directory;
- `--add-dir <DIR>`: add a writable directory outside the main workspace;
- `--ephemeral`: do not persist session files;
- `--ignore-user-config`: do not load the user's `config.toml` (authentication still reads `CODEX_HOME`);
- `--strict-config`: report an error immediately on encountering a configuration field this version does not recognize;
- `--enable/--disable <FEATURE>`: enable/disable a feature flag (repeatable).

### Using AGENTS.md

You can place `AGENTS.md` in the workspace to describe repository-level constraints (read-only material, files that must not be modified, test commands). But **AGENTS.md is a hint, not a permission boundary**; permissions are still guaranteed by the sandbox and approval policy.

### Session banner (optional)

On the first session where the agent adopts this protocol, it may print the contents of
[`docs/welcome.txt`](../docs/welcome.txt) **once**, inside a single fenced code block.

- once per session only — not on every turn;
- keep it inside the code block, or the art wraps and turns into noise;
- it is a greeting, not a status report; nothing in the protocol depends on it.

## Waiting and Resuming

### Normal path

- `codex exec` is a **synchronous process**: process exit is the completion signal. When run in the foreground, proceed directly to verification after the command returns.
- Exit code 0 only means the process ended successfully, not that the ACs passed; independent verification is still required.
- After resuming, first read the `--output-last-message` file, the last `turn.completed` in the `--json` event stream (event name untested), and the exit code, then decide the next step.

### Background execution

- Codex itself has no "in-session background task + wake the model on completion" primitive; the lifecycle of `codex exec` is the process lifecycle.
- When background execution is needed, an **external orchestrator** is responsible:
  - shell: `nohup codex exec ... &`, then `wait $!` in the orchestration script, then start verification;
  - systemd / CI / task queue: trigger the next step on the process exit event.
- Codex's `notify` hook can be configured to call external scripts when events such as `agent-turn-complete` occur. It is suitable for writing wake files, sending notifications, and triggering orchestrators, **but it will not resume a Codex session that has already ended**. Whether the `notify` hook exists and whether the `agent-turn-complete` event name is spelled correctly are both untested, and change with version.
- Manual recovery: read `RUN.md`, the handoff, and the event stream; confirm whether the process is still alive; for unattended recovery use `codex exec resume --last` (non-interactive; under `exec` in 0.144.1), or continue a new session from on-disk state. The top level also provides `codex resume` (an interactive picker for a human to choose a session manually, not suitable for unattended use); do not confuse the two. Do not assume the previous round completed.
- Timeout: wrap with an external `timeout`, e.g. `timeout 30m codex exec ...`; treat exit code 124 as a timeout, keep the logs, and terminate.
- **Polling forbidden**: do not use `sleep` loops, repeatedly tail the event stream, or repeatedly query the process to disguise waiting. This violates V-1.

## Context Budget

### How to read it

- The `turn.completed` event of `codex exec --json` (event name untested) usually contains this turn's usage (such as input tokens, output tokens, cache-hit tokens). This is a **statistic after this turn ends**, not real-time remaining budget.
- The context window comes from model metadata or a configuration such as `model_context_window` in `config.toml` (key name untested). **Do not guess a number yourself**; if it cannot be read, mark it as unavailable.
- The approval policy is controlled by the top-level `-a/--ask-for-approval`; the corresponding `config.toml` key name is untested, so do not write configuration by guessing key names.
- Estimation method: `most recent turn's input_tokens / known context window` can serve as a rough lower bound/estimate of the occupancy ratio, but system prompts, tool definitions, caching, etc. introduce bias, so it must be labeled an "estimate".
- The TUI's `/status` and similar interfaces can show usage to a human; do not assume the model can programmatically read the same real-time numbers.

### How to degrade when it cannot be read

1. Write to disk phase by phase: after completing each AC/phase, write `RUN.md` and a handoff draft.
2. Keep the JSONL event stream for every `codex exec`; when changing sessions, read only the summary, the last event, and the evidence index.
3. Split long tasks into multiple short executions; after each one ends, decide whether to continue or change shifts based on on-disk state.
4. Write `capability.context_remaining: estimated` or `unsupported` in `RUN.md`, and hand off early.
5. Do not enlarge the context window configuration (`model_context_window`, key name untested) to "solve" the context problem; the window is a model capability, not available budget.

## Known Unsupported Capabilities

- **In-session background task + completion wake**: `codex exec` is process-level synchronous execution; there is no built-in "wake a finished session when it ends" mechanism.
- **`notify` as a recovery mechanism**: `notify` can only trigger external commands, not resume a session; the existence and spelling of the hook and event name (such as `agent-turn-complete`) are untested and change with version.
- **The `codex exec` subcommand does not expose an approval switch**: `-a/--ask-for-approval` is an option of the top-level `codex` (values `untrusted` / `on-request` / `never`); writing it after `exec` reports `error: unexpected argument '--ask-for-approval' found`. Dispatch scripts must place the approval flag **before** the subcommand: `codex -a never exec …` (codex-cli 0.144.1, tested on 2026-10-18).
- **Built-in subagent/role orchestration**: there is no Task-style subagent primitive; the engineer and verifier need to be started as independent processes/sessions by an external orchestrator.
- **Fine-grained tool whitelist**: there is no stable per-tool allow/deny primitive; it mainly relies on `--sandbox`, the approval policy, and command wrapper scripts.
- **Real-time context percentage**: only post-turn usage and the window size from configuration; there is no way to know the exact remaining amount.
- **Read-only means confidential**: whether the `read-only` sandbox actually prevents writes is untested; even if it works, it does not hide sensitive files in the workspace; when confidentiality is needed, use a container, a separate user, or credential isolation.
- **Network and platform consistency**: the sandbox's network policy, path restrictions, and approval behavior change with platform/version; cross-platform consistency cannot be assumed.
- **Built-in queue, lock, worktree management**: the backlog, mutual exclusion, and workspace lifecycle are handled by files and external scripts.
- **Cross-machine/cross-version recovery**: the availability, subcommand location, and session storage location of `codex exec resume` change with version; migration is not guaranteed.
- **Automatic AC judgment**: ACs still need an external `verify.sh` or explicit commands to judge; a process exit code does not mean verification passed.
