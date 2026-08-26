# github-sync-mobile

An Obsidian plugin that syncs a vault to the user's own private GitHub repo, **from an iPhone**,
with manual git-like operations.

## Read this first

**→ [docs/HANDOVER.md](docs/HANDOVER.md)** — current state, how to work here, what to do next.

It is the entry point. Everything else hangs off it:

| Document | Purpose |
|---|---|
| [docs/HANDOVER.md](docs/HANDOVER.md) | State, workflow, pitfalls, next task |
| [docs/superpowers/specs/2026-08-23-github-sync-mobile-design.md](docs/superpowers/specs/2026-08-23-github-sync-mobile-design.md) | Design and the safety invariants |
| [docs/superpowers/plans/2026-08-23-github-sync-mobile.md](docs/superpowers/plans/2026-08-23-github-sync-mobile.md) | 19 tasks, with exact code and tests |
| [docs/decisions-and-learnings.md](docs/decisions-and-learnings.md) | Why decisions were made; what review caught |

## The one thing to know

**The defining requirement is not "sync". It is never silently losing data.**

The predecessor plugin destroyed the author's uncommitted notes with a forced checkout. On iOS you
cannot see or edit `.obsidian`/`.git` and there is no git CLI, so there is no manual repair. Every
operation is either safe by construction or stops and explains itself.

When choosing between convenient and cannot-lose-data, choose the latter.

## Status

10 of 19 tasks implemented. The entire SafeGit safety core exists (`src/git/safe-git.ts` — repo
state, status, commit, safe merge, whole-file conflict resolution), all reviewed. No sync service,
GitHub API client, or UI yet. Next is Task 11 (connect/clone/fetch/push). See
[docs/HANDOVER.md](docs/HANDOVER.md) §6 for exact next steps and the guards a new session must carry.

```bash
npm ci
npx tsc --noEmit   # expect exit 0
npx vitest run     # expect 166 passed (run a single file: npx vitest run tests/git/safe-git-merge.test.ts)
```

`npm run build` fails until `src/main.ts` exists (Task 18) — that is expected, not a break. Task 18 is
also the first installable build (the minimum phone-testable milestone).

## Conventions

- Tests run **real isomorphic-git** against an in-memory filesystem; only the network is mocked.
  Do not mock git — that would mock away the thing being proven.
- `src/git/safe-git.ts` is the only module permitted to import `isomorphic-git`.
- **Work runs through subagents on a fixed per-task loop** (implement → spec review → code-quality
  review → commit), and **every subagent runs on Opus** (implementers included). The judgment lives
  in the reviews.
- **Reviewers verify by running, not reading** — build a probe outside the repo, execute real git,
  and mutation-test every safety guard (break the guard, confirm a test dies). Every serious defect
  found here — including silent binary corruption and two cross-method data-loss seams — was caught
  that way, not by inspection. Weigh findings by whether data could actually be lost.
- **Fix the plan, not just the code**, and sync plan code blocks from the real files (hand
  re-transcription once reintroduced a NUL byte). Never produce a native Node `Buffer` — stay on
  `Uint8Array`/`ArrayBuffer` (see HANDOVER §4).
- Committing directly to `main` and pushing is authorised.
