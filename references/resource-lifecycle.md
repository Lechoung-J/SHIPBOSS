# Local resource closure

Use `python3 <skill>/scripts/shipboss-resources.py --root "$PROJECT" inventory` before closing a task. This standard-library tool owns only explicitly registered directories in one local primary Git workspace. Inventory and plan are read-only. It does not discover other repositories, run a daemon, schedule work, merge, commit, delete branches, or run Git GC.

The lifecycle is accepted → integrated-uncommitted → integration-verified → archived → workspace-released → closed. Independent acceptance alone never proves integration or release. The PM supplies the independent evidence and exact accepted file mapping. The tool hashes that evidence, checks the source fingerprint, compares destination bytes and modes, and later rechecks the combination. It does not interpret a PASS string as proof. Existing commit ancestry remains useful evidence, but this implementation records file integration without inventing a new commit.

## Explicit registration

Initialize only an intended project. Keep generated JSON, plans, receipts and objects private under its `.delegate` directory.

```sh
python3 <skill>/scripts/shipboss-resources.py --root "$PROJECT" init
python3 <skill>/scripts/shipboss-resources.py --root "$PROJECT" adopt --file "$PRIVATE/owned.json"
python3 <skill>/scripts/shipboss-resources.py --root "$PROJECT" inventory
python3 <skill>/scripts/shipboss-resources.py --root "$PROJECT" plan --ids old-build > "$PRIVATE/plan.json"
```

Example registration:

```json
{
  "protected": ["private/publish-review"],
  "resources": [{
    "id": "old-build", "path": "artifacts/old-build.app", "kind": "artifact",
    "owner": "assigned-role", "task": "local-task", "owner_state": "inactive",
    "lease_until": 0, "retention": "reclaim"
  }]
}
```

Kinds are `artifact`, `stage`, and linked `worktree`. Retentions are `current`, `rollback`, `evidence`, and `reclaim`. Register a current verified release and one trusted rollback as retained before reviewing older packages. Register unique failure evidence as `evidence`. A lease is recorded metadata; expiration never grants deletion. Workspace budget follows registered active roles and never triggers deletion.

For a worktree, `archive_not_integrated: true` explicitly permits reversible retirement before integration. Its state becomes `archived-not-integrated`. The tool retains the original branch, creates a local archive ref, and preserves the original HEAD in a bundle. It does not claim that the main branch contains the work. Without this explicit choice or verified integration, the worktree stays protected.

A shared dependency link can be registered as `"dependency_links":{"node_modules":"app/node_modules"}`. The exact existing link must resolve to that repository-owned dependency. The tool records the link without following it. Restore may spell the link as an absolute link to the same registered dependency. The dependency itself remains protected. Other external links block retirement. Paths containing traversal, symlink parents, main tracked files, the Git store, runtime data and explicit protection are blocked. Add current publication candidates and runtime identities to the protected list.

## Archive, verify, release, restore

```sh
python3 <skill>/scripts/shipboss-resources.py --root "$PROJECT" apply \
  --plan "$PRIVATE/plan.json" --digest "$REVIEWED_DIGEST"
python3 <skill>/scripts/shipboss-resources.py --root "$PROJECT" archive-verify --archive "$ARCHIVE_SHA"
python3 <skill>/scripts/shipboss-resources.py --root "$PROJECT" restore \
  --archive "$ARCHIVE_SHA" --destination "restored/old-build.app"
```

`archive --id "$RESOURCE"` creates a verified archive without releasing its source. It still requires an inactive owner and an idle process probe. Explicit retention does not prevent this non-destructive archive. `set-owner --id "$RESOURCE" --record "$PRIVATE/owner.json"` updates a lease or owner state with an evidence hash. An inactive transition requires `host_state` of completed/stopped/failed, no pending checkpoint jobs, and an idle probe. The record includes `owner_state`, `lease_until`, `evidence`, and the matching `session_id` when already bound.

Apply binds the exact plan, root inode, ownership registry, resource inode and source fingerprint. It checks process occupancy before archiving and again before release. The macOS probe checks cwd and open executable/mapped paths using `lsof`. A failed or incomplete probe protects the resource. The PM must separately check native agent ownership and current app identity. No CLI can infer a native model's state from an expired lease.

Files share SHA-256 content objects across packages. Directory manifests preserve bytes, modes, relative framework links and all readable extended attributes. Archive verifies a fresh temporary restore before releasing a source. For a macOS app whose original `codesign --verify --deep` succeeds, the temporary restored app must pass that command too. Unsigned or invalid original signatures remain explicitly unverified; byte restoration is not a claim of notarization or launch compatibility. Extended attributes are retained and compared; a read/write failure blocks release. Logical unique object bytes differ from physical APFS free space. Measure `du` and `df` separately.

Only ordinary entries with a proven absence of extended ACLs are eligible. On macOS the standard-library `ctypes` bridge calls `acl_get_link_np`, inspecting each file, directory and symlink itself without following dependency links. A present ACL blocks with `unsupported-acl`; unavailable APIs, failed probes, unsupported platforms or an unstable path block with `acl-probe-unknown`. Source scans repeat during plan, apply and the final pre-release check. Restored trees are checked again, including newly inherited ACLs. This version neither copies ACLs nor clears them on a source. Each new manifest entry records `acl:"absent"`; older archives lacking that proof cannot receive a complete restoration verdict from this version. Keep their original sources and re-archive after a successful probe.

A worktree archive captures its complete tree, including untracked and ignored files, index bytes, staged-only Git objects, binary staged/unstaged patches, status, original branch and HEAD bundle. A temporary independent Git repository must reproduce the Git state before source release. Restore uses `git worktree add`, then restores the tree/index; it never copies an old `.git` pointer. The original branch must still point at the recorded HEAD. Split indexes, unresolved merges, submodules and unsupported file types remain protected. The same repository and Git object archive must remain available. This is not a portable cloud backup.

Apply uses an exclusive local lock and atomic per-plan receipts. A repeated digest returns the same receipt and never deletes a newly created directory at the old path. Some rows can release while others remain blocked. Exit 2 identifies a blocked apply. A crash can leave an incomplete receipt, a stale lock or an archive-verified row. Preserve them. Confirm the recorded PID is dead before manually removing a stale lock. Recover from the archive key in the receipt, then create a fresh plan. An incomplete receipt is never evidence of closure. No automatic archive object GC runs.

## Integration and task close

An accepted mapping lists exactly the independently reviewed scope. Map deletions with `"deleted":true`. Regular file mappings compare bytes and modes; symlink integration mappings are deliberately unsupported. Archive/restore still preserves supported symlinks.

```json
{"files":[{"source":"src/change.py","target":"src/change.py"}]}
```

```sh
python3 <skill>/scripts/shipboss-resources.py --root "$PROJECT" accept \
  --id "$RESOURCE" --evidence "$ACCEPTANCE_EVIDENCE" --manifest "$PRIVATE/delivery.json"
# PM integrates only the accepted delta, without an implicit commit.
python3 <skill>/scripts/shipboss-resources.py --root "$PROJECT" integrate \
  --id "$RESOURCE" --manifest "$PRIVATE/delivery.json" --evidence "$INTEGRATION_EVIDENCE"
# Run fresh checks against the final combined workspace, then record their evidence.
python3 <skill>/scripts/shipboss-resources.py --root "$PROJECT" verify-integration \
  --id "$RESOURCE" --evidence "$COMBINED_CHECK_EVIDENCE"
# Review plan/apply and preserve the archive; close only after resource release.
python3 <skill>/scripts/shipboss-resources.py --root "$PROJECT" close --id "$RESOURCE"
```

Acceptance without a mapping can be recorded, but integration remains blocked. If source or destination changes, repeat the relevant acceptance/integration checks. Never replace missing review evidence with an engineer self-report. Reviewers must judge whether the mapping includes the entire intended delivery.

## Paused owners and native continuation

Owner states `active`, `paused`, `blocked`, `waiting`, and `unknown` protect resources. A checkpoint records a real session UUID, assignment, exact workspace fingerprint, reason code, pending job IDs, last verified stage and next action. Do not put complete messages, credentials or model reasoning in these records.

```sh
python3 <skill>/scripts/shipboss-resources.py --root "$PROJECT" checkpoint \
  --id "$RESOURCE" --record "$PRIVATE/checkpoint.json"
python3 <skill>/scripts/shipboss-resources.py --root "$PROJECT" prepare-resume \
  --id "$RESOURCE" --record "$PRIVATE/resume.json"
```

Checkpoint example keys are `session_id`, `assignment`, `workspace`, `state`, `reason_code`, `next_action`, `pending_jobs`, and `verified_stage`. Resume records repeat the first three identity keys, add `checkpoint_digest`, `host_state` and `host_evidence` (a repository-relative file from a fresh host check). Running owners produce `keep-existing-writer`; completed owners produce `collect-existing-delivery`. Unknown state blocks continuation. A stopped/failed owner with no pending jobs and a proven idle workspace produces `pm-resume-same-session`. The output always says `executed:false`. Only the PM's host tool performs native continuation. It must target the recorded session, retain the original assignment, and verify new output before proceeding. No second writer is launched by this CLI.

## Packaging and installed use

The local macOS packager marks its newly created stage by PID and inode. Success archives its operation manifest and releases that exact stage. Failure retains application payload, plist/signature evidence, input identity, hashes and diagnostic receipt before releasing the Electron stage. The pinned Electron installation remains a required input for reproducing packaging. If evidence preservation or ownership checks fail, the stage remains for review. Final release and rollback apps are separate resources.

The installer copies this self-contained CLI and both reference documents. `--help`, inventory and plan need Python 3 and local Git only. The implementation and synthetic failure cases are exercised on local macOS. Other platforms, remote hosts, filesystem ACLs, creation times, Finder metadata outside xattrs and automatic host scheduling have no verified support claim. Do not archive resources whose recovery depends on those unrecorded properties.
