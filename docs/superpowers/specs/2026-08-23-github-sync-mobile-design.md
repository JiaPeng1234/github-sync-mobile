# github-sync-mobile — Design

**Date:** 2026-08-23
**Status:** Approved design, pending implementation plan
**Repo:** https://github.com/JiaPeng1234/github-sync-mobile
**License:** GPL-3.0

## 1. Purpose

An Obsidian plugin that lets a user sync their vault to their own **private** GitHub
repo **from an iPhone**, with the reliability and honesty of a desktop git client.

It exists because the prior plugin the author used (`github-valut-sync` /
`git-obsi-sync`) **destroyed uncommitted notes**, was hard to iterate on, and carried
more scope than needed. This plugin's core value is not "sync" — many things sync.
Its core value is **never silently losing data**, on a platform where the user has no
way to inspect or repair anything by hand.

### Primary constraint: iOS has no escape hatch

On iOS you cannot see or edit `.obsidian/` or `.git/`, and there is no git CLI. So the
plugin can never rely on the user manually fixing a bad state. Every operation must be
either safe by construction, or stopped and explained.

## 2. Non-goals (phase 1)

- Auto-sync / background sync. Sync is **manual**, by explicit user action.
- Line-level (diff3) conflict merging → **phase 2**.
- Branch management or switching. Single branch only.
- SSH auth (impossible on iOS).
- Desktop-specific features. Desktop is a development/testing convenience only.

## 3. Key decisions

| Decision | Choice | Why |
|---|---|---|
| Git engine | **isomorphic-git** + strict safety layer | Only turnkey engine that does real fetch/merge/conflict/push on iOS Obsidian. See §4. |
| Auth | **Fine-grained PAT**, pasted by user | No OAuth/GitHub App to register (the prior plugin's friction). SSH impossible on iOS. |
| Sync UX | **One "Sync now" button** + `Advanced` (Fetch/Pull/Push) | One-tap daily use; raw verbs available for manual control. |
| Conflict (phase 1) | Safe-abort, then **whole-file two-way choice** (Keep mine / Keep theirs) | User can self-resolve on the phone; nothing is ever silently dropped. Line-level → phase 2. |
| Exclude model | Opinionated safe defaults + simple toggles + advanced globs | Safe by default; excluding a path is the user's manual protection lever on iOS. |
| Safety architecture | **SafeGit chokepoint** + dry-run probe + gated verbose log | Dangerous verbs have no reachable call site. |
| Connect scope | Assume **cloud has content, local vault is empty** | Simplifies phase 1 enormously; violation → refuse with explanation, never improvise. |
| Testing | Unit + safety tests against mock fs/http, desktop smoke, then **user tests on iPhone** | Proves the data-loss paths safe without risking a real vault. |

## 4. Why isomorphic-git (and what it costs us)

Researched alternatives, all rejected:

- **wasm-git (libgit2→WASM)** — FS model (Emscripten MEMFS/OPFS) does not map to Obsidian's
  vault adapter; HTTP transport cannot be routed through `requestUrl`; **merge is not even
  exposed in its JS API**; ~1 MB WASM. Unproven on Obsidian mobile.
- **es-git / nodegit** — native modules, Node-only. **Disqualified on iOS.**
- **GitHub REST / Git Data API (no local repo)** — runs on iOS, but the server does **no
  3-way merge and no conflict resolution** (its merge endpoint returns a bare 409 with no
  conflict body). That means last-write-wins — the exact failure mode we are escaping —
  unless we hand-build a merge engine. Also fights content-creation rate limits.
- **Native git** — impossible in the mobile sandbox (this is why the popular Obsidian Git
  plugin is desktop-only for native git and falls back to isomorphic-git on mobile).

isomorphic-git is actively maintained (v1.41.x, ~1.7M downloads/week), is pure JS, has a
pluggable `fs` that maps onto Obsidian's `DataAdapter`, and a pluggable `http` client we
route through Obsidian's `requestUrl` — which also **eliminates the CORS-proxy dependency**
that browser isomorphic-git normally needs (important: no third-party proxy ever sees a
private vault).

### The costs we must engineer around

These are real, documented, and unfixed upstream. **The data loss was never the engine's
fault — it was the prior plugin issuing reckless commands.** The engine will faithfully do
dangerous things if told to:

1. **`pull`/`merge` silently discards uncommitted local changes** (isomorphic-git issue
   #1046, still open; maintainer's own words: "data loss by default"). → Mitigated by
   Invariant 2.
2. **`checkout({force:true})` has no "untracked files would be overwritten" guard.** This is
   precisely what destroyed the author's notes. → Mitigated by Invariant 3.
3. **No first-class conflict detection** — `statusMatrix` cannot represent an unmerged file.
   → We detect via dry-run probe + caught errors, never by trusting status alone.
4. **No recursive merge**; throws when multiple merge bases exist (the criss-cross case from
   two diverging devices). → Mitigated by Invariant 7.
5. **Mobile memory/OOM** on large repos. → See §9, accepted risk with mitigations.
6. **Interrupt sensitivity** (iOS suspending/killing the app mid-write). → Mitigated by
   Invariant 8.

## 5. Architecture

One module owns the git engine. Dangerous operations are unreachable from anywhere else.

```
main.ts                  lifecycle: load settings, wire UI, own the single GitService instance
│
├── git/
│   ├── safe-git.ts      THE CHOKEPOINT. The only file that imports isomorphic-git.
│   │                    Exports ONLY safe ops: decideConnect, cloneSafe, initAndPush,
│   │                    status, commitLocal, fetch, mergeSafe, resolveConflicts,
│   │                    abandonConflict, push.
│   │                    force-checkout / bare-merge / bare-pull are private, NOT exported.
│   ├── fs-adapter.ts    Obsidian DataAdapter → isomorphic-git `fs` (promises shape)
│   ├── http-client.ts   isomorphic-git http client routed through Obsidian `requestUrl`
│   └── exclude.ts       exclude engine: compile patterns → matcher, applied at EVERY touchpoint
│
├── sync/
│   └── sync-service.ts  orchestrates the Sync sequence using ONLY safe-git's exports;
│                        emits a step-by-step SyncReport
│
├── ui/
│   ├── sync-view.ts     "Sync now" + status (ahead/behind/changed) + Advanced verbs
│   ├── settings-tab.ts  PAT, repo owner/name, exclude toggles + advanced globs, verbose log
│   ├── conflict-modal.ts per-file "Keep mine / Keep theirs"
│   └── log-modal.ts     on-screen step trace (mobile has no console)
│
├── github/api.ts        minimal REST via requestUrl: verify token, repo exists/empty
├── types.ts             PluginSettings, SyncReport, SyncStep, ConflictFile, MergeOutcome
└── constants.ts         default branch "main", default excludes, commit author
```

**Boundaries.** `safe-git.ts` is the only importer of `isomorphic-git`; if a dangerous verb
is not exported, UI and sync code physically cannot call it. `fs-adapter`, `http-client`,
and `exclude` are pure and dependency-light, so the safety tests can prove "never overwrites
untracked files" against mocks, with no real vault involved. `sync-service` knows the
*sequence*; `safe-git` knows the *safety*.

## 6. Safety invariants (enforced inside SafeGit)

These are non-negotiable and centrally enforced.

1. **Dry-run before any working-tree-touching operation.** Simulate first. Only execute if
   the probe is clean. If the probe reports conflict, write **nothing**.
2. **Local changes are committed before any merge.** This closes isomorphic-git #1046: by
   merge time there are no uncommitted edits left to discard.
3. **`force` is never used.** `checkout({force:true})` exists on no exported path.
4. **Excluded paths are fully inert, in both directions** — not cloned, not staged, not
   merged, not pushed. **And they never register as deletions** (see §7).
5. **"Local is empty" means: no non-excluded files exist.** A `.obsidian/` created by
   installing the plugin via BRAT does not count as content.
6. **A vault already connected to one repo refuses to connect to another.** Disconnect first.
7. **Multiple merge bases and unrelated histories are caught and reported as `unmergeable`**
   — a distinct outcome from a conflict, never a crash and never improvisation. They are kept
   distinct because they demand different responses: a conflict is resolvable per file in the
   app, whereas an unmergeable history cannot be resolved here at all. Collapsing them forced
   consumers to discriminate on `files.length` instead of on the outcome tag.
8. **Every step is idempotent.** Re-running Sync from any interrupted state must be safe.
   The commit→fetch→merge→push ordering means any interruption *between* steps leaves a
   valid git state; the dry-run rule means we never leave a half-merged working tree.
9. **A failed read is never a deletion — including a failed *directory* read.**
   isomorphic-git's `readdir` maps only `ENOTDIR` to `null` and swallows every other error,
   `ENOENT` included, as `[]` — an empty directory. A transient failure therefore makes every
   file beneath a folder look deleted while the files are still on disk, and committing that
   would push a removal of files that exist. No error code is visible to the walker, so the
   filesystem bridge records such failures out of band and `SafeGit` refuses any status it
   cannot trust. Every staged deletion is additionally confirmed against the working tree
   before it may be committed.

**Logging.** The dry-run *probe* is permanent — it is a safety mechanism. The on-screen
*verbose narration* is behind a setting, **default off**, enabled during bring-up and mobile
testing, disabled in stable releases.

## 7. The exclude engine

Excluding a path is the user's **manual protection lever on iOS**, precisely because hidden
files cannot be inspected or repaired by hand there. It must therefore be powerful and
trustworthy enough to lean on.

**Defaults (excluded out of the box):** `.obsidian/`, `.git/`, `.trash/`.

**UI:** a single toggle for syncing `.obsidian/` (default off, and warned about — see below),
with a raw glob list under *Advanced*.

Per-item toggles such as "Sync themes?" are **not** offered. Themes live inside `.obsidian/`,
and the exclude grammar has no negation, so "exclude `.obsidian/` except themes" is not
expressible. Offering the toggle would imply a capability the engine does not have.

**Enforced at every touchpoint:** clone-checkout, staging, status computation,
merge-checkout, push.

### The phantom-deletion trap (critical)

The user's cloud repo **already tracks `.obsidian/*`**. We exclude those paths, so they are
never written to disk. But they remain in HEAD and the index. A naive status computation
sees "in HEAD, absent from disk" and concludes **the user deleted them** — then commits and
pushes those deletions, wiping `.obsidian/*` from the cloud.

Therefore: **the exclude filter must erase excluded paths from status computation entirely.**
They are not modifications, not deletions, not anything. Phase 1 also **never alters the
remote's tracking** of those files (no `git rm --cached`) — zero side effects on the remote.

### Security: excluding `.obsidian/` protects the PAT

Obsidian stores plugin settings in `.obsidian/plugins/<id>/data.json` in **plaintext**. If
`.obsidian/` were synced, **the user's GitHub token would be published to GitHub.** The
default exclusion prevents this, which promotes it from a convenience to a security
requirement. If the user tries to un-exclude `.obsidian/` in Advanced settings, the plugin
must **warn explicitly about token leakage**.

## 8. Flows

### 8.1 Connect

Phase 1 assumes the common real case: **the cloud repo already has content, and the phone's
vault is empty.** When that assumption is violated, the plugin **refuses and explains** — it
never improvises.

```
Already connected to a different repo?
  └─ yes → REFUSE: "This vault is already connected to <repo>. Disconnect first."

Remote has content, local has no non-excluded files      → CLONE-SAFE   ← primary path
Remote has content, local HAS real notes                 → REFUSE + explain:
      "This vault already contains notes. Connecting would mix two histories.
       Use an empty vault, or reconcile on desktop first."
Remote is empty                                          → init + commit + push (secondary)
```

**CLONE-SAFE** is the mechanism that fixes the author's original blocker:

1. `git.clone({ noCheckout: true, singleBranch: true })` — fetch history, **write nothing**.
2. Check out **only non-excluded paths**, never with `force`.

Result: the remote's `.obsidian/*` stays in history but **never lands on disk**, so it cannot
collide with the `.obsidian/` that BRAT just created on the phone. Nothing is force-overwritten.

### 8.2 Sync now

```
1. COMMIT LOCAL   stage changed non-excluded files; commit only if a real diff exists
2. FETCH          update remote-tracking ref; writes nothing to the working tree
3. MERGE (safe)   dry-run probe first:
                    · fast-forward possible → apply
                    · clean merge possible  → create merge commit
                    · CONFLICT              → ABORT (tree untouched) → conflict modal → STOP
4. PUSH           only if no conflict AND local is genuinely ahead
```

**Why this order.** Committing before merging is the single most important rule (Invariant 2).
Merging before pushing is required because a remote that is ahead cannot be pushed to. If
step 3 conflicts, we never reach step 4.

**Partial failure is safe.** If fetch fails (offline) or push fails (bad token), earlier steps
already succeeded and are durable — e.g. the local commit survives a failed push. The step
that failed is reported.

The **Advanced** verbs run these same safe implementations individually, unchained.

### 8.3 Conflict resolution (phase 1)

Detected by dry-run **before anything is written**.

```
Conflict detected → abort merge; working tree byte-identical; local commit safe
  → modal lists conflicting files; per file: [Keep mine] [Keep theirs]
       · resolved → commit the resolution, then push
       · dismissed → nothing changes; next Sync offers it again
```

This is safe because **both versions already exist in git history** — the losing side is
postponed, never destroyed. Whole-file choice also happens to be the *right* granularity for
binary attachments (images, PDFs), where line-merging is meaningless.

For that to actually hold, a conflicting side is carried as **bytes, not a string**. Decoding a
blob to text is lossy — a non-fatal decoder replaces every invalid UTF-8 byte with U+FFFD — so
carrying an attachment as a string and writing it back would silently corrupt it and commit the
damage. A side is therefore one of: absent (that side deleted it), text, binary, or
**unreadable**. The last is deliberately distinct from absent: a failed blob read (a torn
packfile after iOS killed the app mid-write, or an out-of-memory on a large attachment) must
never be mistaken for a deletion, because resolution acts on absent by deleting and committing.
An unreadable side is refused before anything is written.

**Binary files are never merged by content.** isomorphic-git's own merge decodes both sides with
a non-fatal UTF-8 conversion and re-encodes the result, so letting it merge a binary silently
corrupts it — and because the three-way algorithm usually finds separable regions in a large
file, it reports a *clean* merge and never asks. Measured: a 240-byte attachment edited on two
devices came back at 676 bytes containing 218 replacement characters, reported as a clean merge.

So before the engine is invoked at all, the plugin compares blob oids across base/ours/theirs in
a single tree walk, and asks whether any path changed on both sides is binary — decided by
whether its bytes survive a *strict* UTF-8 decode, not by file extension. If any is, every
both-sides change is surfaced for whole-file choice and the engine's merge never runs. The
breadth is deliberate: conflicting on the binary alone would leave text files that also changed
on both sides to be swept in as "theirs", discarding this device's edits to them. The check
ignores exclude patterns, because an excluded path can still be tracked by the remote and the
engine merges the whole tree regardless of what is checked out — "don't sync this" must not
become "corrupt this silently".

When no binary is involved the engine still merges text, so two devices editing different
regions of the same note continue to combine cleanly instead of being forced into a choice.

A merge driver was considered and rejected: `mergeDriver` replaces the default driver outright,
so refusing there would have turned every ordinary text merge into a whole-file choice.

Known limits of the detector: UTF-16 without a byte-order mark, and all-NUL content, decode as
valid UTF-8 and are treated as text. Neither can be corrupted byte-wise — valid UTF-8 round-trips
exactly — so the residual risk is line-based splicing of a non-line-oriented file, and Obsidian
vaults are UTF-8.

**Phase 2** adds line-level resolution (diff3, conflict markers) on top of this seam without
redesigning phase 1.

## 9. Accepted risks

**Mobile memory / OOM — not solved, consciously bounded.** The reference plugin documents
"limited repo size because of memory restrictions", possible crashes on clone/pull, and buffer
overflow errors on mobile.

There is a genuine tension: `depth: 1` shallow cloning saves memory, **but without history
there is no merge base, so later merges fail.** We therefore use `singleBranch: true` with
**full history** to keep merges working, and instead advise keeping large binaries (images,
PDFs, video) out of the synced set via exclude patterns. If OOM proves real in practice,
revisit with shallow-clone-plus-deepen. This is stated as an open risk rather than a solved
problem.

## 10. Error handling

- Every operation returns a structured result; nothing throws into the UI unhandled.
- Failures are reported **per step**, naming which step failed and what is still safe.
- Network errors surface the real error (never swallowed) — the prior plugin's habit of
  hiding fetch errors made diagnosis impossible.
- Because mobile has no console, errors always surface in the on-screen log modal with a
  copy button, regardless of the verbose-logging setting.

## 11. Testing strategy

Mobile is the **target**; desktop is a development convenience.

1. **Unit + safety tests (primary)** — against a **mock `fs` and mock `http`**, so the
   dangerous paths are proven without a real vault. Mandatory coverage:
   - never overwrites an untracked file, on any path including clone
   - exclude filter honored at clone / stage / status / merge / push
   - excluded paths never register as deletions (the phantom-deletion trap)
   - dirty working tree is committed before merge
   - conflict → abort leaves the working tree byte-identical
   - refuses to connect when already connected, and when local has real notes
2. **Desktop smoke test** against a throwaway private repo.
3. **Manual iPhone testing by the author** — the final gate.

## 12. Configuration

| Setting | Default |
|---|---|
| GitHub PAT (fine-grained, contents read/write on one repo) | empty |
| Repo owner / name | empty (explicit, so the right repo is connected) |
| Branch | `main` |
| Excluded paths | `.obsidian/`, `.git/`, `.trash/` |
| Verbose logging | **off** |
| Commit message template | `Vault sync from mobile — <timestamp>` |

Auto-generated commit messages are required by the one-tap UX (prompting for a message every
sync would defeat it); the template is user-editable.

## 13. What we keep and drop from the prior plugin

**Keep** (it genuinely worked on iOS, which is rare):
- isomorphic-git as the engine
- `requestUrl`-based HTTP client (mobile-safe, no CORS proxy)
- `DataAdapter`-based fs bridge
- bundled Buffer polyfill (isomorphic-git's deps need a global `Buffer` in the WebView)
- on-screen log modal (mobile has no console)
- clone with `noCheckout` + filtered checkout (its eventual fix — now a founding rule)

**Drop:**
- OAuth Device Flow + user-registered Client ID → replaced by a pasted PAT
- auto-sync on vault events → manual only
- any reachable `force: true` checkout → structurally impossible
- raw-glob-only exclude configuration → safe defaults + toggles, globs under Advanced
- silent conflict suppression → conflicts are always surfaced
