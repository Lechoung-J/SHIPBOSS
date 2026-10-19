# Task queue and scheduling (backlog)

[English](backlog.md) | [中文](backlog.zh-CN.md)

> Purpose: Give "what to do, what to do first, and where we are now" a single source of truth. Chat history is not a backlog. Protocol: [`../PROTOCOL.md`](../PROTOCOL.md).

---

## 1. Task fields

| Field | Required | Description |
|---|---|---|
| `id` | Yes | Unique ID; `<prefix>-<number>` is recommended, e.g. `ABC-001`; never reused after creation. |
| `title` | Yes | A one-sentence, decidable title. |
| `intent` | Yes | The boss's original words, or a link to them. |
| `priority` | Yes | `P0` (blocking) / `P1` (current) / `P2` (queued) / `P3` (deferrable). |
| `status` | Yes | See the status definitions in section 2. |
| `spec` | Yes | Spec path and version/commit. |
| `ac_count` | No | Number of ACs, to help check whether they are decidable. |
| `dependencies` | Yes | IDs of dependent tasks; write `none` if there are none. |
| `owner` | Yes | Current owner (PM/engineer). |
| `workspace` | Yes | Absolute path of the isolated workspace. |
| `branch` | Yes | Branch name. |
| `baseline_commit` | Yes | Starting baseline. |
| `delivery_commit` | No | Engineer delivery commit. |
| `verification` | No | Verification conclusion and report path. |
| `evidence` | No | evidence directory. |
| `blocked_reason` | No | When blocked, the specific reason and owner are mandatory. |
| `updated` | Yes | UTC timestamp. |
| `notes` | No | Trade-offs, risks, links. |

## 2. Status definitions

| Status | Meaning | Entry condition | Allowed next steps |
|---|---|---|---|
| `intake` | Intent received; no decidable spec yet | Boss provides the requirement | `spec-ready`, `blocked` |
| `spec-ready` | Spec complete; ACs decidable | Spec self-check passed | `scheduled`, `blocked` |
| `scheduled` | Scheduled, waiting for dispatch | Dependencies satisfied, workspace available | `dispatched`, `blocked` |
| `dispatched` | Engineer executing | Workspace + brief + baseline ready | `verifying`, `blocked`, `rework` |
| `verifying` | Independent verification in progress | Delivery commit + engineer evidence | `reported`, `rework`, `blocked` |
| `rework` | Verification FAIL or scope change | Failing items and fix direction clear | `dispatched`, `blocked` |
| `reported` | One-pager delivered to the boss | Independent verification PASS + one-pager | `done`, `rework` |
| `done` | Complete | Boss accepts + independent verification PASS | Terminal state |
| `blocked` | Paused | Specific reason, owner, and unblock condition exist | Return to the pre-blocked state |

**Only an independent verification PASS can enter `reported`/`done`.** The engineer's self-report cannot advance the status.

## 3. Scheduling rules

1. **No spec, no scheduling**: a task whose ACs are not decidable cannot enter `scheduled`.
2. **No baseline, no dispatch**: every task has a fixed baseline commit.
3. **One workspace per task**: at any moment, a mutable workspace belongs to only one active task.
4. **WIP limit**: the number of tasks simultaneously in `dispatched` + `verifying` must not exceed the team's capacity to verify in parallel; 1–2 is the default recommendation; fewer is better than more.
5. **Priority only determines order, not a time commitment**: `P0` may take resources first, but it does not automatically lower acceptance standards.
6. **Dependencies must be completed or explicitly lifted first**: do not "work while waiting" without recording it.
7. **Rework does not automatically jump the queue**: rework is rescheduled by failure severity and dependency relationships; AC must not be lowered to meet a schedule.
8. **A block must be liftable**: `blocked` must state the reason, owner, and unblock condition; without these three, it is not a legitimate block.
9. **Status changes leave a trace**: update `updated` and one line of `notes`; do not delete historical tasks.
10. **Definition of done**: `done` = independent verification PASS + boss accepts + evidence index resolves.

## 4. Queue template

| ID | Title | Priority | Status | spec | Dependencies | Owner | Workspace | baseline | Delivery commit | Verification | Updated |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `ABC-001` | <title> | P1 | `scheduled` | `<path>@<sha>` | none | `<owner>` | `<path>` | `<sha>` | - | - | `<UTC>` |
| `ABC-002` | <title> | P2 | `blocked` | `<path>@<sha>` | ABC-001 | `<owner>` | - | - | - | - | `<UTC>` |

### Block records

| Task | Blocking reason | Owner | Unblock condition | Updated |
|---|---|---|---|---|
| `ABC-002` | <specific fact> | `<owner>` | <observable condition> | `<UTC>` |

### Decision log (optional, project level)

| # | Decision | Reason | Affected tasks | Time |
|---|---|---|---|---|
| D-1 | <decision> | <why> | ABC-001 | `<UTC>` |

## 5. Example of a complete task lifecycle

```text
intake
  -> write spec (ACs decidable)
  -> spec-ready
  -> register in backlog, fix baseline, create worktree
  -> scheduled
  -> dispatch engineer, run in background, end this round
  -> dispatched
  -> engineer delivers commit + evidence
  -> a verifier in a new context reruns in an independent read-only workspace
  -> verifying
      -> FAIL: write rework items -> rework -> dispatched (new commit)
      -> PASS: one-pager report -> reported
  -> boss accepts -> done
```

## 6. Scheduling self-check

- [ ] Every active task has a unique ID, spec version, and baseline commit.
- [ ] No two active tasks share the same mutable workspace.
- [ ] Every `blocked` has a reason, owner, and unblock condition.
- [ ] Every `reported` has an independent verification report and a one-pager.
- [ ] No AC or test expectation was modified in order to pass.
- [ ] No historical task was deleted or overwritten.
- [ ] Queue status is consistent with the on-disk `RUN.md` and evidence.

---

## 7. Relationship to handoff

- Engineer replacement: hand off within the task per [`handoff.md`](handoff.md); the backlog only updates `owner` and `notes`.
- PM shift change: hand off per [`pm-handoff.md`](pm-handoff.md); the backlog must be referenced as a snapshot.
- Handoff does not change the status definitions; status can only be advanced by evidence.
