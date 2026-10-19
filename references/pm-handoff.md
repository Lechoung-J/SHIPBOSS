# PM shift change and context-budget strategy (pm-handoff)

[English](pm-handoff.md) | [中文](pm-handoff.zh-CN.md)

> Purpose: When the PM needs to hand the **decision state** to the next PM because of context budget, end of shift, or a long-running task. This differs from the engineer's technical handoff; see [`handoff.md`](handoff.md). Protocol: [`../PROTOCOL.md`](../PROTOCOL.md).

---

## 1. Context budget strategy

### 1.1 Thresholds

| Remaining/used | Action | Description |
|---|---|---|
| About 60% used | **Plan the handoff** | Create a handoff draft and confirm all state is on disk |
| About 75% used | **Execute the handoff** | Complete this document, start a new PM context, stop taking new work |
| About 85% used | **Hard stop** | Dispatch no new tasks; only wrap up, persist, and hand off |

Thresholds are policy, not precise measurements. When the context budget is unobservable, use the degradation in 1.2.

### 1.2 Degradation when the budget cannot be read

- At each stage boundary (spec complete, dispatch, verification, reporting), write `RUN.md` and a handoff draft once.
- After every N tool turns or one AC, check whether a shift change is needed; N depends on task size; 10–15 is recommended.
- Split long tasks into multiple short sessions; read the on-disk state at the start of each session.
- Record `capability.context_remaining: unsupported | estimated`; do not fabricate percentages.
- Prefer handing off early over being forced to hand off after compaction or forgetting.

### 1.3 Must be persisted before the handoff

- spec and version, AC status;
- backlog snapshot and in-flight tasks;
- all decisions and reasons;
- verification conclusions and evidence index;
- open risks and next steps.

A summary produced by automatic compaction cannot replace these files.

---

## 2. PM handoff template

# <TASK-ID / project> PM handoff

## 2.1 Basic information

| Field | Value |
|---|---|
| Project/task | `<ID / name>` |
| Reason for shift change | Context threshold / end of shift / long-running task / other |
| Current time (UTC) | `<timestamp>` |
| Handing over / taking over | `<id>` / `<id>` |
| Current context estimate | `<percentage / unreadable>` |
| Source of truth | `RUN.md`, backlog, spec, evidence |

## 2.2 Boss intent and definition of success

- Boss's original words: > <quote>
- What success looks like: <observable final state>
- Priority: <P0/P1/...; what can be deferred>
- non-goals: <things explicitly not done>
- Budget/time constraints: <...>

## 2.3 In-flight task snapshot

| Task | Spec version | Status | Owner | Workspace / branch | Delivery commit | Evidence index | Next step |
|---|---|---|---|---|---|---|---|
| `<ID>` | `<v/sha>` | `intake/spec-ready/scheduled/dispatched/verifying/rework/reported/blocked` | `<owner>` | `<path>` | `<sha>` | `<path>` | `<action>` |
| `<ID>` | `<v/sha>` | ... | ... | ... | ... | ... | ... |

Status must match the backlog; when they are inconsistent, the on-disk evidence prevails and must be corrected.

## 2.4 Decisions made

| # | Decision | Reason | Rejected option | Scope | Evidence/link |
|---|---|---|---|---|---|
| D-1 | `<decision>` | <why> | <alternative> | <tasks/files> | `<path>` |
| D-2 | `<decision>` | <why> | <alternative> | <tasks/files> | `<path>` |

Requirement: record **why**, not just the conclusion; especially record rejected options to avoid re-discussing them on the next shift.

## 2.5 Verification status and evidence

| Task | Verification conclusion | Verifier | Verification report | Failing items | Rework status |
|---|---|---|---|---|---|
| `<ID>` | PASS/FAIL/BLOCKED | `<id>` | `<path>` | `<AC>` | `<status>` |

- Only an independent verification PASS can enter `done`;
- FAIL tasks must carry failure evidence and a minimal fix direction;
- Do not "reinterpret" a FAIL as a PASS in a new shift.

## 2.6 Open questions and risks

| Question/risk | Level | Impact | Current mitigation | Who needs to decide | Deadline condition |
|---|---|---|---|---|---|
| `<issue>` | High/Medium/Low | `<...>` | `<...>` | Boss/PM/engineer | `<date/condition>` |

## 2.7 Next steps (in order)

1. <action 1>: <completion condition>, <owner>
2. <action 2>: <completion condition>, <owner>
3. <action 3>: <completion condition>, <owner>

## 2.8 What not to do

- Do not redefine confirmed AC (unless the spec is formally changed and recorded);
- Do not trust "last time it was said to have passed" without evidence;
- Do not reuse the engineer's mutable workspace for verification;
- Do not pretend during execution that the host supports capabilities it does not have;
- Do not clean up failure evidence or historical decisions.

## 2.9 Takeover confirmation

After reading only this document and the disk, the new PM should be able to answer:

- [ ] Why are we doing this?
- [ ] Where are we now?
- [ ] What counts as done?
- [ ] What is the next step?
- [ ] What is the biggest risk?

And spot-check:

- [ ] The backlog status matches this document;
- [ ] All evidence paths resolve;
- [ ] The workspace/commit of in-flight tasks can be located;
- [ ] There are no "verbal decisions" that were not persisted.

Signature / time: `<id>` / `<UTC timestamp>`

---

## 3. Engineer handoff vs PM shift change

| Dimension | Engineer handoff ([`handoff.md`](handoff.md)) | PM shift change (this document) |
|---|---|---|
| Purpose | Continue implementation | Continue deciding and coordinating |
| Content | commit, commands, failure evidence, unfinished code | intent, schedule, decisions, risks, evidence index |
| Granularity | Single task, file/AC level | Cross-task, project level |
| Success criterion | Can reproduce and continue writing code | Can continue scheduling, verifying, and reporting without losing context |
| Effect on AC | None | None (a shift change must not be used to change AC) |
