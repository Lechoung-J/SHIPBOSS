# Roles, context and observed state

[English](roles-context.md) | [中文](roles-context.zh-CN.md)

The PM assigns responsibilities. Role, tool, process, provider, model and visual seat are separate attributes.

## Responsibilities

| Role | Responsibility | Context |
|---|---|---|
| Boss | Intent, feedback, priorities and acceptance | Natural conversation with the PM |
| PM | Clarify, dispatch, collect and report | Retains project decisions; its self-check is not independent verification |
| Engineer | Implement, debug, self-test, repair and deliver | Retains the same implementation lineage; resume the explicit engineer session by default |
| Verifier | Independently check a specific delivered revision | A fresh context for each formal verification round; inherits neither PM nor engineer chat |
| Scribe | Extract ideas, constraints, decisions and feedback; merge with PM notes | Checks original sources; cannot grant PASS or change global skills on its own |

Fresh context does not mean missing information. Give the verifier requirements, constraints, ACs, baseline, delivery revision and necessary environment notes.
Do not provide implementation chat, self-defence or self-assessment as the premise for verification.
A different model can offer another perspective; changing models alone does not establish independence.

## Engineer continuity

A new task may start a new session. Subsequent work on that task resumes its explicit session ID, retaining the workspace and ruled-out approaches.
Before resuming, confirm the original writer has finished or stopped; do not create competing writers.
Do not guess the engineer with `resume --last`.

Write a minimal handoff when replacing the engineer, when the host cannot resume, or when a context transition is actually needed. Record the old session, successor, revision, unfinished work and necessary evidence.
A continuing engineer updates existing state; it does not need a new handoff document for every step.
Keeping implementation context is compatible with independent verification. The verifier is the context that must be separated from implementation discussion.

## Independent verification

- Record `role=verifier`, `context_policy=fresh`, the new session ID and target revision at dispatch.
- The verifier session must not be the PM session, engineer session or a fork of either. Renaming a role does not suffice.
- Rerun checks against an independent snapshot. Dependency preparation, builds and tests may write to allowed disposable outputs; delivered source, lockfiles, tests and requirements remain unchanged.
- A FAIL returns to the original engineer. Formal verification of a repaired revision uses a new verification context. The original reviewer may clarify its evidence, but that does not replace verification of the new revision.
- State limits when the host can only record declarations of isolation. A declaration is not cryptographic proof.

## Dispatch records and the observer

Reuse the launch record to associate `task_id`, `role`, `owner_session`, `context_policy`, engineer lineage, actual `job_id/agent_id` and target revision.
Generate these fields with the dispatch; do not make the Boss fill in another form.

An assignment establishes responsibility. Actual start, activity and completion require host events or a managed execution receipt as separate evidence.

| What happened | Display |
|---|---|
| PM reads files, builds or self-checks | PM working; no invented engineer |
| A registered engineer starts, resumes or tests | Its stable engineer seat is active; self-testing stays engineering |
| Engineer process succeeds | Implementation delivered, verification pending; verifier remains absent until dispatched |
| Fresh verifier actually starts | Verifier present, tied to the reviewed revision |
| Verification process exits | Execution ended; no PASS without an explicit verdict |
| Verification FAIL / PASS | Rework / verified pending PM report; neither means automatic Boss acceptance |
| PM has a real unanswered question | Question mark only in that room; cleared on answer or cancellation |
| Scribe starts / finishes | Temporary entry / exit; installing a recorder tool does not make it permanently active |
| Missing assignment, stale connection or missing events | State unknown; do not invent a role, completion or idleness |

An ordinary background command, research helper or test process is not automatically an engineer or verifier.
One subagent tool can host different roles; different CLIs can host the same role.

## Preserve the existing experience

One activated project per room, with a stable project ID. Dim idle rooms; label unknown observations.
Local time continues to control daylight, dusk and night lighting.
Boxes count distinct skills actually used in that project that day; a directory's existence is not usage evidence.
Start the observer with skill activation without taking focus; close it when asked. Observer failures must not stop project work.

## Feedback into the project

The scribe extracts ideas, specifications, decisions and feedback from natural conversation, retaining sources and uncertainty.
The PM inventories all records at useful checkpoints or on request, separating applied, pending and unverified items.
Discussion, a matching document or an existing commit alone cannot prove completion; tie it to observable delivery evidence.
Try reusable methods inside the project first; consider global skills at the retrospective. Use recorded costs and actual benefits to keep, rewrite or remove rules, rather than fixed counts.

## Local beta integration

The Python runtime, registration commands and tests are described in the [observer runtime](../apps/observer/runtime/README.md).
Registrations and snapshots are local state, unpublished by default. This does not claim historical role mappings have been reconstructed for other projects.
These rules supersede the old mappings of background commands to engineers, subagents to verifiers, and keyword-based role guesses.
