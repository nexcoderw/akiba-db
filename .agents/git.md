# Git Workflow

**Purpose:** Keep Akiba Database history clean, reviewable, and free of secrets, with the developer in full control of every Git write.
**Applies to:** The end of every task, and anything that decides what may be committed.
**Related:** [agent-workflow.md](agent-workflow.md), [security.md](security.md), [package-management.md](package-management.md)
**Last reviewed:** 2026-11-16

---

## 1. Agent rules

- Agents **never** run Git write commands: `add`, `commit`, `push`, `pull`, `merge`, `rebase`, `reset`, `restore`, `checkout -- <path>`, `stash`, `tag`, `cherry-pick`, `clean`, or branch creation and deletion ([agent-workflow.md](agent-workflow.md)).
- Agents may run read-only commands (`git status`, `git diff`, `git log`, `git show`) to understand the working tree.
- Agents must never create, restore, or modify the repository-local `docs/` directory. It is
  intentionally prohibited and ignored; keep durable agent rules in `.agents/` when the developer
  explicitly requests them.
- At the end of each task, agents list **one commit message per changed file** and show the exact commands for the developer to run: one `git add <file>` and `git commit` pair per file, in the order defined in §2. For example:

```bash
git add src/database/tenant-transaction.service.ts
git commit -m "feat(db): add tenant transaction context"

git add test/unit/tenant-transaction.service.spec.ts
git commit -m "test(db): cover tenant transaction context"
```

## 2. Changes

- **One file per commit.** Every changed file gets its own commit with its own message that describes that file's change. This is the developer's standing rule.
- **Order commits by dependency:** a file comes before the files that import, test, or link to it (for example, a new rule document before the index that links to it; a stylesheet before the test that reads it; `schema.prisma` before its migration; `package.json` before `package-lock.json`).
- No unrelated edits: no drive-by reformatting, renames, or dependency bumps.
- Rule files (`.agents/`) are committed before or after code files, never interleaved with them.

## 3. Commit messages

Format: `type(scope): summary`

- `type`: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `style`, `perf`
- `scope`: a feature or area (`db`, `prisma`, `migrations`, `package`, `config`, `test`, `docs`, `rules`)
- `summary`: imperative, lowercase, no trailing period, at most 72 characters
- Add a body only when the reason is not obvious from the summary.

Examples: `feat(db): add tenant transaction context`, `fix(config): load local prisma environment`, `docs(rules): establish database engineering rules`.

## 4. What may be committed

| Commit                                                                                                    | Do not commit                                                  |
| --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Source, tests, styles                                                                                     | `.env`, `.env.local`, any file with secret values              |
| `prisma/schema.prisma`, `prisma/migrations/**`, `prisma/seed.ts`                                          | `src/generated/**` (Prisma Client output)                      |
| `package.json` and `package-lock.json` in consecutive commits, when dependencies change                   | `node_modules/`, `.next/`, `coverage/`, build output           |
| `.env.local.example` and `.env.production.example` with names, non-secret defaults, and placeholders only | Screenshots or exports containing personal data or credentials |
| `LICENSE`, `README.md`                                                                                    | `docs/`; editor and OS files (`.DS_Store`, local IDE settings) |

Notes:

- `.gitignore` ignores `.env*` but allows only `.env.local.example` and `.env.production.example`. These templates never contain credentials or environment-specific secret values.
- `package-lock.json` changes only through the developer's npm commands and is committed right after the matching `package.json` commit.
- The `.agents/skills/`, `.claude/skills/`, and `.windsurf/skills/` directories and `skills-lock.json` are agent tooling; committing them is the developer's choice.

## 5. Branches and history

- `main` stays demonstrable. Every new task uses a fresh short-lived branch named `type/short-description` (for example `feat/device-pairing`); corrections to the same open PR stay on its branch.
- No force pushes to `main` or any shared branch. No history rewriting after pushing.
- No destructive commands (`reset --hard`, `clean -fd`, `push --force`) without the developer's own decision.

## 6. Secrets in Git

- Before committing, the developer checks `git diff --staged` for keys, tokens, connection strings, and personal data.
- If a secret is ever committed, rotate it at the provider immediately. Removing it from history is not enough once it has been pushed.
- Treat every commit as potentially disclosed, even when the package and repository are private.

## 7. Acceptance criteria

- [ ] Every changed file has its own suggested commit, in dependency order (§2).
- [ ] Every suggested message follows §3.
- [ ] No ignored, generated, or secret files are included.
- [ ] The agent performed no Git writes.

## Branch and pull request workflow

- Every new implementation, fix, redesign, refactor or documentation task uses a fresh,
  short-lived branch from an updated `main`, unless the user explicitly specifies another
  base. Name it `type/short-description`, such as `feat/organization-registration`,
  `fix/sidebar-highlight`, `style/organization-cards` or `docs/pr-handoff-rules`.
- Before editing, report the affected repository, inspected current branch, proposed task
  branch, PR base and focused scope. If the current branch is `main` or belongs to another
  task, identify the mismatch and provide safe human branch-preparation commands. Keep the
  task separate before committing; do not add unrelated work to an existing PR.
- The human creates and switches branches under the existing Git execution rules. This
  policy does not authorize agent-run Git writes. Inspect local changes and unpushed commits
  before suggesting a switch. Never assume `origin/main` is current without a fetch, or
  discard work to prepare a branch.
- Continue corrections and review feedback for an open PR on its existing branch. After
  that PR is merged or abandoned, start a fresh branch for the next task. Do not recycle a
  merged branch for a new PR.
- One PR delivers one coherent, reviewable outcome and may contain multiple files and
  commits. Preserve the one-file-per-commit handoff; it does not require one PR per file.
  Keep required styles, dependencies, tests and verified security repairs with their feature.
- A task spanning repositories needs a separate branch and PR in each repository. State
  the dependency and merge order, and link related PRs when their actual URLs are available.
  A dependent or stacked PR may use another base only when that relationship is explicit.

## Required PR information at every task handoff

In addition to the existing per-file commit commands, always provide:

1. Repository, inspected current branch, proposed task/head branch and target/base branch.
2. A copy/paste PR title and Markdown description matching the final change. Describe the
   problem, resulting behavior, relevant limitations and verification evidence.
3. Actual checks executed and their outcomes; clearly mark unexecuted checks as not run.
   Include exact human verification commands and relevant manual checks. Documentation-only
   work does not require invented application tests.
4. Related PRs, prerequisites and merge order, or explicitly state that there are none.
5. Readiness: `DRAFT` while required checks, review or dependencies are pending. Use
   `READY FOR REVIEW` only when the stated verification requirements are satisfied. Never infer that
   CI passed or a PR was approved from local source inspection.
6. Safe human commands for branch preparation, per-file commits and pushing the exact task
   branch, plus instructions for opening the PR against its stated base. Avoid placeholders
   in commands when the actual repository and branch are known.

Report PR metadata as proposed until the PR exists. Include a PR number, URL, check result
or merge result only when it has actually been observed. Do not generate command scripts.

Merge into `main` only after required checks pass, relevant manual verification is complete,
review feedback is resolved and repository approval requirements are satisfied. Check the
actual merge policy before recommending a merge method. Creating a PR is not authorization
to merge, publish, deploy or run a migration; preserve the existing human execution boundary.
