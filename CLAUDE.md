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

5 of 19 tasks implemented: build toolchain, test harness, shared types. No sync code or UI yet.

```bash
npx tsc --noEmit   # expect exit 0
npx vitest run     # expect 90 passed
```

`npm run build` fails until `src/main.ts` exists (Task 18). That is expected.

## Conventions

- Tests run **real isomorphic-git** against an in-memory filesystem; only the network is mocked.
  Do not mock git — that would mock away the thing being proven.
- `src/git/safe-git.ts` is the only module permitted to import `isomorphic-git`.
- Reviewers verify by **running** things, not by reading. See the workflow in the handover.
- Committing directly to `main` and pushing is authorised.
