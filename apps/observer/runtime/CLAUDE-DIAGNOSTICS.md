# Claude journal metadata diagnostics

Claude compatibility remains unverified when the official journal identity check fails.
A queued receipt or a shared project room does not establish Claude validation.
Do not change session, cwd, primary-session or freshness checks to make a queue appear successful.

The reader emits fixed reason codes after `journal-identity-invalid:`:

| Code | Meaning |
|---|---|
| `claude-session-missing` | The event has no `sessionId`. |
| `claude-session-mismatch` | The event session differs from the declared session. |
| `claude-cwd-missing` | The event has no cwd. |
| `claude-cwd-invalid` | The cwd is not an absolute string. |
| `claude-cwd-mismatch` | The normalized cwd differs from the declared project. |
| `claude-sidechain-missing` | The event omits its primary/sidechain marker. |
| `claude-sidechain-not-false` | The marker is not the explicit boolean false. |
| `claude-timestamp-invalid` | The timestamp is absent or invalid. |
| `claude-turn-id-invalid` | A primary user event has no valid turn identifier. |

The first failed predicate is retained across incremental reads.
These codes contain no raw journal field values.
Codex rejection messages keep their existing format.
The cache version changes so old generic errors can be re-evaluated.
No event schema is newly accepted by this diagnostic change.

## Minimal local sample

Run this on the affected machine only when an operator has selected the exact project and official Claude session.
Use the actual ID supplied by the host; do not generate an ID or substitute a Codex/DSH ID.
Do not send the raw journal, a header dump, account configuration, prompt or tool output.

```bash
python3 /path/to/observer/runtime/external_journal.py claude-metadata \
  --project '/absolute/affected/project' --session-id 'ACTUAL_CLAUDE_SESSION_UUID'
```

The same command works against the installed `observer/runtime/external_journal.py`.
The sampler is embedded in the existing core file, so it adds no installer executable or dependency.
If this explanation is distributed beside the runtime, include this Markdown file in the release documentation manifest.

The command derives one exact official Claude journal path from the project and session.
It does not enumerate other sessions or read credentials.
It reads at most 32 lines and 256 KiB, rejecting symlinks and partial records.
It prints only event type, line number and comparison enums:

- Session/cwd: missing, match, mismatch; cwd can also be invalid.
- Sidechain: missing, false, true or invalid-type.
- Timestamp: invalid, future, fresh or stale.
- Turn identifier: valid boolean. Parent tool reference: present boolean.
- Identity failure: the fixed reason code above, or null.

Session IDs, paths, timestamps, message blocks and arbitrary metadata strings never appear in the sample.
This is a bounded diagnostic sample, not a full-journal validation result.
A sample may finish before the event that caused the writer warning.
An unchanged recent official journal must pass the normal reader before claiming compatibility or successful display.
Preserve the known issue until that affected-machine check succeeds.
