# Git Workflow

**Purpose:** Keep Akiba Database history clean, reviewable, and free of secrets, with the developer in full control of every Git write.
**Applies to:** The end of every task, and anything that decides what may be committed.
**Related:** [agent-workflow.md](agent-workflow.md), [security.md](security.md), [package-management.md](package-management.md)
**Last reviewed:** 2026-10-12

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

- `main` stays demonstrable. Work on short-lived branches named `type/short-description` (for example `feat/device-pairing`) when the developer wants a branch.
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
