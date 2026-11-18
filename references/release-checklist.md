# Release checklist (`release` tier)

> Use only for `release` tasks: irreversible, public-facing, or touching credentials/money.
> Every line must be answered with a command, a path, or an explicit "n/a — reason".

## 1. Artifact and proof

- [ ] The artifact exists and the boss can reach it: `<path or command>`
- [ ] The proof command runs from a clean checkout: `<command> → exit 0`
- [ ] A **user-visible smoke check** was performed (not only unit tests): `<steps>`

## 2. Disclosure

- [ ] Every claim in public docs is backed by a command or a file in the repo
- [ ] Anything not verified is labelled (e.g. "untested", "not measured")
- [ ] No internal identifiers leak (`ticket IDs`, local paths, private notes)

## 3. Credentials and privacy

- [ ] No secret in tracked files: `grep -rInE 'apikey_[A-Za-z0-9]|sk-[A-Za-z0-9]{16,}|gho_[A-Za-z0-9]' <tracked files>` → empty
      (note: a bare `sk-` matches words like `task-id`; always add the length bound)
- [ ] Secrets live in a store outside the repo (env var or user-level credentials)
- [ ] The export step refuses to run if a credential shape is found

## 4. Defects

- [ ] Known-severe defect list is **empty** (or the release is explicitly cancelled)
- [ ] Known-minor defects are listed in the report with the decision to ship anyway

## 5. Rollback

- [ ] What is the rollback action if this release breaks something? `<step>`
- [ ] Who decides to roll back? (boss)

## Sign-off

- Boss acknowledgement: `<date / quote>`
- PM: `<who>` — Tier: `release` — Rounds spent: `<n>` — ACs weakened: `<n>`
