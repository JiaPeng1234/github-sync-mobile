# Decisions and learnings

A running log of the decisions that shaped this plugin and the things review caught that
were not obvious. Newest sections last within each part.

Companion documents:
- [Design spec](superpowers/specs/2026-08-23-github-sync-mobile-design.md) — what is being built
- [Implementation plan](superpowers/plans/2026-08-23-github-sync-mobile.md) — how, task by task
- [Handover](HANDOVER.md) — start here if you are new to this repo

---

## Part 1 — Why this project exists

The author previously used `github-valut-sync` (plugin id `git-obsi-sync`), a third-party
Obsidian plugin. It **destroyed uncommitted notes**: versions up to 1.0.13 ended `sync()` with
`git.checkout({ ref: "main", force: true })` and no `filepaths`, forcing the whole working tree
to match the remote. Daily notes that had never been committed were deleted. Recovery was only
possible through Obsidian's File Recovery store, because git had no copy.

Three further problems motivated writing a replacement rather than patching:

1. Iterating on someone else's plugin meant waiting on review cycles.
2. It carried more scope than needed (auto-sync, OAuth device flow, its own Client ID setup).
3. Connecting a fresh phone failed with "local changes would be overwritten", because the cloud
   repo tracked `.obsidian/*` while the phone had its own live `.obsidian/*` from installing the
   plugin via BRAT.

The last one is worth dwelling on: **on iOS you cannot see or edit `.obsidian` or `.git`, and
there is no git CLI.** So the usual escape hatch — delete the conflicting file by hand — does not
exist. That single constraint drives most of this design. Every operation must be safe by
construction or stopped with an explanation, because there is no manual repair.

---

## Part 2 — Decisions

### Git engine: isomorphic-git, wrapped

Researched alternatives, all rejected:

| Option | Verdict |
|---|---|
| **wasm-git** (libgit2 → WASM) | Its Emscripten filesystem model does not map to Obsidian's vault adapter, its HTTP transport cannot be routed through `requestUrl`, and **merge is not exposed in its JS API**. ~1 MB WASM. Unproven on Obsidian mobile. |
| **es-git / nodegit** | Native modules. Disqualified on iOS. |
| **GitHub REST / Git Data API**, no local repo | Runs on iOS, but the server does **no** three-way merge and no conflict resolution — its merge endpoint returns a bare 409 with no conflict body. That is last-write-wins, the exact failure being escaped, unless a merge engine is hand-built. |
| **Native git** | Impossible in the mobile sandbox. This is why the popular Obsidian Git plugin is desktop-only for native git and falls back to isomorphic-git on mobile. |

isomorphic-git is the only turnkey engine giving real fetch/merge/conflict/push on iOS Obsidian.
Its pluggable `fs` maps onto Obsidian's `DataAdapter`, and its pluggable `http` routes through
Obsidian's `requestUrl` — which also **removes the CORS-proxy dependency** that browser
isomorphic-git normally needs. That matters for a private vault: no third party sees the content.

**The data loss was never the engine's fault.** It was the previous plugin issuing reckless
commands. The engine faithfully does dangerous things when told to. So the value of this plugin is
the safety layer, not the sync.

Known engine costs, each mapped to a mitigation in the [design spec](superpowers/specs/2026-08-23-github-sync-mobile-design.md) §4:
`pull`/`merge` discards uncommitted changes (issue #1046, still open — the maintainer's own words
are "data loss by default"); `checkout({force:true})` has no "untracked files would be
overwritten" guard; `statusMatrix` cannot represent an unmerged file; no recursive merge strategy,
so it throws when several merge bases exist; mobile memory pressure; interrupt sensitivity.

### Authentication: a pasted fine-grained PAT

SSH is impossible on iOS, so it is HTTPS with a token either way. The predecessor used OAuth
Device Flow, which required the user to register their own GitHub OAuth App and paste a Client ID
— the friction that prompted this rewrite. A fine-grained PAT scoped to one repo needs no app
registration and is the simplest thing that works.

### Sync UX: one button, raw verbs under Advanced

No auto-sync. "Sync now" runs a fixed sequence — commit → fetch → safe merge → push — with each
step reported. Fetch/Pull/Commit/Push are available individually under Advanced.

### Conflicts: safe abort, then whole-file choice

Phase 1 detects a conflict with a dry-run probe, aborts leaving the working tree byte-identical,
and offers per file: keep mine, or keep theirs. Non-destructive because both versions are already
in history — the losing side is postponed, never destroyed. Line-level merging is phase 2.

Whole-file choice was chosen partly *because* it suits binary attachments, where line merging is
meaningless. Part 3 below records how nearly that reasoning was undone.

### Exclude patterns as a first-class safety mechanism

Excluded paths are inert in **both** directions — never cloned, staged, merged, or pushed. Since
hidden files cannot be inspected on iOS, deliberately excluding a path is the user's only manual
protection lever, so it has to be reliable enough to lean on.

Default: `.obsidian/`, `.git/`, `.trash/`.

**Excluding `.obsidian/` is a security requirement, not a convenience.** Obsidian stores plugin
settings — including the PAT — in `.obsidian/plugins/<id>/data.json` in plaintext. Syncing that
directory publishes the token. The settings UI warns explicitly if the user tries to un-exclude it.

### Connect: assume an empty vault, and refuse rather than improvise

Phase 1 assumes the common real case: the cloud repo has content and the phone's vault is empty.
When that assumption breaks, the plugin **stops and explains** instead of guessing.

```
already connected to a different repo → refuse, name the existing repo
remote has content, no local notes    → clone-safe   (the normal path)
remote has content, local has notes   → refuse, explain, suggest desktop
remote empty                          → init + commit + push
```

Clone-safe is `clone({noCheckout: true})` followed by checking out only non-excluded paths, never
forced. The remote's `.obsidian/*` stays in history but never lands on disk.

### Architecture: one chokepoint

`src/git/safe-git.ts` is the only module that imports `isomorphic-git`. Dangerous primitives are
module-private; the exported class exposes no parameter that could turn a safe call into a
clobbering one. If a destructive verb is not exported, UI and sync code cannot reach it. Safety is
structural rather than a convention to remember.

### Testing: real git, mocked network

Tests run **real isomorphic-git** against an in-memory `DataAdapter` stand-in through the
filesystem bridge. Only the network is faked. So an assertion like "the untracked file survived"
exercises genuine git behaviour instead of mocking away the dangerous part.

This is why the test harness (Task 2) received four rounds of work: if the mock's semantics drift
from the real adapter, every later data-loss test silently measures the wrong thing.

---

## Part 3 — What review caught

Recorded because each was non-obvious, and several were things a previous round had claimed to fix.

### The toolchain could not typecheck at all

The committed `tsconfig.json` failed on third-party typings unfixable from this repo —
`obsidian@1.13.1`'s own `.d.ts` does not self-check, and `vite`'s cannot resolve an exports-only
subpath under `moduleResolution: "node"`. `skipLibCheck: true` was required. Without it, every
later task's verification gate and the release CI would have failed for reasons unrelated to our
code.

### Blanket-externalising Node builtins hid an iOS-only crash

The original esbuild config marked every Node builtin external. Under that config a single
plausible mistake — importing `isomorphic-git/http/node` instead of the web client — silently
emitted **eight** builtin `require`s. Those work on desktop Electron and crash on iOS. Removing the
externals list turns that into a build failure. `platform: "browser"` is now explicit, because it
alone decides whether isomorphic-git resolves its Node entry point.

Correction for the record: an intermediate commit message claimed the old config bypassed the
`buffer` polyfill entirely. Re-review disproved that — esbuild's default platform is already
`browser`, so the polyfill was bundled. The load-bearing change was removing the externals list.

### The test filesystem was lying, in two ways that mattered

- **It invented parent directories on write.** The real adapter fails with ENOENT. A bridge that
  forgot a `mkdir` would have passed tests and failed only on a phone.
- **`list()` could never fail.** The real adapter throws for a missing path, and the mock
  returned an empty listing instead, so a bridge bug could not surface. Made strict.

  A later round corrected the *reason* originally given for this. The claim was that
  isomorphic-git turns a throwing `readdir` into `null`, distinguishing "absent" from "empty".
  It does not: it maps only `ENOTDIR` to `null` and swallows everything else, `ENOENT`
  included, as `[]`. See "A failed directory read is not a deletion" below — the property was
  real, the stated mechanism was not, and the gap was genuinely unguarded.

Both are now strict. Where the mock is stricter than reality, the failure mode is a false test
failure — never a false pass.

Also found: plain mutual type-assignability **cannot detect a missing optional property**, which is
exactly how a field went missing from the `requestUrl` stub. `Required<>` on both sides catches it.

### `requestUrl` throws on 400+ by default

The real function throws unless `throw: false`. The stub ignored the flag. GitHub returns
401/403/409 exactly where this plugin's decisions live, so a test could have asserted graceful auth
handling and shipped a plugin that throws before reading the status. Both clients now pass
`throw: false` and inspect the status themselves. Neither keys on `err.status` — the typings promise
no such property.

### The near-miss: `string | null` would have corrupted every attachment

`ConflictFile.ours`/`theirs` were typed `string | null`. That forced the producer to
`new TextDecoder().decode(blob)` — **non-fatal by default**, so every invalid UTF-8 byte becomes
U+FFFD, irreversibly — and the resolution step wrote that string back and committed it.

Worse, resolution also swept in "every non-conflicting remote change" through the same round trip.
So **one conflict on one Markdown file would have corrupted every changed binary attachment**,
files the user was never asked about.

Fixed by making a side an explicit variant: `absent | text | binary | unreadable`. Bytes stay bytes
end to end; text is decoded only with a **fatal** decoder, which is also how binary is detected.

### The same corruption, one layer deeper, on the *clean* merge path

Hardening the conflict path was not enough. isomorphic-git's own `mergeBlobs` does
`Buffer.from(...).toString('utf8')` on both sides and re-encodes the result — the identical lossy
round trip, inside the engine. Reproduced: a 240-byte binary edited on two devices came back **676
bytes containing 218 replacement characters**, and `git.merge` reported a **clean** merge. No
conflict raised, no question asked.

Because three-way merge usually finds separable regions in a large file, that is the *likely* path,
not an edge case.

Fixed with a pre-screen: before invoking the engine, compare blob oids across base/ours/theirs in
one tree walk and ask whether any path changed on both sides is binary. If any is, surface **every**
both-sides change for whole-file choice and never call `git.merge`.

Two subtleties in that fix:
- The breadth is deliberate. Conflicting on the binary alone would leave text files that also
  changed on both sides to be swept in as "theirs", discarding this device's edits to them.
- The check ignores exclude patterns. An excluded path can still be tracked by the remote, and the
  engine merges the whole tree regardless of what is checked out — so filtering there let the
  engine corrupt an excluded binary *inside the commit* and push it. "Don't sync this" must not
  become "corrupt this silently".

A merge driver was considered and **rejected**: `mergeDriver` replaces the default driver outright,
so refusing there would have turned every ordinary text merge into a whole-file choice.

### "Could not read" is not "was deleted" — and this took three attempts

A failed blob read was originally reported as `null`, the same value meaning "that side deleted
this file". Resolution acts on a deletion by unlinking and committing. So a torn packfile after iOS
killed the app mid-write, or an out-of-memory on a large attachment, became a **durable deletion of
a file that exists**.

Getting the discriminator right was harder than expected. isomorphic-git raises `NotFoundError` for
both a missing path and a missing object. An early fix compared `data.what` to the commit oid,
justified by the library doing something similar — but that comparison detects a missing *commit*,
and `resolveFilepath` reassigns the oid to the blob's own oid before the object read, so a torn
packfile reports the blob oid and the check called it "absent". Exactly backwards, in the direction
that deletes data.

The reliable discriminator is the **shape** of `data.what`: a bare 40-hex string means a missing
object, anything else is a human-readable path message. Verified empirically against an absent path,
a missing blob, a missing subtree, a missing commit, a missing root tree, a packed repo, and a
truncated object.

One residual, now guarded: `_readBlob` does not expand its oid argument, so an abbreviated oid or a
ref name such as `"main"` reports itself in `data.what` and would read as a missing path. A
non-40-hex oid now answers `false`, routing to `unreadable`, which refuses rather than deletes.

### A failed directory read is not a deletion — and the documented safeguard did not exist

Two committed code comments, a test comment, this log, and the plan all asserted that
isomorphic-git converts a throwing `readdir` into `null`, which is what separates "absent"
from "an empty directory". Reading the source settled it:

```js
catch (err) { if (err.code === 'ENOTDIR') return null
              return [] }          // ENOENT, EIO, anything else
```

Only `ENOTDIR` becomes `null`. Everything else becomes an **empty directory** — exactly the
collapse the strictness had been introduced to prevent. Demonstrated: with a folder intact but
its read throwing `EIO`, `statusMatrix` reported every file beneath it as deleted while the
files were still on disk. That status feeds commit, which pushes. A durable remote deletion of
files that exist, from a transient failure — the same class as "could not read is never was
deleted", one level up, and completely unguarded.

Notably a failing `stat` aborts loudly; only the `readdir` path fails silently, and silently
in the deleting direction.

Since no error code reaches the walker, the guard has to sit above it. The filesystem bridge
now records reads that failed for a reason other than genuine absence, `SafeGit` clears that
list before scanning and refuses any status it cannot trust, and every staged deletion is
independently confirmed against the working tree first. The in-memory adapter gained a
failure-injection hook, because until then the property could not be expressed as a test at
all.

The lesson worth keeping: **a safety claim about a dependency is worthless until someone reads
the dependency.** This one was repeated across five places and was wrong in all five.

### A user-editable regex is an attack surface on your own phone

The exclude patterns compile to regexes, and `**` became `.*`. Each `**/` group became an
independent `(?:.*/)?`, so several in a row backtracked exponentially in the *depth of the path
being tested* — not in pattern length. Measured before the fix: twelve `**/` groups took 4.1
seconds for one path at depth 30, and filtering 2000 paths took **18 seconds**. There is no
timeout anywhere in the sync path, so that is a frozen phone with nothing to explain itself.
The shipped defaults were never affected (20,000 paths in 6 ms); only hand-written patterns.

Fixed by collapsing runs of `**/` into one, which is semantically free — consecutive "any number
of directories" groups say nothing more than one of them does.

Worth noting the shape that is dangerous is not the obvious one. `**a**a**a**a**` completes in
0.03 ms because it matches immediately. The expensive case is many `**/` groups against a deep
path that does *not* match.

### A dropped slash was a token leak

`.obsidian/` excluded the directory and its contents; bare `.obsidian` excluded only the
directory entry, and silently synced everything inside it. Since `.obsidian/plugins/<id>/data.json`
holds the GitHub token in plaintext, a user tidying their exclude list and removing one character
would have published their credentials. Every pattern now also matches everything beneath what it
matched, which is what .gitignore does for a pattern naming a directory.

The same rework made `**/` match zero directories as well as many, so `**/*.png` now covers a
root-level `a.png` — what a user writing that pattern means.

### The sentinel that must not be printable

Translating `**` before `*` needs a placeholder. It has to be a character that cannot occur in a
vault path: a printable stand-in such as a space would itself be rewritten into `.*`, so the
pattern `My Notes` would compile to `^My.*Notes$` and match `My/Notes/a.md`. In an exclude engine
over-matching is not a cosmetic bug — the file is simply never pushed, which is a silent backup
loss.

The placeholders are NUL and SOH, written as `\u0000`/`\u0001` escapes rather than literal
bytes. A literal control byte makes the file read as binary to `grep` and `file`, and gets
stripped by copy-paste — which is exactly how it went wrong twice: once in the plan text, and
once again when that text was pasted into a task briefing.

### A test that cannot fail is not a test

Two binary tests used **add/add** shapes, where the file is absent at the merge base. The engine
raises a conflict on that shape by itself, so both tests passed with the pre-screen deleted — they
pinned nothing. The shape that actually corrupts silently (present at base, edited in two separable
regions) had no test at all.

Same defect in the unreadable-refusal test: with a single conflicting file, "decide all writes up
front" and "screen as you go" are indistinguishable. It now uses two files with the second damaged,
asserting the first was never touched.

### Performance can be a safety problem

The binary pre-screen initially reused a helper that called `readBlob` three times per candidate
path — which inflates the whole blob just to read its oid. Measured: **16.6 seconds for 2000
notes**, and over 1 GB resident for 80 MB of attachments, on every diverged merge. Replaced with a
single `git.walk` comparing tree-entry oids: **33 ms** for the same repo, no inflation. On a phone
the original cost would have made merging unusable and risked being killed for memory.

### Specs drift, and a drifted spec is worse than none

Twice the design spec described a mechanism the code did not have. Once it claimed immunity to a
class of engine bug that was in fact still live; once it described a merge driver that had been
considered and rejected. Both were corrected. A spec asserting a safety property that does not exist
is actively harmful — it stops the next reader from looking.

---

## Part 4 — Process notes

- **Reviewers must verify by running things, not reading.** Every serious finding above came from a
  reviewer who built a probe and executed real git. The corruption on the clean-merge path was found
  that way and would not have been found by inspection.
- **Ask reviewers to weigh findings by whether data could actually be lost**, and to say plainly when
  what remains is polish. Otherwise review rounds do not converge.
- **Fix the plan, not just the code.** Several rounds found defects in code that did not exist yet.
  Fixing the plan is cheap; discovering the same defect after the task ships is not.
- **Disclose controller-made commits when dispatching a reviewer.** One reviewer flagged an
  undisclosed plan commit as possible scope creep — a fair process criticism.
- Reviewers run on **Opus**; implementers on Sonnet is adequate because the plan hands them exact
  code. Reviewing is where the judgment is.
