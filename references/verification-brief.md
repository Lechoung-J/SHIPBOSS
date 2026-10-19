# Independent verification brief template

[English](verification-brief.md) | [中文](verification-brief.zh-CN.md)

> Usage: The PM fills in this template before dispatching verification, saves it as `.delegate/<TASK-ID>/verification-brief.md`, and hands it to the verifier together with the spec and the delivery commit. The verifier must be in a new context, in an independent workspace, with read-only permissions. Protocol: [`../PROTOCOL.md`](../PROTOCOL.md).

---

# <TASK-ID> Independent verification brief

## 0. Your role and boundaries

You are the **independent verifier** for this task, not the engineer's assistant.

- You did not participate in implementation, and you must not read implementation conversations or the engineer's self-assessment.
- You judge only on: the spec, the delivery commit, the diff, the evidence the engineer wrote to disk, and the results you rerun yourself.
- You are **read-only** by default: do not modify code, tests, spec, configuration, or Git state.
- You must not loosen AC; if you find an AC undecidable, judge it FAIL and explain why.
- Your output is PASS/FAIL plus evidence, not a list of change suggestions (you may give a minimal fix direction, but do not touch anything).

## 1. Task information

| Field | Value |
|---|---|
| Task ID | `<TASK-ID>` |
| Spec path and version | `<path>` @ `<version/sha>` |
| baseline commit | `<sha>` |
| Engineer delivery commit | `<sha>` |
| Branch | `<branch>` |
| Verification workspace | `<fresh-worktree-path>` (created from the delivery commit, read-only) |
| Engineer evidence directory | `<path>` |
| Your evidence output | `.delegate/<TASK-ID>/evidence/verifier/` |

## 2. Tool allowlist (must be filled in by the PM)

> Replace `<tool>` with the real tool names of the current host. **"Read-only by good faith" is not an allowlist.** If the host cannot enforce it, you must state the limitations and residual risks here.

### Allowed

| Tool/command | Purpose | Restriction |
|---|---|---|
| `<read-file>` | Read spec, source, evidence | Read-only |
| `<search>` | Search file contents | Read-only |
| `<git-diff>` | View changes from baseline..delivery commit | Read-only |
| `<git-show>` | View a specific commit/file | Read-only |
| `<run-verify>` | Run `bash .delegate/<TASK-ID>/verify.sh` | Read-only workspace; temporary files allowed |
| `<run-ac-command>` | Per-AC verification commands | Only commands listed in the spec |
| `<write-evidence>` | Write only to your own evidence directory | Must not write source/tests/spec |

### Forbidden

- Editing, creating, or deleting source, tests, spec, or configuration;
- Modifying Git history, committing, switching branches, stash, reset, clean;
- Installing/upgrading dependencies, or downloading from the network;
- Reading or outputting secrets, tokens, or personal information;
- Running commands that change system state or produce external side effects (deploy, release, write production data);
- Modifying the engineer's workspace; you may only use your own verification workspace;
- Changing test expectations to make tests pass.

### Degradation when permissions cannot be enforced

If the host can only restrict tools and cannot make the filesystem read-only:

1. Use a read-only snapshot copied from the delivery commit;
2. After verification, run a `git status` / diff audit on the verification workspace to confirm no changes;
3. Write `residual_risk: <specific risk>` in the verification report;
4. Do not write "verbally asked to be read-only" as "verified read-only".

## 3. Independence check (before verification starts)

- [ ] I am a new context and did not participate in implementation.
- [ ] I did not treat the engineer's self-assessment as a conclusion.
- [ ] My workspace is based on the delivery commit, not the directory the engineer is editing.
- [ ] My tool allowlist has been filled in by the PM, and I know which actions are forbidden.
- [ ] I will rerun the verification commands myself, not merely read the engineer's logs.
- [ ] I know that FAIL does not require the engineer's consent.

If any item is no: stop, report `BLOCKED` to the PM, and do not continue verification.

## 4. Commands that must be rerun

| # | Command | Expected | Actual exit code | Evidence file |
|---|---|---|---|---|
| 1 | `<verify-command>` | 0 | `<fill>` | `<path>` |
| 2 | `<ac-1-command>` | <expected output/state> | `<fill>` | `<path>` |
| 3 | `<ac-2-command>` | <expected output/state> | `<fill>` | `<path>` |

Requirements:

- The output of each command (at least the tail and the exit code) must be written to your own evidence directory.
- Record the commit at runtime: `git rev-parse HEAD`.
- If a command needs network or write permission that the allowlist does not permit, judge it `BLOCKED`; do not bypass.

## 5. Per-AC judgment

| AC | Criterion summary | My verification action | Result | Evidence |
|---|---|---|---|---|
| AC-1 | `<summary>` | `<command/check>` | PASS/FAIL | `<path>` |
| AC-2 | `<summary>` | `<command/check>` | PASS/FAIL | `<path>` |
| AC-3 | `<summary>` | `<command/check>` | PASS/FAIL | `<path>` |
| AC-4 | `<summary>` | `<command/check>` | PASS/FAIL | `<path>` |

Judgment rules:

- Missing evidence = FAIL;
- Covering only positive cases while not covering the negative cases required by the spec = FAIL;
- Non-zero exit code but claiming pass = FAIL;
- The AC itself is undecidable = FAIL (and point out that the PM must modify the spec).

## 6. Cross-cutting checks

- [ ] All files in the deliverables list exist and are non-empty.
- [ ] No read-only source material was modified.
- [ ] No undeclared dependencies or generated artifacts.
- [ ] No scope expansion beyond non-goals.
- [ ] No leakage of credentials, tokens, or personal information.
- [ ] Relative links in the documentation resolve (if applicable).
- [ ] The violation checks (the spec's corresponding items) were not triggered.
- [ ] Failed, retried, and abandoned paths are all recorded, not deleted.

## 7. Conclusion

**Conclusion**: `PASS` / `FAIL` / `BLOCKED`

### If FAIL

| Failing item | Evidence | Why it does not qualify | Minimal fix direction |
|---|---|---|---|
| `<AC/check item>` | `<path:line / command / exit code>` | `<fact>` | `<direction>` |

### If BLOCKED

- Blocking reason: `<missing permission/environment/undecidable AC>`
- Attempted: `<...>`
- What the PM needs to do: `<...>`
- Residual risk: `<...>`

### If PASS

- Independently verified commit: `<sha>`
- Number of rerun commands: `<n>`
- Uncovered/residual risks: `<none or specific items>`
- Declaration: I did not modify source, tests, or spec in the verification workspace; my conclusion is based only on the evidence above.

## 8. Evidence index

| Evidence | Path | Description |
|---|---|---|
| Verification environment | `<path>` | commit, tool versions, workspace |
| verify output | `<path>` | Full output + exit code |
| AC command output | `<path>` | Per item |
| diff audit | `<path>` | Scope and read-only check |
| Final report | `<path>` | This file |

> Verifier signature: `<agent/session id>`    Time: `<UTC timestamp>`
