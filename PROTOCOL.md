# SHIPBOSS Protocol

[English](PROTOCOL.md) | [中文](PROTOCOL.zh-CN.md)

> A platform-agnostic delegated build protocol: hand decidable requirements to a coding agent, and trade independent verification and traceable evidence for trustworthy delivery.

**Reader**: A human or agent taking on this process for the first time. This document is self-contained; you do not need to know any host-specific tool names.
**Goal**: A stranger can read only this document and be able to define requirements, dispatch work, wait, verify independently, manage context, and hand off when context runs low.

---

## 0. Terms and Scope

| Term | Meaning |
|---|---|
| task | A unit of work that can be delivered independently, with a unique ID. |
| spec | A file describing "what is wanted and what counts as done", usually `TASK.md`. |
| AC (acceptance criteria) | Acceptance criteria that can be judged one by one, each bound to a verification method. |
| evidence | Reviewable artifacts: commands, exit codes, output, diffs, commits, files, logs, reproduction steps. |
| workspace | An isolated directory where the engineer actually modifies code, usually a separate Git worktree. |
| verification workspace | An independent, read-only workspace used by the verifier, based on the commit delivered by the engineer, not the directory the engineer is editing. |
| wake | The mechanism by which the host, after a background task finishes, delivers the result back to the current agent session. |
| handoff | Writing the state needed to continue work to disk, so another agent or another shift can take over without loss. |

**Applicable**: Software work whose result can be described, verified, and executed in isolation. Includes documentation restructuring, migrations, fixes, filling test gaps, and release checks.
**Not applicable**: Work whose requirements cannot themselves be judged ("make it look a bit nicer"), work that requires multiple people to jointly edit the same state in real time, or work that can leave no evidence at all. When you encounter such work, first turn it into decidable work, then enter the process.

---

## 1. Role Division: Three Layers, Asymmetric

| Role | What it cares about | Information it holds | Decision authority | Hard prohibitions |
|---|---|---|---|---|
| **Boss** | What to do, whether it is worth it, when to stop | Intent, priorities, budget, final result | Accept/reject the final delivery; stop tasks; adjust priorities | Does not directly change the spec, does not directly direct the engineer to bypass the PM |
| **Product manager (PM)** | How to break it down, when to dispatch, whether it passes | All specs, schedule, verification conclusions, evidence index | Define and change ACs; schedule; dispatch; decide PASS/FAIL; initiate rework | Does not both implement and perform final verification within the same task; does not relax ACs in exchange for a pass |
| **Engineer** | How to implement | Its own spec, workspace, test output | Implementation approach; raise spec questions; submit deliverables | Does not change ACs; does not issue its own verification conclusion; does not hide failures |

### The three lines of asymmetry

1. **Information asymmetry**: The Boss reads only a one-page conclusion and an evidence index; the PM reads the spec and verification evidence; the engineer reads implementation details. No layer needs to copy all the context of the layer below.
2. **Authority asymmetry**: The Boss can stop the project, the PM can reject, and the engineer can only submit. **Whoever writes the code cannot approve their own code.**
3. **Context asymmetry**: The engineer's context is the dirtiest (source code, logs, trial and error), the PM's context should be the cleanest (spec, status, evidence pointers), and the Boss's context is the shortest (conclusion, risks, next step).

### Minimum division rules

- Within the same task, **the implementer and the final verifier must be two independent contexts**.
- Only the PM has the right to change ACs, and changes must leave a version and a reason.
- The engineer may challenge an AC, but may not interpret it into a looser version on their own.
- The Boss's acceptance does not replace independent verification; independent verification does not replace the Boss's judgment of "is it worth it".

---

## 2. The Two Iron Laws

### Iron Law One: The Engineer's Self-Report Is Not Evidence

"Done", "all tests passed", "should be fine" are not evidence. **Only reviewable artifacts are evidence.**

Qualified evidence satisfies at least:

- has a **specific command** or specific operation;
- has an **exit code** or a clear observable result;
- has an **output path on disk**, rather than merely being restated in conversation;
- can be tied to a **specific commit / file / line number**;
- another person can reproduce it on the same input.

Unqualified evidence:

- only a natural-language summary;
- only success fragments pasted, with no record of failure;
- only screenshots, with no copyable command or file;
- claims "I ran it" but has no output path or exit code;
- treats "the model thinks it passed" as a test result.

### Iron Law Two: Verification Must Be Independent

Verification is not asking the engineer to confirm again; it is re-judging by an **independent context** in an **independent workspace**.

Independence includes at least:

1. **Context independence**: The verifier did not participate in implementation, does not inherit the engineer's conversation context, and does not read the engineer's self-assessment as the basis for a conclusion (it may read their evidence).
2. **Workspace independence**: The verifier uses a fresh workspace or read-only snapshot of the commit delivered by the engineer, and does not share a mutable directory with the engineer.
3. **Read-only authority**: By default the verifier cannot change code, tests, or the spec, and cannot commit. When tests must be run, it may only execute commands on a whitelist.
4. **Tool whitelist**: When dispatching verification, the allowed tools and forbidden actions must be listed; "I will be careful to only read" does not count as independence.
5. **Re-execution**: The verifier must run the verification commands itself, not merely read the engineer's run records.

When the two iron laws conflict: **independence takes priority over speed, and evidence over fluent narrative.** When the host cannot provide some aspect of independence, the limitation and residual risk must be stated plainly in the status file; you may not pretend it has been achieved.

---

## 3. Decidable Violation Checks: What a Violation Looks Like

This section turns principles into observable judgments. **If you cannot point to a specific file, command, permission, or behavior, it does not count as a decidable violation.** The PM uses this table before dispatching, the verifier before issuing a conclusion, and the Boss during spot checks.

| # | Principle | Compliant behavior | What a violation looks like (observable) | Source of criterion |
|---|---|---|---|---|
| V-1 | End the round immediately after background dispatch and wait for the completion callback | The round ends after dispatch; the wake message brings back the task ID and result | **Repeatedly querying task status, using `wait:true`, sleep loops, repeatedly tailing logs**; or occupying the session idly after dispatch | Session records, number of task-status queries, command history |
| V-2 | The engineer's self-report is not evidence | The report includes commands, exit codes, output paths, commit | The report only says "done / tests passed / should work"; or only pastes success logs; or refuses to give reproduction commands | Report file, evidence directory |
| V-3 | Verification must be independent | New context + new workspace + read-only permission | The same agent both implements and verifies; the verifier operates in the engineer's workspace; the verifier inherits the implementation conversation | Dispatch records, worktree path, session ID |
| V-4 | Verification must have a tool whitelist | The brief lists allowed tools and forbidden actions | The brief only says "please verify"; no permission boundary; the verifier can write files freely | Verification brief, permission configuration |
| V-5 | The spec must be decidable | Every AC has a verification command or a clear observation method | ACs written as "optimize it", "better experience", "high code quality"; no verification method; the test command does not exist | Spec file |
| V-6 | Register before dispatch | The backlog has an entry, status, dependencies, spec version | Start work directly and file a ticket afterwards; multiple tasks fight over the same workspace; no baseline commit | Backlog, worktree list |
| V-7 | Context hygiene | Large output goes to disk; only conclusions and pointers are read | Paste entire logs, entire trees, or entire source sections into PM/Boss context; repeat full-text output; use conversation as the only storage | Session token growth, files on disk |
| V-8 | Failures must leave traces | Failed commands, exit codes, reasons, and retry counts are all recorded | Report only successes; delete failure logs; use "try again" to mask the root cause; do not record abandoned paths | Evidence, timeline |
| V-9 | Handoff relies on on-disk state | The successor can continue by reading files only | The handoff only says "going well, see chat"; no commit, no unfinished items, no reproduction commands | Handoff file |
| V-10 | Roles do not overstep | Engineer submits, PM judges, Boss decides | The engineer changes ACs or writes PASS themselves; the verifier changes code to make tests pass; the PM implements for the engineer and then verifies their own work | git diff, review records |
| V-11 | ACs are not relaxed because of failure | Rework the implementation, or the PM formally changes the spec with reasons | Delete failing ACs to pass, change test expectations, narrow the scope without recording it | Spec version diff, AC history |
| V-12 | Do not fake host capabilities | State supported/unsupported and the fallback in the status file | The host has no completion callback yet claims "it will wake automatically"; no read-only sandbox yet claims "the verifier is absolutely read-only" | Capability declaration, platform configuration |
| V-13 | Verification means re-running, not restating | The verifier executes the verification commands and keeps its own output | Issues PASS after only reading the engineer's test logs; does not look at exit codes; does not spot-check files corresponding to ACs | Verification evidence |
| V-14 | Scope is controlled | Deliverables match non-goals | Opportunistically refactoring unrelated modules; introducing undeclared dependencies; modifying read-only source material; expanding the workspace | Diff, dependency changes, file list |
| V-15 | Conclusions are traceable | Every PASS/FAIL points to evidence | Conclusions are only adjectives; no evidence links; failed items have no owner and no next step | Verification report |
| V-16 | Dispatch is traceable | `.delegate/<TASK-ID>/dispatch.log` appends, on each occasion, the complete command actually executed (host, all flags, cwd, baseline, time), so another person can reproduce it exactly | `.delegate/<TASK-ID>/dispatch.log` does not exist, or a record lacks cwd / baseline / all flags; a dispatch leaves only "dispatched / engineer is running"; chat records are used instead; multiple dispatches for the same task leave only the last entry; afterwards it is impossible to tell whether "can't run the tests" was due to missing flags, permission blocking, or insufficient resources | `dispatch.log`, session records, shell history |

**How to use**

- One violation stops the work; return to the most recent compliant state, and do not close it with "I'll be careful next time".
- A violation must be written as a task or a rework item, noting who fixes it and in which commit.
- For a new problem not covered by the table, add a row with the judgment criterion first, then continue; do not replace rules with tacit understanding.

---

## 4. Process: Intake → Write Spec → Register and Schedule → Dispatch → Independent Verification → One-Page Report → Rework

```
Intake
  └─> Write spec ──> Register and schedule ──> Dispatch ──> Independent verification ──PASS──> One-page report ──> Done
                                   ^                         │
                                   └──────── Rework <──FAIL────┘
```

### 4.0 Intake

**Input**: The Boss's intent, absolute repository path, branch, baseline commit, tech stack, test command, and explicit non-goals.

**Actions**:

- Write the intent verbatim, what success looks like, the repository, branch, baseline commit, and test command into the task status (e.g. `RUN.md`).
- Distinguish "blocking ambiguity" from "non-blocking ambiguity". Blocking ambiguity must be asked about; for non-blocking ambiguity, proceed with the most conservative interpretation and write the assumption into the spec.
- Confirm the read-only source material and the writable workspace to avoid accidental modifications.

**Exit condition**: You can state in one sentence "what it looks like when this is done successfully", and there is an executable test command or an equivalent verification method.

### 4.1 Write the spec

Use [`references/spec-template.md`](references/spec-template.md).

**Must include**:

- the intent verbatim and the success definition;
- repository, branch, baseline commit, tech stack;
- deliverable list (path + one-line purpose);
- how each AC is judged (command, exit code, observable result);
- non-goals (explicitly what not to do);
- read-only source material;
- reporting requirements.

**Exit condition**: A stranger engineer can start by reading only the spec; a stranger verifier can score item by item by reading only the spec. If not, the spec is not finished.

### 4.2 Register and schedule

Use [`references/backlog.md`](references/backlog.md).

**Actions**: Assign a unique task ID; record priority, dependencies, status, spec version, workspace, baseline commit, and owner; confirm that no two active tasks share the same mutable workspace.

**Exit condition**: No dispatch without a backlog entry; no work starts without a baseline commit.

### 4.3 Dispatch

**Actions**:

1. Create an isolated workspace from the baseline commit (recommended: `git worktree add`).
2. At dispatch, append the **complete command actually executed** to `.delegate/<TASK-ID>/dispatch.log`: at minimum the host / tool and entry point (e.g. `claude -p`, `codex exec`, a native host subagent), **all flags** (`--permission-mode`, `--allowedTools`, `--model`, `--output-format`, `--max-turns`, etc.), cwd / workspace path, baseline commit, and dispatch time. **Append, do not overwrite**; leave one entry for each dispatch or rework of the same task; **never write only "dispatched" or "engineer is running"**; **credentials (token / key / password) are never written to `dispatch.log`**—record only flags, paths, commits, and times.
3. Hand the spec, engineer brief, read-only material list, and evidence write paths to the engineer.
4. Dispatch in the background, then **end the round**; wait for the host's completion callback.
5. After waking, read only the final conclusion and evidence index, then proceed to verification.

**Rationale**: The host's flag combination directly determines whether the engineer can self-check and commit; without a record of the command, afterwards you can only guess—you cannot distinguish whether a failure was due to "missing configuration", "permission blocking", or "insufficient resources", nor can you reproduce the same dispatch.

**Standby discipline**:

- After dispatch, do not query status, do not `wait:true`, do not sleep in loops, do not repeatedly tail logs.
- When progress is needed, the engineer proactively writes a status file at agreed milestones, rather than the PM polling.
- When the host has no completion callback, the only options are foreground blocking execution, or handing off to an external orchestrator to wake on process exit; **you may not pretend a callback exists**.

**Exit condition**: The engineer has committed a locatable commit in the agreed workspace and written evidence to disk per the brief.

### 4.4 Independent verification

Use [`references/verification-brief.md`](references/verification-brief.md) to dispatch verification; when writing `verify.sh`, follow [`references/verification-scripts.md`](references/verification-scripts.md).

**Actions**:

1. Start a verifier in a **new context**; it is forbidden to inherit the implementation conversation.
2. Create a brand-new read-only workspace or snapshot based on the engineer's delivered commit; using the directory the engineer is editing is forbidden.
3. In the brief, list allowed tools, forbidden actions, commands that must be re-run, the AC list, and evidence requirements.
4. The verifier re-runs each item, recording its own exit codes and output; it also checks cross-cutting items such as the violation table, scope, non-goals, credential leakage, and link validity.
5. Give PASS/FAIL; FAIL must list, item by item, the ACs that failed, the evidence, and the minimum fix direction.

**Exit condition**: All ACs pass, and there is no decidable violation, and there is no undeclared scope expansion. If any one of these is not satisfied, it is FAIL.

### 4.5 One-page report

Use [`references/report-template.md`](references/report-template.md).

**Must include**:

- what files changed, each in one sentence;
- verification commands, full exit codes / key output, evidence paths;
- what was dropped or simplified from the original requirements, and why;
- risks, open questions, matters requiring the Boss's decision;
- next steps (if any);
- **every section is accompanied by one plain-language sentence**, written after the technical content, marked at the start of the line with `【plain language】`. The plain-language sentence must satisfy all three criteria; missing one disqualifies it:
  1. **Short**: no more than two sentences (≤2);
  2. **Understandable on its own**: it does not depend on the preceding technical details; reading only this sentence still makes clear what happened;
  3. **Sufficient to support a decision**: reading only this sentence, the Boss dares to say "yes" or "no".

The plain-language layer **does not need to explain exhaustively and does not introduce a glossary**: if the Boss does not understand, they will ask directly; for now, give one decidable sentence in plain speech. This also applies to interim reports and the final one-page report.

**Exit condition**: The Boss can decide to accept, rework, or stop by reading only this page and the evidence index; the plain-language sentence of each section, read alone, also supports that decision.

### 4.6 Rework

**Trigger**: Verification FAIL, the Boss rejects, a scope change, a new risk discovered.

**Actions**:

- Turn failed items into rework entries, linked to the original task ID and the verification evidence.
- Fix the implementation or have the PM formally modify the spec; ACs may not be relaxed just to pass.
- Commit a new commit in the same workspace and go through independent verification again; do not carry over the trust of the previous PASS.
- Record the root cause of the failure; if the same kind of failure occurs three times in a row, stop and re-split the spec rather than continuing to pile on retries.

**Exit condition**: Same as 4.4; verification after rework must use a new verification context.

### State machine

| State | Entry condition | Allowed next steps |
|---|---|---|
| `intake` | The Boss gives intent | `spec-ready`, `blocked` |
| `spec-ready` | All ACs are decidable | `scheduled`, `blocked` |
| `scheduled` | The backlog has an ID and dependencies are satisfied | `dispatched`, `blocked` |
| `dispatched` | Isolated workspace and brief are ready | `verifying`, `blocked` |
| `verifying` | Engineer delivers commit + evidence | `rework`, `reported` |
| `rework` | Verification FAIL or an explicit change | `dispatched`, `blocked` |
| `reported` | One-pager + evidence index | `done`, `rework` |
| `done` | The Boss accepts and independent verification PASSes | Terminal state (a new task may be opened) |
| `blocked` | A clear blocking reason and owner | Return to the state before blocking |

---

## 5. Context Hygiene

Context is a finite resource, and also the boundary of independence. Principle: **disk stores facts; context stores only decisions and pointers.**

### 5.1 Hard rules

1. **Large output goes to disk**: test logs, build output, long diffs, and scrape results are written to `evidence/` or `artifacts/`; context keeps only paths, exit codes, and the last few key lines.
2. **Read the final answer only**: When you need to look at long output, read the summary, the tail, or locate by line number; do not read the whole text.
3. **Conversation is not storage**: Specs, status, decisions, and failure records must be on disk; they remain recoverable after the session is compacted or handed to someone else.
4. **Read on demand**: Locate before reading a file, then read the relevant fragment; do not pour the entire repository into context.
5. **Pointers are traceable**: Every conclusion is followed by `path:line`, a commit, a command, or an evidence file.
6. **Sensitive information does not enter context**: Keys, tokens, and personal information are always redacted; record only "configured" and how to obtain it, not the value.
7. **The verifier sees only necessary material**: Spec, diff, evidence, test output; it does not read the engineer's full trial-and-error conversation, to avoid being biased by the narrative.

### 5.2 Recommended on-disk structure

```
.delegate/<TASK-ID>/
├── TASK.md                 # spec (source of truth)
├── RUN.md                  # current status, workspace, baseline, capability declaration
├── backlog.md              # or a centralized backlog
├── evidence/               # command output, reports, logs from engineer and verifier
└── handoff/                # engineer handoffs and PM shift changes
```

### 5.3 Context budget

- Write a status file at the end of each phase, rather than patching it later when you can no longer remember.
- Plan the handoff at about 60% context, execute it at about 75%, and at about 85% stop taking new work and change shifts as soon as possible. The numbers are policy, not precise measurement; when the host cannot report the remaining budget, switch to "phase boundary + fixed round" checkpoints (see [`references/pm-handoff.md`](references/pm-handoff.md)).
- Summaries after automatic compaction are **lossy**: when resuming, re-read the spec, status, backlog, and evidence index; do not trust the summary alone.

### 5.4 Anti-patterns

- Pasting an entire CI log into context;
- Re-outputting the full text on every check;
- Using chat history in place of a spec or backlog;
- Treating "I remember" as the baseline;
- The verifier issuing a judgment after reading the engineer's self-defense.

---

## 6. Handoffs: Two Different Things

A handoff is not "saying something"; it is **writing the state needed to continue work to disk and making it independently verifiable by the successor**. Engineer handoffs and PM shift changes solve different problems and must not be conflated.

### 6.1 Engineer cross-phase handoff

**Solves**: How to continue implementation losslessly within the same task when the engineer changes phase, is stopped, runs out of context, or is replaced.

**Must state clearly**:

- task ID, spec version, baseline commit;
- current branch, absolute workspace path, current commit;
- done / in progress / next step;
- list of changed files and uncommitted changes;
- failed commands, failed output paths, ruled-out approaches;
- exact reproduction commands and expected results;
- open questions, risks, prohibitions.

**Successor's first step**: Verify the commit, run the reproduction commands, read the evidence; only change code after confirming everything is correct.
**Verification implication**: A completed handoff does not mean verification passed; it only means the state can continue.

Template: [`references/handoff.md`](references/handoff.md).

### 6.2 PM shift change (pm-handoff)

**Solves**: How to hand "decision state" to the next PM across tasks, across shifts, or when the remaining context is insufficient.

**Must state clearly**:

- Boss intent, success definition, priorities, non-goals;
- spec version, status, workspace, and owner of all in-flight tasks;
- decisions made and the reasons (especially rejected approaches);
- verification conclusions and evidence index;
- open questions, risks, matters requiring the Boss's decision;
- next actions and things that should not be done.

**Successor's first step**: Be able to answer "why are we doing this, where are we now, what counts as done, what is next, what is the biggest risk", and spot-check that evidence pointers resolve.
**Verification implication**: A PM shift change changes no AC and transfers no verification responsibility.

Template: [`references/pm-handoff.md`](references/pm-handoff.md).

### 6.3 Comparison

| Dimension | Engineer handoff | PM shift change |
|---|---|---|
| Object | The implementer of the same task | The next-shift PM / a new PM context |
| Trigger | Phase switch, stop, insufficient context, replacement | Context threshold, end of shift, long-running task |
| Content | Code state, commands, failure evidence, unfinished items | Intent, schedule, decisions, risks, evidence index |
| Does not include | Redefining ACs | Engineer-level implementation details |
| Success criterion | The successor can continue implementation and reproduce tests | The successor can continue making decisions without losing context |

---

## 7. Capability Dependency Declaration

Different hosts provide different capabilities. **Write capabilities as facts before starting work; do not assume them while executing.**

Declare in `RUN.md` or an equivalent status file:

```
capability.backend_dispatch: supported | unsupported
capability.completion_callback: supported | unsupported
capability.context_remaining: supported | unsupported | estimated
capability.permission_sandbox: supported | partial | unsupported
capability.workspace_isolation: supported | manual | unsupported
capability.cancellation: supported | unsupported
```

### 7.1 Required capabilities and fallbacks

| Capability | Purpose | When the host supports it | Mandatory fallback when the host does not support it | Practices not allowed |
|---|---|---|---|---|
| Background dispatch + completion callback | End the round after dispatch and wake when the task finishes | Dispatch in the background and resume in the callback | Switch to foreground blocking execution; or have an external orchestrator wake after the process exits; or explicitly require manual wake-up | Continuous polling, `wait:true`, sleep loops; claiming "it will notify automatically" |
| Workspace isolation | Implementation and verification do not contaminate each other | An independent worktree/snapshot per task | Manually copy a read-only snapshot; run serially; record the residual contamination risk | The engineer and verifier share one writable directory |
| Permission sandbox / read-only | The verifier cannot change code | Tool whitelist + read-only filesystem | Read-only copy + explicit forbidden list + post-hoc diff audit | Relying only on a verbal "do not change" |
| Tool whitelist | Restrict verification actions | Configure allowed/forbidden tools | List allowed commands item by item in the brief; audit command history after verification | The brief omits permission boundaries |
| Observable context remaining | Decide when to change shifts | Trigger PM shift changes by threshold | Fixed phase/round checkpoints; hand off early | Treating estimates as exact values; handing off only when exhausted |
| Task cancellation / timeout | Stop runaway tasks | Actively cancel and keep logs | External process timeout, isolated container, discard the workspace | Letting tasks run indefinitely |
| Persistent state | Recover across sessions | Read/write on-disk status files | Maintain manually with the filesystem; read status at the start of each session | Keeping state only in conversation |
| Structured output / exit codes | Judge success or failure | Parse JSON/exit codes | Agreed log markers and explicit result files | Judging by "looks like it succeeded" |

### 7.2 Declaration discipline

- When a capability is missing, write `unsupported` and the chosen fallback in the status file, and make the Boss aware of the residual risk.
- Platform details are written only in the corresponding `platforms/*.md`; the protocol body is bound to no host.
- A fallback must still satisfy the two iron laws; when it cannot, the task should not enter `verifying`.

---

## 8. Platform Adaptation

Mapping from abstract concepts to concrete primitives; see only the corresponding platform file:

| Platform | File | Adaptation focus |
|---|---|---|
| DSH | [`platforms/dsh.md`](platforms/dsh.md) | Background jobs, subagents, completion delivery, wake limits |
| Claude Code | [`platforms/claude-code.md`](platforms/claude-code.md) | Task/Agent subagents, `claude -p`, permission modes, hooks |
| Codex | [`platforms/codex.md`](platforms/codex.md) | `codex exec`, sandbox, JSON events, notify |

Each platform file must answer four things: **how to dispatch, how to wait and resume, how to read context remaining, and what is explicitly unsupported.**

---

## 9. Anti-Pattern List

| Anti-pattern | Why it is bad | Alternative |
|---|---|---|
| Disguising polling as waiting | Consumes context, manufactures fake progress, violates dispatch discipline | End the round and wait for a callback; without a callback, execute in the foreground or via an external orchestrator |
| Treating the engineer's self-report as verification | Errors are copied by the same viewpoint | An independent verifier re-runs the commands |
| The verifier has write permission | Tests can be modified until they pass | Read-only workspace + tool whitelist |
| The verification brief is only one sentence: "please verify" | No scope, no evidence standard, impossible to judge | Use the verification brief template, with ACs item by item |
| ACs written as adjectives | Never decidable | Bind every AC to a command or an observable result |
| Changing tests / deleting ACs in order to pass | Masks problems, contaminates history | Fix the implementation, or have the PM formally change the spec and record the reason |
| Large output straight into context | Crowds out what really matters | Write to disk; read only summaries and pointers |
| Using "try again" instead of root cause analysis | The same failure recurs | Record failures, locate the root cause, re-split the spec if necessary |
| A handoff that only says "see chat" | Amnesia the moment someone changes | Write to disk using the handoff template, including commits and reproduction commands |
| Multiple tasks sharing one workspace | Changes contaminate each other, evidence is not attributable | One worktree per task; serialize or isolate in parallel |
| Reporting only success and not failure | The Boss cannot judge risk | Failures, abandoned paths, and residual risks all go into the one-pager |
| Pretending the host supports a capability | The process breaks at a critical moment | Capability declaration + fallback |
| Starting work without a baseline | The diff cannot be scoped, verification cannot be reproduced | Fix a baseline commit |
| Verification only reads the diff and does not run tests | Static reading misses runtime issues | Re-run the verification commands and keep the output |
| Letting the implementer write the verification conclusion | Independence drops to zero | The verifier issues PASS/FAIL independently |

---

## 10. Minimum Adoption Checklist

When using this protocol for the first time, complete the following in order:

- [ ] Read sections 1–4 of this document; confirm the roles, iron laws, violation checks, and process.
- [ ] Choose a host, read the corresponding `platforms/*.md`, and write "known unsupported" into `RUN.md`.
- [ ] Use [`references/spec-template.md`](references/spec-template.md) to write `TASK.md`, ensuring every AC is decidable.
- [ ] Register the task in [`references/backlog.md`](references/backlog.md) and fix the baseline commit.
- [ ] Create an independent workspace from the baseline and dispatch the engineer per the brief.
- [ ] End the round after dispatch; continue only after a completion callback or manual wake-up.
- [ ] Use [`references/verification-brief.md`](references/verification-brief.md) to dispatch independent verification, requiring the commands to be re-run.
- [ ] Use [`references/report-template.md`](references/report-template.md) to give the Boss a one-page conclusion.
- [ ] Hand off before the context threshold using [`references/handoff.md`](references/handoff.md) or [`references/pm-handoff.md`](references/pm-handoff.md).
- [ ] Mark the task `done` only after independent verification PASSes and the Boss accepts.

---

## 11. File Map

| Path | Purpose |
|---|---|
| [`README.md`](README.md) | Project description and quick start for humans |
| [`PROTOCOL.md`](PROTOCOL.md) | This document, the platform-agnostic protocol body |
| [`platforms/dsh.md`](platforms/dsh.md) | DSH primitive mapping |
| [`platforms/claude-code.md`](platforms/claude-code.md) | Claude Code primitive mapping |
| [`platforms/codex.md`](platforms/codex.md) | Codex primitive mapping |
| [`references/spec-template.md`](references/spec-template.md) | Task spec template |
| [`references/verification-brief.md`](references/verification-brief.md) | Independent verification brief template |
| [`references/report-template.md`](references/report-template.md) | One-page and interim reports |
| [`references/handoff.md`](references/handoff.md) | Engineer cross-phase handoff |
| [`references/pm-handoff.md`](references/pm-handoff.md) | PM shift change and context budget |
| [`references/backlog.md`](references/backlog.md) | Task queue and scheduling |
| [`LICENSE`](LICENSE) | MIT license |
