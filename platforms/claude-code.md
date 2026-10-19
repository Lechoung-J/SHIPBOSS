# Claude Code Platform Mapping

[English](claude-code.md) | [中文](claude-code.zh-CN.md)

This document maps the abstract concepts of [`PROTOCOL.md`](../PROTOCOL.md) to Claude Code primitives. When principles conflict, `PROTOCOL.md` prevails. Specific flags follow the currently installed version's `claude --help`; flags such as `--max-turns` that are not listed in help but still parse follow actual testing; what follows is the stable usage recommended by this protocol.

## Dispatch

### Workspace

The engineer and the verifier each use an independent worktree:

```bash
git worktree add ../<repo>-<task-id>-engineer <baseline-commit>
git worktree add ../<repo>-<task-id>-verify <engineer-commit>
```

Briefs and output are both written to disk under the main repository's absolute path (`$ROOT`); do not stuff long briefs directly into the parent session; do not write evidence into the workspace (worktree), which will be deleted when no longer needed:

```text
$ROOT/.delegate/<TASK-ID>/engineer-brief.md
$ROOT/.delegate/<TASK-ID>/verification-brief.md
$ROOT/.delegate/<TASK-ID>/evidence/
```

### Interactive: Agent / Task subagents

- Use the **Agent tool** (called the Task tool in older versions) to dispatch a subagent, with `subagent_type` set to `general-purpose`; for read-only exploration use `Explore` or `Plan`.
- Give the subagent the brief file path and require it to read the spec before acting.
- The subagent executes in the engineer workspace, commits, and writes the report to the evidence path.
- Verification must open a new Agent call; do not use the implementation process, the engineer's self-assessment, or the parent session's reasoning as verification input. The parent session passes only: spec, delivered commit, verification brief, evidence path.

Example:

```text
Agent(
  subagent_type = "general-purpose",
  description   = "TASK-001 engineer",
  prompt        = "First read $ROOT/.delegate/TASK-001/engineer-brief.md, then execute in <engineer-worktree>, and write evidence to $ROOT/.delegate/TASK-001/evidence/."
)
```

### Headless CLI: `claude -p`

Suitable for dispatch by external scripts or orchestrators:

```bash
# Evidence must land at an absolute path under the main repository; do not write it into the workspace (worktree), which will be deleted when no longer needed.
ROOT="<absolute path to the main repository>"
EVIDENCE="$ROOT/.delegate/<TASK-ID>/evidence"
mkdir -p "$EVIDENCE"

# Code execution still enters the engineer workspace.
cd "$ENGINEER_WORKTREE"
claude -p "$(cat "$ROOT/.delegate/<TASK-ID>/engineer-brief.md")" \
  --allowedTools "Read" "Grep" "Glob" "Bash" "Edit" "Write" \
  --permission-mode acceptEdits \
  --output-format json \
  --max-turns 50 \
  > "$EVIDENCE/engineer-result.json" \
  2> "$EVIDENCE/engineer-stderr.log"  # --max-turns is not listed in claude --help, but parses in practice
echo "exit=$?"
```

Premises and boundaries of the example (PM tested on Claude Code 2.1.251 on 2026-10-18):

- `--permission-mode acceptEdits` covers file edits only: it can read and write files and run read-only commands (such as `echo`, `git log`); but it **cannot** run scripts that write files, and cannot `git add/commit`. The `--allowedTools` in the example above already explicitly includes `Bash`, which is a tool-level blanket grant; see [the fallback path](#when-the-engineer-cannot-self-check-or-commit) below for details.
- `--allowedTools` is **variadic** (written as `<tools...>` in help): if the prompt positional argument immediately follows it, the prompt is swallowed as a tool name, reporting `Error: Input must be provided either through stdin or as a prompt argument when using --print`, exit code 1, and no JSON is produced. The correct approach is to pass the prompt via `stdin` (`printf '%s' "$BRIEF" | claude -p --permission-mode acceptEdits --allowedTools "Bash" ...`), or to ensure that another flag, not the prompt, immediately follows `--allowedTools`.

The verifier uses a restricted tool set (syntax follows the current version):

```bash
# Evidence must likewise land at an absolute path under the main repository; do not write it into the workspace (worktree), which will be deleted when no longer needed.
ROOT="<absolute path to the main repository>"
EVIDENCE="$ROOT/.delegate/<TASK-ID>/evidence"
mkdir -p "$EVIDENCE"

# Verification execution still enters the verification workspace.
cd "$VERIFY_WORKTREE"
claude -p "$(cat "$ROOT/.delegate/<TASK-ID>/verification-brief.md")" \
  --allowedTools "Read" "Grep" "Glob" "Bash(git diff:*)" "Bash(git show:*)" "Bash(bash .delegate/<TASK-ID>/verify.sh)" \
  --disallowedTools "Edit" "Write" "NotebookEdit" \
  --permission-mode default \
  --output-format json \
  --max-turns 30 \
  > "$EVIDENCE/verifier-result.json" \
  2> "$EVIDENCE/verifier-stderr.log"  # --max-turns is not listed in claude --help, but parses in practice
```

Additional constraints:

- `--permission-mode plan` can serve as an extra read-only layer, but it limits execution ability; do not rely on plan mode alone when tests need to be run.
- `--allowedTools` / `--disallowedTools` are tool-level controls, not equivalent to filesystem read-only; the verification workspace itself should be a read-only copy or an independent worktree.
- The result file of `--output-format json` is part of the verification evidence; do not keep only the human-readable summary.

### When the engineer cannot self-check or commit

Headless `-p` has no approval responder. If the dispatch configuration does not let the engineer execute commands with write side effects, the engineer can neither run `verify.sh` nor commit; choose from low to high risk:

- **Narrow whitelist**: How—add `--allowedTools "Bash"` on top of `--permission-mode acceptEdits`, and pass the prompt via `stdin` (`printf '%s' "$BRIEF" | claude -p ... --allowedTools "Bash"`), avoiding the variadic argument-swallowing pitfall; PM tested on 2.1.251 on 2026-10-18 that `verify.sh` can run (`ALL GREEN (exit 0)`) and that commits succeed. Cost and risk—this is a **tool-level** opening of the entire Bash, not a command-level whitelist; command-level forms (such as `Bash(git *)`) are **untested**. Applicable scenario—routine self-check inside an isolated worktree with a trusted brief source.
- **`--permission-mode bypassPermissions`**: How—use this mode directly at dispatch; the engineer can run `verify.sh` and commit (tested). Cost and risk—approval is fully off and any command can execute; use only in a one-off isolated worktree or container, and **must not be the default**. Applicable scenario—short-lived, disposable one-off workspaces.
- **Proxy run**: How—the engineer delivers only file changes, the PM commits mechanically, and the verifier runs verification on the engineer's behalf in a clean workspace, writing the output and exit code to disk. Cost and risk—the engineer loses the feedback loop and rework gets slower; evidence attribution must be stated clearly: the engineer **must not** claim to have run tests or give an exit code it did not produce, and the report must explicitly mark "not self-checked", otherwise it violates Iron Law One of the protocol (the engineer's self-report is not evidence / evidence must be reviewable). Applicable scenario—the host cannot open up Bash, or organizational policy forbids headless execution of write commands.
- **External orchestrator proxy run** (optional): How—after the engineer finishes, the orchestrator commits mechanically and runs `verify.sh` on the engineer's behalf, writing the complete output and exit code back to `$ROOT/.delegate/<TASK-ID>/evidence/` for the engineer to read in the next round. Cost and risk—an extra layer of scripts and state synchronization; the returned results still must be re-run by the verifier. Applicable scenario—batch dispatch of multiple tasks, needing unified collection of exit codes.

### Session banner (optional)

On the first session where the agent adopts this protocol, it may print the contents of
[`docs/welcome.txt`](../docs/welcome.txt) **once**, inside a single fenced code block.

- once per session only — not on every turn;
- keep it inside the code block, or the art wraps and turns into noise;
- it is a greeting, not a status report; nothing in the protocol depends on it.

## Waiting and Resuming

### Normal path

1. **Agent / Task subagent**: This tool call in the parent session blocks until the subagent finishes; the return value is the resumption point. This is the most reliable "completion callback" in interactive Claude Code.
2. **`claude -p`**: Process exit is the completion signal. When run in the foreground, continue to the next round after the command returns; when run in the background, hand it to an external orchestrator to wait for the process and start verification.
3. After resuming, first read the end of the result file, the exit code, and the evidence index, then decide on verification or rework.

### Background and waking

- The Bash tool's `run_in_background` returns a shell ID, but Claude Code **does not guarantee** that after the parent session ends its round it will wake the model with "background process finished" as a new message. If the round ends, there may be no automatic resumption at all.
- Therefore:
  - When background execution is needed, prefer to have an **external orchestrator** manage it: a script starts `claude -p` and uses shell `wait` or the process exit event to trigger the next step; the next step can start another `claude -p` and pass in the handoff file.
  - Or use a synchronous Agent call and do not end the round.
  - Treat a background task as having a callback only when the current host explicitly delivers a completion notification; otherwise write `capability.completion_callback: unsupported` in `RUN.md`.
- Hooks (such as `Stop`, `SubagentStop`, `Notification`) can call external scripts, but a hook **will not by itself resume a model turn that has already ended**; it is suitable for triggering an external orchestrator or writing a wake file.
- Manual recovery: read `RUN.md` and the handoff; check whether the process is still alive; continue from on-disk state with `claude --resume <session-id>` or a new session. Do not assume the previous round completed.
- **Polling forbidden**: do not use `sleep` loops, repeated `BashOutput` queries, or repeated log reads to "wait" for background tasks. This violates V-1.

## Context Budget

### How to read it

- The `/context` command is user-facing and shows current context usage; **the model cannot reliably read the remaining percentage programmatically**, and cannot treat it as an automatic threshold signal.
- `claude -p --output-format json` gives the usage of this run (input/output tokens, etc.) at the end. This is a **statistic after the run ends**, not real-time remaining budget during the run.
- Subagents have independent contexts; the parent session cannot see a subagent's real-time token consumption.

### How to degrade when it cannot be read

1. Adopt phase checkpoints: after completing each AC/phase, write `RUN.md` and a handoff draft.
2. Use `--max-turns` (not listed in `claude --help`, but parses in practice) to limit the size of a single run; when the limit is reached, write to disk and switch to a new session.
3. Proactively change shifts at phase boundaries: do not wait for automatic compaction to happen. Summaries after automatic compaction are lossy; when resuming, re-read the spec, backlog, and evidence.
4. The context policy thresholds (60% plan, 75% execute, 85% stop taking new work) can only serve as **human estimates** in Claude Code; if they cannot be read, hand off early.
5. Record `capability.context_remaining: unsupported` or `estimated`; do not fabricate precise values.

## Known Unsupported Capabilities

- **Cross-turn background completion wake**: there is no built-in guarantee that "a finished session is automatically woken when a background task ends"; the `run_in_background` shell ID is not a completion callback.
- **Model-readable real-time context remaining**: `/context` is a human interface; JSON usage is available only after the run ends.
- **Filesystem-level read-only**: tool whitelists and permission modes restrict tool calls, not all read/write paths; the verifier may still read sensitive files. When strong isolation is needed, use a container, a read-only mount, or a separate user.
- **Subagents as a security boundary**: a subagent is not a sandbox for untrusted code; it may inherit part of the parent session's permissions and environment. Do not use subagents to execute untrusted code.
- **Built-in persistent queue/scheduler**: there is no cross-session backlog and lock; scheduling is maintained by files (such as `references/backlog.md`).
- **Automatic worktree lifecycle management**: creation, cleanup, and locking all require manual work or external scripts.
- **Stable contract for nested subagents**: usable depth and behavior change with version/configuration; you cannot assume dispatch works at any level.
- **Hook resuming a session**: hooks can trigger external actions, but cannot "wake up" a conversation that has already ended for you.
- **Bash commands that require approval under headless `-p` are rejected outright**: `-p` has no approval responder, so commands that need approval do not hang waiting but fail immediately with `This command requires approval` (ending with `error_max_turns` after retries are exhausted). `--permission-mode acceptEdits` covers only file edits, not Bash commands with write side effects (`git add` / `git commit`, `touch`, test scripts that write temporary files): the engineer therefore cannot run `verify.sh` if it writes temporary files, nor `git add/commit`; read-only commands (`echo`, `git log`) still execute. There is also a working-directory boundary independent of the permission mode; crossing it reports `Claude Code may only create or modify files in the allowed working directories for this session: '<cwd>'`. (PM tested on Claude Code 2.1.251 on 2026-10-18.)
