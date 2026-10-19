# DSH Platform Mapping

[English](dsh.md) | [中文](dsh.zh-CN.md)

This document maps the abstract concepts of [`PROTOCOL.md`](../PROTOCOL.md) to DSH host primitives. **This is the only file in the entire repository where DSH-specific identifiers are allowed.** When principles conflict, `PROTOCOL.md` prevails; for primitive details, this document prevails.

First, a declaration: DSH capabilities change with version and configuration. What follows describes the usage this protocol relies on; before actual execution, record the version, configuration, and "unsupported items" in `RUN.md`.

## Dispatch

### Workspace

The engineer and the verifier each use an independent workspace, both created from explicit commits:

```bash
git worktree add ../<repo>-<task-id>-engineer <baseline-commit>
git worktree add ../<repo>-<task-id>-verify <engineer-commit>
```

Write the task ID, absolute workspace path, baseline commit, and target commit into `RUN.md`. Two roles are forbidden from sharing one mutable workspace.

### Subagent primitives

Verify availability first, then choose a path. The table separates "primitives that truly exist in this host" from "primitives that depend on the host backend being installed and may not be callable on this machine":

| Primitive | Semantics | Use case | Availability |
|---|---|---|---|
| `subagent` | Start a subagent with a brand-new context | Engineer, independent verifier | ✅ Exists in this host; use it for verification to get a fresh context |
| `subagent_fork` | Fork from the current session, inheriting the current context | Phase continuation within the same task, in-context consultation | ✅ Exists; **forbidden for independent verification** (the context is not independent) |
| `subagent_codex` | Start Codex CLI as a subagent with an independent context | Engineer, independent verifier (only after the backend is installed) | ⚠️ **Not installed in this version**; depends on host backend installation; do not treat it as a directly callable primitive |
| `subagent_claude_code` | Start Claude Code as a subagent with an independent context | Engineer, independent verifier (only after the backend is installed) | ⚠️ **Not installed in this version**; depends on host backend installation; do not treat it as a directly callable primitive |

Selection rules:

- **Default to "CLI engineer + background job"** (see the next section). This is the path validated by multiple actual dispatches in this repository, and it depends on no subagent backend.
- Only after the user confirms that the host has the Codex / Claude Code subagent backend installed may `subagent_codex` / `subagent_claude_code` be considered; both are **not installed** in this version, and when in doubt always fall back to CLI + background job.
- When one-click dispatch inside the host is needed, use the genuinely existing `subagent`; it gives a brand-new context and is suitable for independent verification.
- `subagent_fork` is only for "continuing the work"; it inherits context and possible bias, and cannot implement verification independence.

Example calls are in the two paths below. **Do not copy any primitive that this document marks as "not installed".**

### Path A: CLI engineer + background job (validated in practice)

Applies: external orchestration, a need for reproducible commands, a need for complete stdout/stderr on disk, or a host without a subagent backend installed. The approach is to submit the CLI command as a **background job** (the host's `run_in_background` mechanism), with the command exit code and result file written to disk, then resume via `job_output`.

```bash
# Evidence must land at an absolute path under the main repository; do not write it into your worktree, which will be deleted when the workspace is no longer needed.
ROOT="<absolute path to the main repository>"
EVIDENCE="$ROOT/.delegate/<TASK-ID>/evidence"
mkdir -p "$EVIDENCE"

# Code execution still enters the engineer workspace.
cd "$ENGINEER_WORKTREE"

# The brief to dispatch; the Claude and Codex commands share the same prompt.
BRIEF="$(cat "$ROOT/.delegate/<TASK-ID>/engineer-brief.md")"

# Submit as a background job; do not block this round in the foreground.
# bypassPermissions is only so the engineer can run tests and commit; do not copy this permission option as a production default.
printf '%s' "$BRIEF" | env ANTHROPIC_BASE_URL="$ANTHROPIC_BASE_URL" \
  ANTHROPIC_AUTH_TOKEN="$ANTHROPIC_AUTH_TOKEN" \
  ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
  claude -p --bare --model <model> --output-format json \
    --max-turns 50 --permission-mode bypassPermissions \
    > "$EVIDENCE/engineer-result.json" \
    2> "$EVIDENCE/engineer-stderr.log"  # --max-turns is not listed in claude --help, but parses in practice

# If Codex is installed locally, use codex exec; for exact parameters, refer to the local version's --help.
codex -a never exec --sandbox workspace-write \
  "$BRIEF" \
  > "$EVIDENCE/engineer-result.json" \
  2> "$EVIDENCE/engineer-stderr.log"
```

Key points:

- The flags in this example follow the local `claude --help`; flags such as `--max-turns` that are not listed in help but still parse follow actual testing; under `--bare`, Anthropic authentication is strictly limited to one of **`ANTHROPIC_API_KEY` or `apiKeyHelper` (passed via `--settings`)**, and `ANTHROPIC_AUTH_TOKEN` cannot replace it on its own; this repository's actual dispatch script supplies both `ANTHROPIC_AUTH_TOKEN` and `ANTHROPIC_API_KEY`, which is equivalent to this example.
- `--bare` skips hooks, LSP, plugin sync, and `CLAUDE.md` auto-discovery, retaining only minimal CLI behavior; do not expect it to load project hooks/plugin configuration. If you switch to a recipe without `--bare` (tested in an earlier release), these auto-discoveries return, and the authentication method and flags also change with `claude --help`; verify the differences yourself.
- The fallback line for `codex exec` uses top-level `-a never` to disable approval and `--sandbox workspace-write` to allow file writes within the workspace; for exact parameters, still refer to the local version's `--help`.
- Commands execute in the engineer workspace; create the workspace and baseline commit first per the "Workspace" section.
- Write `engineer-result.json`, `engineer-stderr.log`, and the exit code into `RUN.md` and `$EVIDENCE` (i.e. `.delegate/<TASK-ID>/evidence/` under the main repository); do not leave them only in the terminal, and do not write them into a worktree that will be deleted.
- The background job ID (of the form `bash-3537`) is the only credential for resuming the task.

### Path B: In-host subagents (depends on backend installation)

Applies: the host already provides a usable subagent backend, and you want one-click dispatch without managing CLI processes and environment variables yourself.

- If the user confirms the backend is installed, call the corresponding Codex / Claude Code subagent per the host documentation; on this machine these two primitives are **not installed**, and this document provides no call examples that can be copied directly.
- Prefer `subagent` for independent verification (fresh context); do not substitute `subagent_fork`.
- Parameter names follow the current host; this document does not fabricate unverified parameters.

Trade-off between the two paths: **CLI + background job** suits external orchestration, reproducibility, and cross-session recovery; **in-host subagents** suit one-click dispatch inside the host. When the backend is not installed or cannot be confirmed, only the former is possible.

### Background jobs

Put long builds, tests, and batch commands into background jobs:

- After dispatch, record the returned job ID (of the form `bash-3537`) in the `job` field of `RUN.md`.
- Use `job_output` to read the job's output; when reading, take only the final result or the last few lines, and write the complete output to disk at `$ROOT/.delegate/<TASK-ID>/evidence/`.
- Use `job_list` to view the current job list, and `job_kill` to cancel runaway or no-longer-needed jobs; after cancellation, keep the logs already produced and the reason for termination.
- **End the round** after dispatch; do not repeatedly call `job_output` within the same turn.

### Completion delivery and wake limits (host configuration items)

- `completionDelivery` and `maxConsecutiveWakes` are both **host configuration items that the agent side cannot verify**: this document does not present them as executable instructions; whether they exist, what they are called, and how to enable them must all be confirmed by the user on the local machine.
- If the user confirms that the host provides completion delivery (`completionDelivery` in effect): when the task ends (success, failure, or cancellation), the host may deliver the status and result back to the current session, forming one wake; the agent side cannot verify whether this behavior actually occurs.
- If the user confirms that the host provides a wake limit (`maxConsecutiveWakes` in effect): each wake should be a clear decision (verification, rework, report), not continued mindless waiting; after reaching the limit there are no more automatic wakes, and the PM manually takes over or starts a shift change. The actual value and semantics of this configuration cannot be verified by the agent side.
- If the host does not have the above capabilities: do not assume automatic resumption; switch to an external orchestrator or foreground blocking (see "When there is no completion delivery").

### Engineer brief

The brief is written to disk as `$ROOT/.delegate/<TASK-ID>/engineer-brief.md` and includes at least:

- spec path and version, baseline commit, absolute workspace path;
- deliverables and ACs;
- read-only source material;
- evidence paths that must be written to disk and the report format;
- prohibitions (changing ACs, changing read-only materials, sharing a workspace).

### Session banner (optional)

On the first session where the agent adopts this protocol, it may print the contents of
[`docs/welcome.txt`](../docs/welcome.txt) **once**, inside a single fenced code block.

- once per session only — not on every turn;
- keep it inside the code block, or the art wraps and turns into noise;
- it is a greeting, not a status report; nothing in the protocol depends on it.

## Waiting and Resuming

### Normal path

1. Before dispatch, confirm with the user whether the host provides completion delivery (`completionDelivery` is a host configuration item that the agent side cannot verify); also confirm that the job ID will be written back to `RUN.md`. If the host does not provide it, switch to an external orchestrator or foreground blocking.
2. Dispatch the engineer task in the background: default to "CLI engineer + background job"; when truly necessary and the backend is available, use the in-host `subagent`.
3. **End the round**. Do not query status, do not sleep, do not repeatedly read output, do not use blocking waits.
4. After receiving the completion delivery (wake), take the job ID, exit status, and result file path from the message.
5. Read only the final conclusion and evidence index; when details are needed, read them by path, and do not pull the full log into context.
6. Proceed to independent verification. If the status is failed or cancelled, handle it per the failure path and keep the evidence.

### Recovery after Stop

After the session is stopped, the user interrupts, or the host restarts:

1. Read `RUN.md` and the most recent handoff first; do not rely on conversational memory.
2. Call `job_output` once for the recorded job ID to confirm whether it is running, finished, or lost.
3. If the task is no longer meaningful or the workspace is contaminated, call `job_kill`, discard that workspace, and restart from the last compliant commit.
4. Never assume "it should have finished already"; rely on job status and commits.
5. Write recovery actions and conclusions back to `RUN.md`.

### When there is no completion delivery

- If the host does not provide `completionDelivery` or the capability is unavailable (a host configuration item that the agent side cannot verify): switch to foreground blocking execution (`background=false`), or have an external orchestrator start the next round after the process exits.
- If only background execution is possible and there is no delivery: explicitly write `capability.completion_callback: unsupported`, require manual wake-up, or switch to the foreground.
- **Forbidden** to simulate callbacks with polling: consecutive `job_output` calls, `sleep` loops, and repeated status queries all count as violating V-1.
- Wake limit: if `maxConsecutiveWakes` is provided by the host (a host configuration item that the agent side cannot verify), treat it as "stopped" once exhausted; the PM decides whether to continue, change shifts, or terminate; do not extend wakes indefinitely.

## Context Budget

### How to read it

- Prefer the session status/usage fields provided by the current host version; record the reading, read time, and source in `RUN.md`.
- Some versions store session state or statistics files under `~/.dsh`. They are **not a stable API**: the format changes with version, so they can only be used as a basis for estimation, not as a precise contract.
- The PM records once at each phase boundary: completed phases, current ACs, remaining budget estimate, next handoff point.
- The context consumption of engineer subagents does not count against the PM's budget; dispatching a new subagent gets a new context, but do not let `subagent_fork` inherit a dirty context to do work requiring sober judgment.

### How to degrade when it cannot be read

1. Switch to **phase checkpoints**: after completing each AC or phase, write the status and a handoff draft.
2. Use conservative fixed round/wake-count thresholds; hand off when the threshold is reached, rather than waiting for an error or forgetting.
3. For long tasks, split the work into multiple short subtasks, writing to disk at the end of each.
4. After the handoff, start a new PM context and recover only from disk; do not use `subagent_fork` to pretend to "reset".
5. Mark `capability.context_remaining: unsupported` in `RUN.md` so the Boss knows the shift change may be early or late.

## Known Unsupported Capabilities

- **The Codex / Claude Code subagent backends are not necessarily installed**: when they are not installed on this host, `subagent_codex` / `subagent_claude_code` are unavailable (this machine has them uninstalled), and you must fall back to "CLI engineer + background job".
- **Stable context-remaining API**: there is no guaranteed readable remaining-context percentage; files under `~/.dsh` may change with version, so estimation only.
- **True independent context fork**: `subagent_fork` inherits the current context and cannot be used for independent verification; verification must start a fresh context.
- **Unconditional completion callback**: automatic wake depends on the host providing and correctly configuring `completionDelivery` (a host configuration item that the agent side cannot verify); when disabled, misconfigured, or the host is abnormal, there is no automatic resumption.
- **Unlimited wake chains**: `maxConsecutiveWakes`, if provided by the host (a host configuration item that the agent side cannot verify), truncates long chains; automatic wake cannot be treated as unlimited background execution.
- **Complete output while running**: intermediate output of a background job may be buffered, truncated, or delayed; only the final result and files written to disk are reliable.
- **Read-only isolation by default**: DSH does not guarantee that subagents are naturally read-only; the permission sandbox and tool whitelist must be explicitly configured and verified, otherwise the verifier may have write permission.
- **Mandatory tool whitelist**: tool boundaries depend on the current configuration; you cannot assume that "dispatching to the verifier" automatically restricts tools.
- **Distributed scheduling and cross-machine locks**: there is no built-in cross-machine queue/lock; the backlog and mutual exclusion are guaranteed by files and human discipline.
- **Automatic workspace cleanup**: worktrees and temporary directories must be reclaimed manually.
- **Automatic cross-session recovery**: after a stop, the task intent is not known automatically; you must read `RUN.md` and the handoff.
