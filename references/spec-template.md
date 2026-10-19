# spec template (`TASK.md`)

[English](spec-template.md) | [中文](spec-template.zh-CN.md)

> Usage: Copy this template to `.delegate/<TASK-ID>/TASK.md` and replace all `<...>`. After writing, self-check: can a stranger engineer start work by reading only this? Can a stranger verifier score it item by item by reading only this? Protocol: [`../PROTOCOL.md`](../PROTOCOL.md).

---

# <TASK-ID> <one-line title>

## Intent (the boss's original words)

> <Quote verbatim; do not rewrite. Preserve tone and trade-offs.>

## What success looks like

<Describe the observable final state in 2–4 sentences. Do not use undecidable words such as "high quality".>

## Repository and baseline

- Absolute path: `<repo-absolute-path>`
- Branch: `<branch>`
- baseline commit: `<sha>`
- Stack: `<stack / runtime / package manager>`
- Test command: `<command>`
- Workspace: `<worktree-path-or-rule>`
- Read-only source material: `<paths>`
- Dispatch command record: `.delegate/<TASK-ID>/dispatch.log`

## Source material (read-only; do not modify)

| File/directory | Purpose | Allowed operations |
|---|---|---|
| `<path>` | `<purpose>` | Read-only |
| `<path>` | `<purpose>` | Read-only |

## Deliverables

```
<repo>/
├── <path>        # <one-line purpose>
├── <path>        # <one-line purpose>
└── <path>        # <one-line purpose>
```

Requirements:

- Every file exists and is non-empty;
- Do not create files outside the list unless the spec explicitly allows it;
- Do not introduce undeclared dependencies.

## Required content

1. <Hard requirements for file content, e.g. "contains section X", "contains table Y">
2. <...>

## Acceptance criteria (AC)

> Every AC must be decidable by a command, an exit code, or an explicit observable result. Adjectives are forbidden.

| ID | Criterion | Verification method |
|---|---|---|
| AC-1 | <decidable criterion> | `<command>`, exit code 0 |
| AC-2 | <decidable criterion> | Check whether `<file>` contains `<exact text>` |
| AC-3 | <decidable criterion> | `<command>` + manual check of `<observable>` |
| AC-4 | <boundary/regression criterion> | `<command>`; negative cases must also be covered |

Supplement:

- Verification commands must be runnable from a clean state in the verification workspace.
- If a `verify.sh` is provided, it must be executable (`bash <path>`), exit code 0 means all green, and failures must print the specific failing items.
- The verifier must rerun it personally, not merely read the engineer's log.

## Explicit non-goals

- <thing not to do 1>
- <thing not to do 2>
- <thing not to do 3>

## Constraints

- <directories/files that must not be modified>
- <dependencies that must not be introduced>
- <performance/compatibility/security boundaries>
- <platform or version limits>
- <credential and privacy requirements>

## Reporting requirements

After completion, the engineer must provide:

1. **What changed**: one sentence per file;
2. **Verification evidence**: the full verification command, exit code, output path on disk, and delivery commit;
3. **Trade-offs**: what was dropped or simplified from the original requirements, and why;
4. **Risks**: unverified items, known limitations, and matters that need a decision from the boss/PM;
5. **Reproduction**: the shortest steps from baseline to the current commit.
6. **When the host cannot self-check**: if the host does not allow the engineer to execute commands, the verification evidence is produced by the verifier or an external orchestrator; the engineer must mark each item "not self-checked", must not fabricate exit codes, and must point to the limitation notes in the relevant `platforms/*.md`.

Write the report to `.delegate/<TASK-ID>/evidence/engineer-report.md`, and include a one-page summary in the completion message. Format: [`report-template.md`](report-template.md).

## Handoff and stopping

- If the stage ends, context is insufficient, or you are stopped, write a handoff file per [`handoff.md`](handoff.md);
- The handoff must include the commit, workspace, unfinished items, failure evidence, and exact reproduction commands;
- Completing a handoff does not mean acceptance passed.

## Notes

- <anything easy to misread>
- <known pitfalls and past incidents>
- <whether additional approval is needed>
