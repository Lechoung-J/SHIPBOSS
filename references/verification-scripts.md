# Verification script engineering rules (13 field lessons)

[English](verification-scripts.md) | [中文](verification-scripts.zh-CN.md)

> Intended audience: PMs / engineers / verifiers who write `verify.sh` for a single task.
> Usage: After writing the script, self-check item by item; **each rule must be able to answer "under what circumstances is this script unacceptable"**.
> These rules come from field incidents that recurred in real projects — each one corresponds to a case where "the check itself failed".

---

1. **Before changing any AC in `verify.sh`, save the old version as `verify.rev<N>.sh`**

   **Rule**: Whenever you change the acceptance conditions in an existing script (add/remove ACs, loosen/tighten criteria, change expected values), first copy the old version as `verify.rev<N>.sh` in the same directory (`<N>` increments; if it already exists, keep adding one), and write "rev N, supersedes rev N-1" at the top of the new version; the delivery evidence must give both paths. This lets a third party run `diff verify.rev1.sh verify.sh` directly and judge whether the change is a correction or a weakening.

   **What a violation looks like**: Overwriting old ACs in place with `vim verify.sh`; only the final version remains in the repository; the verifier cannot reconstruct "what was actually checked before the change". Or erasing old criteria with `git checkout` / rewriting the file, while claiming in the report that "only the wording was fixed".

   **Counterexample / source of evidence**: During one AC change, no copy was kept; afterward the team could only write `evidence/ac-amendment-note.md` admitting that the old version could not be restored verbatim; this left "legitimate correction" and "lowering the standard" distinguishable only by self-report.

2. **Regression assertions must not bind to "the change scope relative to some historical commit"**

   **Rule**: Repository-level regression assertions must target **invariants of the current HEAD** (files exist, content constraints, links resolve, etc.), or pass the baseline as an explicit parameter (environment variable / command-line argument). Do not hardcode a historical commit SHA and then assert that `git diff <historical commit>..HEAD --name-only` equals exactly a set of files; that assertion will be broken by the next task's normal changes.

   **What a violation looks like**: The script contains a hardcoded `git diff 3841fdd..HEAD --name-only` or `git diff 43b1056..HEAD` and compares an exact file list. After the next task legitimately adds files, the old script inevitably reports "scope mismatch", even though the repository has not regressed.

   **Counterexample / source of evidence**: One task's script reproduced 3 false failures on a later HEAD; another task's script reported 2 FAILs on the 2026-10-18 HEAD due to a scope assertion and old expectations. Both were direct consequences of binding to historical commits.

3. **Verification scripts must not scan gitignored local state such as `.delegate/`**

   **Rule**: Scripts may only check version-controlled files returned by `git ls-files`, or use an explicit controlled file list; before any whole-repository scan, exclude `.delegate/`, `node_modules/`, build artifacts, cache directories, and other local state. Do not run `find`, `grep -r`, word counts, or link checks over the entire working tree without exclusions.

   **What a violation looks like**: `find . -name '*.md'` or `grep -r ... .` picks up `.delegate/BACKLOG.md` or a verifier's temporary logs; relative links, word counts, or temporary conclusions in local documents are treated as repository content, causing "FAIL even though no code changed".

   **Counterexample / source of evidence**: One task's Markdown link check once scanned `.delegate/BACKLOG.md` and falsely FAILed because of a local document link; this rule requires scripts to narrow the scan to tracked files rather than trusting that "the local directory should be fine".

4. **A script must not contain more assertions than the spec's AC table: every assertion must map to a numbered item in `TASK.md`**

   **Rule**: Before writing the script, copy out the AC table from `TASK.md` (ID + one-sentence criterion). Every check in the script must be attached to one of those AC-IDs; implicit assertions such as "let's check one more thing while we're here" or "inherited from the previous task" are not allowed. If a new criterion is truly needed, first change the TASK's AC table and leave a change record, then write the script.

   **What a violation looks like**: The TASK only goes up to AC-8, but the script prints out-of-table checks such as AC-9 / AC-5b; or one AC contains extra conditions not written in the TASK. The more out-of-table assertions there are, the more likely it is that criteria conflict with the spec, and when they fail there is no way to assign responsibility.

   **Counterexample / source of evidence**: One task's AC-5b was an assertion inherited from an old task and not registered in the TASK; it was exactly the root cause of a later mutually exclusive conflict. How to judge it unacceptable: extract all assertion IDs from the script and compare them one by one with the TASK AC table; any out-of-table ID means unacceptable.

5. **AC numbering in the TASK and the script must correspond one-to-one**

   **Rule**: The same `AC-N` must refer to the same thing in the TASK and the script; when adding/removing ACs, change both in the same commit, and try not to insert in the middle so that later numbers drift. "AC-N PASS" in the delivery report must map both to the TASK table row and to the script text.

   **What a violation looks like**: The TASK's AC-7 is "no regression" while the script's AC-7 is "file count"; or the TASK's AC-3 is "subject keyword" while the script's AC-3 is "scope". Then "AC-8 PASS" is misread as something else, and the verification record loses traceability.

   **Counterexample / source of evidence**: One task had a mismatch where TASK AC-7 = regression and script AC-7 = count, and the verifier misread the passing item because of it. How to judge it unacceptable: print the TASK AC table and the script's success/failure messages side by side and compare the semantics ID by ID, not just the count.

6. **Discipline for writing negative assertions: before writing "X must not appear", first ask "could X appear in a qualifying answer?"**

   **Rule**: A negative assertion must prove that "no qualifying answer contains X"; if a qualifying answer might mention X for explanation, example, or quotation, you cannot forbid it across the whole file. Prefer converting it to a positive or structural assertion; when a negative assertion is unavoidable, limit it to a specific command/section/code block, and at the same time provide a positive example that must exist as counter-evidence.

   **What a violation looks like**: The spec requires "explain how to configure `--permission-mode`", but the script forbids `--permission-mode` across the whole file; or it requires "point out that `bypassPermissions` must not be used", but the script forbids that word. A qualifying answer triggers FAIL as soon as it is written; this is a mutually exclusive AC.

   **Counterexample / source of evidence**: One task's AC-8, another task's initial AC-3, and another task's AC-5b produced mutually exclusive ACs three times. How to judge it unacceptable: feed the script a qualifying sample written according to the spec; if the qualifying sample FAILs, the script is unacceptable.

7. **Gate strength: `grep -qF` whole-file substring matching can be bypassed by comments, synonyms, or saying the opposite**

   **Rule**: Key assertions must not rely only on whole-file substring existence checks. They must have at least: (a) **command-line context anchoring** (the matched line must contain the invoked command/parameter or be inside a specified code block); (b) **polarity and proximity constraints** (exclude negation words such as "do not", "forbidden", "wrong example"; limit to the same sentence/line window); (c) **mutation testing**: construct at least one mutant that "writes it in a comment", "replaces it with a synonym", or "says the opposite", and confirm the script reports FAIL for it. Record the mutation command and result for each key AC.

   **What a violation looks like**: `grep -qF -- '--sandbox' file` passes inside a `<!-- --sandbox -->` comment; or a document saying "do not use `--dangerously-bypass-approvals-and-sandbox`" also counts as a match; or replacing `--sandbox` with the synonymous "sandbox switch off" still passes. The gate appears to exist but is insensitive to reverse content.

   **Counterexample / source of evidence**: One task's AC-4b was bypassed on the spot by "writing it in a comment"; another task's / another task's AC-5b demonstrated on the spot with synonym and opposite-meaning mutations that literal matching fails. How to judge it unacceptable: perform at least one reverse mutation on a key assertion; if the script still PASSes, it is unacceptable.

8. **Cover both long and short flags**

   **Rule**: For each tested flag, first list all forms the tool actually accepts (long and short), and assert each form; if the tool does not support one form, state the basis in a script comment. When matching short flags, add boundaries (start of line/whitespace before, whitespace/end of line after) to prevent `-a` from matching `-abc` or part of an ordinary word.

   **What a violation looks like**: Only grepping `--sandbox` / `--approval-mode`, missing `-s` / `-a`; when the documentation uses `-a never`, the script cannot see it at all. Or `grep -q -- '-a'` falsely matches unrelated content such as `--allow` or `data`.

   **Counterexample / source of evidence**: One task's `-a never` wording correction showed that short flags are used in real documentation; a script checking only `--` would miss it. How to judge it unacceptable: rewrite the tested command in short-flag form and feed it to the script; if the script still PASSes, it is unacceptable.

9. **Position-sensitive flags (top level vs subcommand) must be validated with position awareness**

   **Rule**: For flags that "can only be placed at the top level" or "can only be placed after a subcommand", do not check mere existence. The script must parse the command tokens, determine where the subcommand appears, and then assert that the flag is on the side where it is allowed; preferably run both a positive example and a misplaced negative example. Multi-level subcommands (e.g. `codex exec resume`) must be judged according to the actual hierarchy.

   **What a violation looks like**: `grep -q -- '--sandbox'` also PASSes for the misplaced form `codex exec --sandbox ... resume`; but the flag is ignored or rejected by the CLI in the wrong position. An existence check mistakes "it was written" for "it was written correctly".

   **Counterexample / source of evidence**: One task found that "top-level `codex resume` is an interactive picker; non-interactive use requires `codex exec resume`", so the same flag has different semantics in different positions; an existence check cannot distinguish them. How to judge it unacceptable: move the flag to the wrong position; if the script still PASSes, it is unacceptable.

10. **Evidence assertions must check "whether it is really in the command chain", not just whether a keyword appeared**

    **Rule**: Verification evidence must show that "which command was executed + with which parameters + what output/exit code" belong to the same invocation. Assertions should require the command, key parameters, and result markers (output excerpt / exit code) to appear together in the same code block or the same command chain, rather than finding these words separately across the whole log. The exit 0 of an outer wrapper cannot be evidence that the inner command succeeded.

    **What a violation looks like**: The log contains `codex exec` and `exit 0`, but the `exit 0` comes from an outer `claude -p`, and the inner commands were all rejected; or the evidence contains only one sentence "already run", with no command line, output, or exit code. The keyword grep is all green, but the fact never happened.

    **Counterexample / source of evidence**: A real incident recorded in one task's candidate items: the outer `claude -p` exited 0 while all inner commands were rejected; there were also multiple verifications judged "unreadable" because the evidence had only a conclusion and no command chain. How to judge it unacceptable: delete the output/exit code and leave only the command name; if the script still PASSes, it is unacceptable.

11. **Verifier outputs and logs must always use absolute paths in the main repository; collect evidence before deleting a worktree**

    **Rule**: The evidence locations in the verification brief and scripts must be **absolute paths** in the main repository (e.g. `/Users/.../repo/.delegate/<ID>/evidence/...`), not relative paths or paths inside the worktree; if you must work in the worktree, copy the verdict, logs, and screenshots to the main repository before finishing, confirm each exists with `test -s`, and only then run `git worktree remove --force`.

    **What a violation looks like**: The brief says "output to `evidence/verdict.md`", the verifier writes the file inside the worktree; then the worktree is force-removed and the verdict and logs disappear along with it. Or evidence is written to `/tmp` and cannot be reviewed after changing machines or cleaning up.

    **Counterexample / source of evidence**: One task once lost the verdict and logs because the worktree was deleted, and had to recover them by writing them to disk a second time; four tasks in a row had verifiers who "could not read" the engineer's evidence, all rooted in the output location. How to judge it unacceptable: `grep` every evidence path in the brief; any non-absolute path means unacceptable.

12. **`verify.sh` is a one-off task script; long-term regression requires a separate suite independent of the task**

    **Rule**: Each task's `verify.sh` is valid only for that task's baseline + spec; archive it after delivery and do not assume it will still be all green on a future HEAD. When long-term regression is needed, build a separate version-controlled, parameterized regression suite that depends only on current HEAD invariants (e.g. `tests/` or CI configuration), and make clear which checks belong to the suite and which belong to the task. A task script must not be called directly by other tasks or CI.

    **What a violation looks like**: Wiring `.delegate/<some task>/verify.sh` into CI or a new task's verification command; or directly reusing an old script in the next task without checking its historical-commit-bound assertions, so the old script's expected false failures are treated as real regressions.

    **Counterexample / source of evidence**: One task's script reported 2 FAILs on today's HEAD due to a scope assertion and an old assertion that another task had intentionally overturned — these were expected false failures, not repository regressions. How to judge it unacceptable: running an old task script on a new HEAD and getting FAIL cannot be used to judge regression; if CI references a task script, that CI configuration is unacceptable.

13. **Exact-count assertions ("exactly N") are forbidden unless the directory is genuinely closed**

    **Rule**: Do not use `-eq` to assert that a controlled directory contains "exactly N" files/items unless the directory is genuinely closed during the task's lifetime and will not legitimately grow with other tasks. To prevent missing files, list each required file individually and check that it is non-empty (existence assertions); use the total file count only as a lower bound (`-ge`) or merely print the actual value, not as a criterion.

    **What a violation looks like**: `[ "$actual_refs" -eq 6 ]` or `[ "$actual_platforms" -eq 3 ]`. After the next task legitimately adds a document or a platform file, the directory count changes from 6 to 7, or from 3 to 4, and the old script immediately reports "count mismatch"; the repository itself has not regressed — this is a false failure caused by adding legitimate files.

    **Counterexample / source of evidence**: One real incident (`references`'s `-eq 6`: FAIL as soon as one task added the 7th file; changed to a lower bound); one similar unexploded mine (`platforms`'s `-eq 3`, fixed in advance in one task's rev4). How to judge it unacceptable: after adding a legitimate file to the checked directory, rerun the script; any count-related FAIL means unacceptable.
