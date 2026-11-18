# DSH adapter

## Dispatch

Inspect the current host tool catalog before dispatch.
Choose available native agents or an installed local CLI.
The engineer reports its actual `DSH_SESSION_ID`; an agent display name is not a session UUID.
Retain the engineer context for rework. A formal verifier starts in a fresh independent context.
Supply the spec, exact delivery, allowed tools and evidence location.
Keep logs and task state private. Do not publish local session stores.
Use completion delivery only when the host supports it.
A completed agent turn does not prove its background subprocesses reached a terminal state.
Collect managed terminal results under the host's actual lifecycle rules.

## Waiting and Resuming

Resume an explicit engineer session. Start the verifier fresh.

## Context Budget

Save concise task state at phase boundaries. Do not invent remaining-context percentages.

## Known Unsupported Capabilities

Check the installed host catalog. Completion callbacks and journal formats depend on the host version.
