# Engineer cross-stage handoff template (handoff)

[English](handoff.md) | [中文](handoff.zh-CN.md)

> Purpose: Within the same task, when the engineer switches stages, is stopped, lacks context, or is replaced, write the state that lets implementation continue to disk. **Completing a handoff does not mean acceptance passed.** Protocol: [`../PROTOCOL.md`](../PROTOCOL.md). A PM shift change is a different matter; see [`pm-handoff.md`](pm-handoff.md).

---

# <TASK-ID> Engineer handoff

## 1. Basic information

| Field | Value |
|---|---|
| Task ID | `<TASK-ID>` |
| Spec path and version | `<path>` @ `<version/sha>` |
| baseline commit | `<sha>` |
| Current commit | `<sha>` |
| Branch | `<branch>` |
| Absolute workspace path | `<path>` |
| Handoff reason | Stage switch / stopped / insufficient context / replacement |
| Handoff time (UTC) | `<timestamp>` |
| Handing over / taking over | `<id>` / `<id>` |

## 2. Current state

- Overall status: `in progress` / `blocked` / `pending verification`
- One-sentence status: <fact, not feeling>
- Completed:
  - [ ] <item 1> (commit / evidence: `<path>`)
  - [ ] <item 2> (commit / evidence: `<path>`)
- In progress:
  - [ ] <item>: current progress, what remains
- Not started:
  - [ ] <item>

## 3. AC progress

| AC | Status | Evidence | Notes |
|---|---|---|---|
| AC-1 | Completed / In progress / Not started / Failed | `<path>` | `<...>` |
| AC-2 | Completed / In progress / Not started / Failed | `<path>` | `<...>` |
| AC-3 | Completed / In progress / Not started / Failed | `<path>` | `<...>` |

## 4. Changed files

| File | Status | Description |
|---|---|---|
| `<path>` | Committed / Uncommitted / Added / Deleted | <purpose of the change> |
| `<path>` | Committed / Uncommitted / Added / Deleted | <purpose of the change> |

Uncommitted changes:

```text
<raw output of git status --short>
```

If there are uncommitted changes, state clearly which must be kept and which are temporary files that can be discarded. **Do not use `git clean` or `reset --hard` to hide the state.**

## 5. Verification and failure evidence

### Commands already run

| # | Command | Exit code | Result | Output path |
|---|---|---|---|---|
| 1 | `<command>` | `<code>` | PASS/FAIL | `<path>` |
| 2 | `<command>` | `<code>` | PASS/FAIL | `<path>` |

### Failures and ruled-out paths

| Failure | Exit code/symptom | Root cause (known/unknown) | Ruled-out approaches | Evidence |
|---|---|---|---|---|
| `<failure>` | `<...>` | `<...>` | `<...>` | `<path>` |

If there are no failures, write "none"; do not omit this section.

## 6. Exact reproduction

The person taking over should be able to run this in a clean environment:

```bash
# 1. Enter the workspace and verify the commit
cd <workspace>
git rev-parse HEAD        # expect <sha>

# 2. Reproduce the current state
<command>
# expect: <output / exit code>

# 3. Run the full verification
<verify-command>
# expect: <output / exit code>
```

Dependencies, environment variables, data preparation:

- <dependency versions / installation method>
- <environment variable names (names only, not values)>
- <test data location>

## 7. Next steps (in order)

1. <action 1>: <completion condition>
2. <action 2>: <completion condition>
3. <action 3>: <completion condition>

## 8. Open questions and risks

| Question/risk | Impact | Recommendation | Who needs to decide |
|---|---|---|---|
| `<...>` | High/Medium/Low | `<...>` | PM / boss / engineer |

## 9. Prohibitions / pitfalls

- Do not modify `<path>` (read-only source material);
- Do not change AC or test expectations;
- Do not use `<deprecated command>`;
- The known `<trap>` causes `<failure>`;
- Do not clear evidence or delete failure logs.

## 10. Takeover confirmation

Before continuing, the person taking over must:

- [ ] Verify that `git rev-parse HEAD` matches this document;
- [ ] Successfully run the reproduction commands in section 6;
- [ ] Read the failure evidence in section 5 and confirm there are no hidden failures;
- [ ] Confirm the workspace is not shared with the verifier;
- [ ] If this document is inconsistent with the on-disk state, update the handoff first, then continue.

Signature / time: `<id>` / `<UTC timestamp>`

---

## Usage rules

1. **Write to disk, not "see chat for details"**: the person taking over should be able to continue without reading the old conversation.
2. **The commit is the anchor**: every status description must correspond to a commit or an explicit workspace path.
3. **Failures must be recorded**: ruled-out paths and failure output are important handoff assets.
4. **A handoff is not verification**: do not write "verified and passed"; only the independent verifier can give a verification conclusion.
5. **Persist before handing off**: write test output, diffs, and status files to `evidence/` first, then write this document.
6. **Verify before taking over**: reproduce first, then change code; do not continue directly based on the narrative.
