# Dispatch and continuation

Read the task and target scope before dispatch. Keep an append-only private launch record with owner, role, context policy, exact command, workspace, delivery and output paths. Never include credentials.
Use the host adapter under `platforms/` for an installed transport.
Retain an explicit engineer session for continuation and rework. Start each formal verifier fresh on the exact delivery.
Only promise completion callbacks when the host supports them. Follow the host lifecycle rules for collecting subprocess results.
For interrupted tasks, inspect launch/terminal records and verify process identity before continuing. Unknown terminal state is not success and is not permission to start a duplicate.
See [runtime records](runtime-evidence.md) for the generic record format.
