# Reporting template: one-pager + progress reports

[English](report-template.md) | [中文](report-template.zh-CN.md)

> Rule: Lead with the conclusion, refer to evidence by path, and do not paste long logs. The boss should be able to decide to accept, rework, or stop after reading one page. Protocol: [`../PROTOCOL.md`](../PROTOCOL.md).

---

## A. Completion one-pager

> **Every section must include one plain-talk sentence (hard requirement).** After the technical content of each section (A1–A6) of this template, add a separate line beginning with `[Plain talk]`.
> Copyable form:
>
> ```text
> ### <technical section>
> - <facts, commands, exit codes>
>   [Plain talk] <≤2 sentences; understandable on its own; sufficient to support a decision>
> ```
>
> **Three criteria (missing any one means it does not qualify)**:
>
> 1. **Short**: no more than two sentences (≤2 sentences).
> 2. **Understandable on its own**: does not depend on the technical details of the previous section; this sentence alone makes clear what happened.
> 3. **Sufficient to support a decision**: reading only this sentence, the boss is willing to say "yes" or "no".
>
> The plain-talk layer **does not need exhaustive explanation, nor a glossary**: the boss will ask directly if something is unclear. One decidable sentence in plain language is more useful than another page of annotations.

# <TASK-ID> Completion report

**Conclusion**: `PASS` / `FAIL` / `BLOCKED` (subject to the independent verification conclusion; the engineer's self-assessment does not substitute for it)

## A1. What changed (one sentence per file)

| File | One-sentence description |
|---|---|
| `<path>` | <what was done, and why> |
| `<path>` | <what was done, and why> |
| `<path>` | <what was done, and why> |

- Delivery commit: `<sha>`
- baseline commit: `<sha>`
- Branch / workspace: `<branch>` / `<path>`
- [Plain talk] <what this change means overall and whether the boss needs to do anything, ≤2 sentences>

## A2. Verification

- Verification command: `<command>`
- Full output path: `<evidence/path>`
- Exit code: `<0 / non-zero>`
- Independent verification conclusion: `PASS` / `FAIL` (verification report: `<path>`)
- Key results (at most 5 lines):

```text
<key output excerpt or summary>
```

- [Plain talk] <did the tests actually pass, and did anything old break, ≤2 sentences>

## A3. What was dropped or simplified, and why

| Original requirement | Handling | Reason | Impact |
|---|---|---|---|
| `<item>` | Dropped / Simplified / Deferred | <facts and trade-offs> | <impact on AC/users> |

If there is no trade-off, write "none"; do not leave it blank.

- [Plain talk] <what was omitted or saved and why that is acceptable, ≤2 sentences>

## A4. Risks and open items

| Risk/issue | Impact | Current mitigation | Who needs to decide |
|---|---|---|---|
| `<risk>` | High/Medium/Low | <measure> | Boss / PM / engineer |

- [Plain talk] <what the boss most needs to pay attention to and whether to act now, ≤2 sentences>

## A5. Next steps

- <If PASS: merge/release/archive/monitor, etc.>
- <If FAIL: rework items and owners>
- <If BLOCKED: what is needed to continue>
- [Plain talk] <what happens next and whether the boss needs to nod, ≤2 sentences>

## A6. Evidence index

| Evidence | Path |
|---|---|
| Engineer report | `<path>` |
| Verification output | `<path>` |
| Verification report | `<path>` |
| diff | `<command / path>` |

- [Plain talk] <is the evidence complete, and could someone else recheck it independently, ≤2 sentences>

---

## B. Progress report

> Trigger: stage completion, encountering a block, first failure, scope change, or context approaching the handoff threshold. Each report is no longer than half a page.
> **Each bullet also gets one `[Plain talk]` sentence**, written according to the same three criteria as A (≤2 sentences / understandable on its own / sufficient to support a decision).

# <TASK-ID> Progress report @ <stage/time>

**Status**: `in progress` / `blocked` / `needs decision`

- **Completed**: <at most 3 items, with evidence paths>
  [Plain talk] <where we are now and whether the boss needs to do anything, ≤2 sentences>
- **In progress**: <current action and expected completion condition>
  [Plain talk] <what remains and roughly when there will be a result, ≤2 sentences>
- **Next steps**: <the next 1–2 actions>
  [Plain talk] <what will happen first and whether the boss needs to nod, ≤2 sentences>
- **Blocks/risks**: <facts + impact + who needs to do what; write "none" if there are none>
  [Plain talk] <where it is stuck and who needs to make a decision, ≤2 sentences>
- **Scope changes**: <yes/none; if yes, explain and wait for PM confirmation>
  [Plain talk] <did the work grow or shrink and does the boss need to re-decide, ≤2 sentences>
- **Context/handoff**: <whether a handoff is needed; handoff file path>
  [Plain talk] <will there be a handoff or interruption and does the boss need to know, ≤2 sentences>

Requirements:

- Write `[Plain talk]` after every bullet, and each must pass the three criteria in A; missing any one means it does not qualify;
- Do not write undecidable sentences such as "progressing smoothly";
- Do not paste complete logs; give only paths and key lines;
- On failure, state the failing command, exit code, and the paths already ruled out;
- A progress report does not change AC and does not mean verification passed.

---

## C. Report self-check

- [ ] The conclusion is visible on the first line.
- [ ] Every section has one `[Plain talk]` sentence, and all three criteria pass: ≤2 sentences / understandable on its own / sufficient to support a decision.
- [ ] The plain-talk text is not written as a second explanation, nor does it introduce a glossary.
- [ ] Every conclusion has an evidence path or command.
- [ ] Failures and trade-offs are not hidden.
- [ ] The engineer's self-assessment is not written as a verification conclusion.
- [ ] The one-pager does not exceed the agreed length; details are in the links.
- [ ] After reading it, the boss knows what to do next.
