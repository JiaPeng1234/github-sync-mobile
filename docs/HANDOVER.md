# Handover

Everything a fresh session needs to pick this up. Read this file first, then the two documents
it points at.

| Document | Purpose | When to read it |
|---|---|---|
| **This file** | State, how to work here, what to do next | First, always |
| [Design spec](superpowers/specs/2026-08-23-github-sync-mobile-design.md) | What is being built and why; the safety invariants | Before touching `src/git/` |
| [Implementation plan](superpowers/plans/2026-08-23-github-sync-mobile.md) | 19 tasks with exact code and tests | Before implementing any task |
| [Decisions and learnings](decisions-and-learnings.md) | Why choices were made; what review caught | Before changing a design decision |

---

## 1. What this is

An Obsidian plugin that syncs a vault to the user's own **private** GitHub repo, **from an
iPhone**, with manual git-like operations.

The repo: https://github.com/JiaPeng1234/github-sync-mobile · GPL-3.0-or-later · plugin id
`github-sync-mobile`.

**The defining requirement is not "sync". It is never silently losing data.** The author's previous
plugin destroyed uncommitted notes with a forced checkout. On iOS you cannot see or edit
`.obsidian`/`.git` and there is no git CLI, so there is no manual repair — every operation must be
safe by construction or must stop and explain. If you are ever choosing between "convenient" and
"cannot lose data", choose the latter.

Mobile is the **target**. Desktop is a development convenience only.

---

## 2. Current state

**11 of 19 tasks implemented.** The entire SafeGit safety core is now complete — repo state, status,
commit, safe merge, whole-file conflict resolution, and the connect/clone/fetch/push network surface —
all reviewed, plus a whole-module (cross-task) review that found and fixed two composition data-loss
seams. No sync service, no GitHub API client, no UI yet.

```
src/types.ts        Task 3 — PluginSettings, ConflictSide, ConflictFile, MergeOutcome, SyncReport…
src/constants.ts    Task 3 — defaults, TIMESTAMP_TOKEN, COMMIT_AUTHOR, repoUrl + isValidSegment
src/git/exclude.ts     Task 4 — the exclude matcher
src/git/fs-adapter.ts  Task 5 — DataAdapter → fs.promises bridge + readFailures channel
src/git/http-client.ts Task 6 — git HTTP over Obsidian requestUrl
src/git/safe-git.ts    Tasks 7-10 — the ONLY module importing isomorphic-git; all invariants
tests/mocks/        Task 2 — obsidian stub, in-memory DataAdapter
tests/git/, tests/helpers/  the SafeGit test suites + shared harness (repo.ts)
```

| Tasks | State |
|---|---|
| 1 Project scaffolding | ✅ implemented, spec review passed, quality review approved |
| 2 Test harness | ✅ implemented, spec review passed, quality review approved |
| 3 Types and constants | ✅ implemented, spec review passed, quality review approved after 4 rounds |
| 4 Exclude engine | ✅ implemented, both reviews passed |
| 5 Filesystem bridge | ✅ implemented, both reviews passed — quality review closed a coverage gap on the two content-read guards |
| 6 HTTP client | ✅ implemented, both reviews passed — real git http-backend + iso-git 1.41.8 clone confirmed the array response body works on the real route |
| 7 SafeGit: state + status | ✅ implemented + reviewed **with Task 8** — see note below |
| 8 SafeGit: commit | ✅ implemented + reviewed **with Task 7** — Task 7's tests call `commitLocal`, so they ship together |
| 9 **SafeGit: safe merge** | ✅ implemented + reviewed — binary pre-screen reproduced against real git; `type-change` unmergeable added |
| 10 **SafeGit: conflict resolution** | ✅ implemented + reviewed — `isPathAbsent` reproduced against real git; atomic screening; byte-safe `materialise` |
| 11 SafeGit: connect/clone/fetch/push | ✅ implemented, both reviews passed — `decideConnect`/`cloneSafe`/`initAndPush`/`fetch`/`push`; `cloneSafe` keeps excluded paths off disk and preserves user edits on re-run (probed against real git); `sameRepo` `.git` normalization mutation-pinned |
| 12 Sync service | ⬜ plan revised — `unmergeable` handling |
| 13 GitHub API client | ⬜ |
| 14 Log modal | ⬜ |
| 15 Conflict modal | ⬜ plan revised — binary/unreadable rendering |
| 16 Settings tab | ⬜ plan revised — exclude-everything warning + vault coverage readout |
| 17 Sync panel | ⬜ |
| 18 Plugin entry point | ⬜ plan revised |
| 19 Release workflow + README | ⬜ |

Tasks 9 and 10 were the hardest and most safety-critical, and are done. Task 12 (sync service) is the
next place a mistake could compose the safe primitives unsafely — see the seam warnings in §6.

### Verify the state yourself

```bash
npm ci
npx tsc --noEmit     # expect exit 0
npx vitest run       # expect 173 passed
```

`npm run build` will fail until `src/main.ts` exists (Task 18) — that is expected, not a break.

---

## 3. How to work here

Execution follows a fixed loop per task, one task at a time:

1. **Implement** — dispatch a subagent with the task's *full text pasted in* (do not make it read
   the plan) plus scene-setting context. Implementers use TDD: write the failing test, watch it
   fail for the right reason, implement, watch it pass, commit.
2. **Spec compliance review** — a separate subagent verifies the code matches the task, with
   nothing missing and nothing extra. Must pass before step 3.
3. **Code quality review** — a third subagent judges whether it is well built. Fixes go back to the
   implementer, then the reviewer re-reviews. Repeat until approved.
4. Commit and push. Then the next task.

**Models: ALL subagents run on Opus** (user instruction, 2026-08-26) — implementers included, not
just reviewers. This supersedes the earlier "implementers on Sonnet is adequate" convention. Pass
`model: "opus"` on every Agent/Workflow dispatch for this repo.

**The single most important instruction for reviewers: verify by running things, not by reading.**
Every serious defect found so far came from a reviewer who built a probe outside the repo and
executed real git. The worst one — silent corruption of binary attachments on the clean-merge path —
would not have been found by inspection. Also tell reviewers to weigh findings by whether data could
actually be lost, and to say plainly when what remains is polish; otherwise rounds do not converge.

**Fix the plan, not just the code.** Several review rounds found defects in code that did not exist
yet. Correcting the plan is cheap; rediscovering the same defect after the task ships is not. When a
task's code changes during review, **sync the plan section from the real files** rather than editing
it by hand — hand re-transcription reintroduced a literal NUL byte into an already-fixed code block.

**Mutation-test the guards.** This has found more real defects than any other single technique. Copy
`src/`, `tests/`, and the configs to a temp dir with `node_modules` symlinked, break one guard, and
run that task's tests. If they still pass, the guard is decorative. Two examples from Task 4/5, both
of which passed a fully green suite: replacing the wildcard placeholder with a printable character,
and deleting the exact-size `ArrayBuffer` copy. Every safety-relevant line should have a mutant that
kills it.

**Ask the implementer two or three probing questions beyond the spec.** Not "did you do it" but
"what surprising input did you find", "can this be made to hang", "does real isomorphic-git actually
work through this". Nearly every serious finding started as an answer to one of these. Insist on
measured answers rather than reasoned ones.

**A test that reaches the code by a convenient route proves nothing about the real route.** Two
instances so far: a test called `fs.stat(".")` when the library actually sends `"/."`, and a test
used a helper that failed `stat` when the guard under test was on `list`. Both passed while the code
was broken. Ask how the production caller actually gets there.

**When a dependency swallows errors, your error code is a decoration.** isomorphic-git's `readdir`
reports any failure as an empty directory, and its `read` returns `null` on any failure. Throwing the
right code changes nothing downstream. Always ask what the library *does* with a failure, not what
you threw. This has bitten three times.

**Disclose your own commits** when dispatching a reviewer, or it will reasonably flag them as scope
creep.

Committing directly to `main` and pushing is authorised for this repo.

---

## 4. Things that will bite you

Load-bearing details that look like noise. Do not "clean these up".

**`buffer` is deliberately bundled, not external.** Mobile has no Node runtime, and
isomorphic-git's dependencies need a global `Buffer`. `buffer-shim.mjs` is injected into every
module. Removing it breaks the plugin on iOS.

**Never produce a native Node `Buffer`.** esbuild's `inject` shadows the `Buffer` identifier on
every platform, and the polyfill's `Buffer.isBuffer` tests `_isBuffer === true`, which is false for
a native Buffer — while isomorphic-git's GitIndex calls `Buffer.isBuffer(...)`. Stay on
`Uint8Array`/`ArrayBuffer` everywhere.

**`platform: "browser"` in esbuild is load-bearing.** It decides whether isomorphic-git resolves
its browser entry or its Node entry (which requires `crypto` and `path`). Node builtins are
deliberately *not* externalised, so any builtin import fails the build instead of crashing on a
phone.

**All HTTP goes through Obsidian's `requestUrl`.** Not `fetch`. This is what removes the CORS-proxy
dependency, which matters because a proxy would see a private vault's contents. Two rules:
always `await` the call then read properties (the awaitable-property form `requestUrl(p).json` is
not modelled by the test stub and reads as `undefined` under test); and always pass `throw: false`
and inspect the status yourself, never keying on `err.status`.

**`tsconfig.json` sets `noImplicitOverride`.** Methods overriding concrete Obsidian base members
(`Plugin.onload`/`onunload`, `Modal.onOpen`/`onClose`, `PluginSettingTab.display`, `ItemView`
lifecycle) need the `override` keyword. Let `tsc` settle the exact set — abstract members must not
carry it.

**The test filesystem is deliberately strict.** It refuses to create parent directories on write,
and `list()` throws for a missing path and for a file path. Both mirror the real adapter. Real
isomorphic-git recovers from the write case on its own (it catches the failure, mkdirs the parent,
and retries — verified), so keep the strictness. Where the mock is stricter than reality the
failure mode is a false test failure, never a false pass.

**But error codes do not reach the git layer on the read path.** isomorphic-git's `readdir` maps
only `ENOTDIR` to `null` and swallows everything else — `ENOENT` included — as `[]`, an empty
directory. So a directory read that fails transiently is indistinguishable from an empty folder,
and every file beneath it is reported as **deleted**. That is why the fs bridge exposes a
`readFailures` channel out of band and `SafeGit` refuses any status it cannot trust, and why every
staged deletion is confirmed against the working tree first. `MemoryAdapter.failReadsAt(path, code)`
exists so this is testable. Do not assume an error code you throw will be visible downstream —
check the library.

**Excluded paths are inert in both directions, and never register as deletions.** The remote may
already track `.obsidian/*`. A naive status computation sees "in HEAD, absent from disk" and
concludes the user deleted them, then pushes the removal. The exclude filter must erase excluded
paths from status entirely.

**Excluding `.obsidian/` is a security requirement.** The PAT lives in
`.obsidian/plugins/github-sync-mobile/data.json` in plaintext. Syncing that directory publishes the
token.

**`lib: ["ES2018","DOM"]` does not actually enforce ES2018.** `types: ["node"]` pulls in
`@types/node`'s own `lib="es2020"` reference, so `Array.flat`, `Object.fromEntries` and
`Promise.allSettled` typecheck silently. esbuild downlevels *syntax*, not APIs. In practice
Obsidian mobile runs a modern WebView so this is low risk, but do not treat a clean `tsc` as
proof that an API is available on device.

**Binary content must never pass through a string.** See §5.

---

## 5. The safety invariants

From [design spec §6](superpowers/specs/2026-08-23-github-sync-mobile-design.md). These are
enforced centrally in `src/git/safe-git.ts`, the only module allowed to import `isomorphic-git`.
Destructive primitives are module-private; the exported class exposes no parameter that could turn
a safe call into a clobbering one.

1. Dry-run before anything that touches the working tree. If the probe reports a conflict, write
   nothing.
2. Local changes are committed **before** any merge. This closes isomorphic-git #1046, where a pull
   silently discards uncommitted edits.
3. `force` is never used. `checkout({force:true})` exists on no exported path — this is the exact
   call that destroyed the author's notes.
4. Excluded paths are inert in both directions and never register as deletions.
5. "Local is empty" means no non-excluded files exist. A `.obsidian/` created by installing via
   BRAT does not count as content.
6. A vault already connected to one repo refuses to connect to another.
7. Multiple merge bases and unrelated histories are caught and reported as `unmergeable`, never
   allowed to crash or improvise.
8. Every step is idempotent. Re-running from any interrupted state must be safe — iOS can kill the
   app mid-operation.

Plus two learned the hard way, both in [decisions-and-learnings.md](decisions-and-learnings.md):

9. **A failed read is never a deletion — including a failed directory read.** See the note above
   about `readdir` swallowing errors as an empty listing. Guarded by the bridge's `readFailures`
   channel plus per-deletion confirmation, not by error codes.
10. **Binary content never passes through a string.** A non-fatal `TextDecoder` replaces invalid
   UTF-8 with U+FFFD irreversibly. `ConflictSide` is `absent | text | binary | unreadable`; bytes
   stay bytes; text is decoded only with a **fatal** decoder, which is also how binary is detected.
   And before the engine merges anything, a pre-screen refuses to let it touch a file changed on
   both sides that is binary in any of base/ours/theirs — because isomorphic-git's own merge does
   the same lossy round trip internally and reports a *clean* merge while doing it.
11. **"Could not read" is never "was deleted."** Resolution acts on `absent` by unlinking and
    committing, so a torn packfile must not be classified as a deletion. `isPathAbsent` discriminates
    on the *shape* of `data.what` — a bare 40-hex string is a missing object, anything else is a
    missing path.

---

## 6. What to do next

**Tasks 5–11 are done** — the SafeGit safety core is COMPLETE — all fully reviewed (spec +
code-quality + mutation + real-git probes), plus a whole-module (cross-task) review that found and
fixed two composition data-loss seams. The entire SafeGit surface exists in `src/git/safe-git.ts` —
the only module allowed to import isomorphic-git — with `isRepo`, `hasLocalContent`, `status`,
`commitLocal`, `mergeSafe`, `resolveConflicts`, `abandonConflict`, `restoreFromHead`,
`confirmDeletion`, `decideConnect`, `cloneSafe`, `initAndPush`, `fetch`, `push`, and module-private
`isPathAbsent`/`sameRepo`. Every guard is reproduced against real iso-git 1.41 and mutation-pinned.
173 tests.

**Next is Task 12 (sync service)** — the first place a mistake could compose the safe primitives
unsafely. Its plan is already revised; heed the seam warnings below and in the Task 12 plan header.

Load-bearing facts from the SafeGit rounds that a Task 11+ session must carry:

- **`hasLocalContent` throws on a read failure** (not returns false). A transient read over a vault
  *with* notes must never look "empty" and send `decideConnect` down clone-safe (which would write the
  remote over real notes). **Task 11's `decideConnect` must let that throw propagate** — do NOT wrap it
  in a try/catch that treats a failure as "no local content".
- **`isPathAbsent` — the line that deletes on `absent` — is correct against real git's four error
  shapes** (missing path → absent; missing/corrupt object → unreadable/refuse). It keys on the *shape*
  of `data.what`, never on comparing the commit oid.
- **`commitLocal` refuses an ambiguous interrupted-checkout deletion** (`[head=1, workdir=0, stage=0]`
  — a remote-added file left un-materialised when an app kill interrupted a fast-forward/merge). This
  refusal is **resolvable, not terminal**: `restoreFromHead(paths)` re-materialises from HEAD (the
  "interrupted download" case), `confirmDeletion(paths, message)` commits the deletion after the user
  confirms it. These are the advanced-op backend for the conflict modal / sync view.
- **`mergeSafe` clears `pending` on non-conflict exits; `resolveConflicts` refuses a stale `pending`**
  whose heads no longer match the live refs. Do not cache and replay a conflict resolution across a
  later fetch/merge.

**Task 12's sync sequence must not undo those SafeGit guards** — do not force past `commitLocal`'s
interrupted-checkout refusal (re-run the merge/checkout instead), and re-derive conflicts from a fresh
`mergeSafe` rather than replaying a stale resolution.

**Advanced/manual mode boundary (user, 2026-08-26; design WITH them at Task 15/17):** the primary path
is one Sync button; manual Fetch/Merge/Commit/Push buttons should feel like a laptop git CLI (drop
convenience nagging) but must NOT drop the stop-and-ask on the ambiguous `[1,0,0]` deletion — that is a
data-loss decision and iOS has no CLI to undo a wrong guess. Manual controls *timing*, not *whether
data can be lost silently*. Plan notes are on Task 15 and Task 17.

**Minimum phone-testable version: after Task 18** (creates `src/main.ts`, the first build that
installs). Tasks 12→18 remain; Task 19 (release/docs) is not needed to sideload a dev build. Test
against a throwaway vault + a private test repo before the real vault.

**All subagents run on Opus** (user, 2026-08-26) — implementers included, superseding §3's "implementers
on Sonnet" line below.

**Task 11 is done** — `decideConnect`/`cloneSafe`/`initAndPush`/`fetch`/`push` shipped and reviewed.
Its carried obligation held: `decideConnect` lets `hasLocalContent()`'s read-failure throw propagate
(a live read-failure probe confirmed it refuses rather than falling to clone-safe), and `cloneSafe`
keeps excluded paths off disk with `force:false`, preserving user edits even when re-run after an
interrupted checkout (both probed against real git).

**Start with Task 12, the sync service** (`src/sync/sync-service.ts`). It orchestrates SafeGit's safe
exports into the fixed sequence — commit → fetch → merge → push — and knows the ORDER; SafeGit knows
the safety. The plan section has the full code and 8 tests; the service is pure orchestration over an
injected `SafeGit`, so its tests use a **fake** git (unlike the SafeGit suites, which run real git).
Heed the two seam warnings (in the Task 12 plan header and below): do not force past `commitLocal`'s
interrupted-checkout refusal (re-run the merge/checkout instead), and do not cache and replay a
conflict across a later fetch/merge — re-derive it from a fresh `mergeSafe`.

**Then Tasks 13 → 19:** the GitHub API client (13), and the UI (log modal 14, conflict
modal 15, settings tab 16, sync view 17, plugin entry point 18, release workflow 19). **Task 18 is the
first time `src/main.ts` exists and `npm run build` can succeed — and the first installable build, so
it is the minimum phone-testable milestone.** Task 19 ends with manual testing on the author's iPhone
— the final gate; a green suite is not shipping confidence.

### Deferred by decision, not oversight

- **Line-level conflict resolution is phase 2.** Phase 1 stops safely and offers whole-file choice.
- **Mobile memory/OOM is an accepted, bounded risk** ([spec §9](superpowers/specs/2026-08-23-github-sync-mobile-design.md)).
  Shallow cloning would save memory but removes the history merges need for a merge base, so the
  plugin keeps full history on a single branch and advises excluding large binaries instead.
- **`.obsidian/` sub-toggles** (for example "sync themes") are not offered: themes live inside
  `.obsidian/` and the exclude grammar has no negation, so the option would imply a capability that
  does not exist.

### The last gate

Task 19's checklist ends with manual testing on the author's iPhone. Automated tests cover the
data-loss paths; the phone is the final gate. Do not treat a green suite as shipping confidence — and
test against a throwaway vault before the real one.
