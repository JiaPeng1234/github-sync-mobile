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

Exclude patterns compile to regexes, and asterisk runs become `.*`. Adjacent `.*` groups
backtrack exponentially in the length of the path being tested. There is no timeout anywhere in
the sync path, so this is not a stutter — it is a wedged app on the one platform where the user
can inspect nothing.

Measured, one `isExcluded` call:

| pattern | against | before |
|---|---|---|
| `**/` × 12 | depth-30 path | 10.3 s |
| `*` × 13 + `.png` | ordinary 84-char vault path | 27.1 s |
| `*` × 18 + `z.md` | same | did not return in four minutes |

**The first round of this fix only collapsed `**/` runs, and that was the wrong half.** `**/`×12
is not something a person types. A held-down asterisk key, or a pasted `****************`
separator line, is — and `*` is the wildcard users reach for, because the predecessor plugin
supported only `*`. Review caught that the likelier and far cheaper trigger was still fully open
after the first fix, with post-fix timings identical to pre-fix.

Both are now collapsed: three or more asterisks in a row become `**`, and runs of `**/` become
one `**/`. Both rewrites are semantically free — `.*` already subsumes the `[^/]*` an odd
trailing star would add, and consecutive "any number of directories" groups say nothing more than
one of them. The shipped defaults were never affected (3000 deep paths in ~2 ms).

Two things worth carrying forward. **The dangerous shape is not the obvious one:**
`**a**a**a**a**` returns in 0.03 ms — but only because it *matches*; non-matching input is where
it blows up. And **collapsing cannot close the class**, only its reachable instances: shapes like
`**/*/` repeated are still exponential, merely harmless at realistic vault depths. A length or
complexity bound at the settings layer would be the real fix if this ever bites again.

### One stray character can silence the whole sync

The universal directory-suffix fix below closed a token leak, but it broadened every pattern, and
review found the mirror-image hazard: bare `*` now matches every path in the vault. Nothing is
staged, nothing is pushed, and the sync still **reports success** over an empty change set. That
is silent backup loss, arrived at by deleting one character from `.obsidian/*`.

The semantics are correct — .gitignore behaves the same way, and it is the same rule that makes a
bare `.obsidian` protect the token file — so the guard belongs at the point of entry rather than
in the matcher. `matchesEverything()` decides it empirically, by probing representative paths
rather than inspecting the pattern, so no creative arrangement of asterisks slips past. The
settings tab refuses to stay quiet about a pattern that trips it.

It also interacts with safety invariant 5: "local is empty" means "no non-excluded file exists",
so an exclude-everything pattern makes *any* vault look empty and steers the connect decision down
the clone-safe path. Nothing at that layer can tell "empty vault" from "everything excluded",
which is why the settings-layer warning is load-bearing rather than cosmetic.

### A dropped slash was a token leak

`.obsidian/` excluded the directory and its contents; bare `.obsidian` excluded only the
directory entry, and silently synced everything inside it. Since `.obsidian/plugins/<id>/data.json`
holds the GitHub token in plaintext, a user tidying their exclude list and removing one character
would have published their credentials. Every pattern now also matches everything beneath what it
matched, which is what .gitignore does for a pattern naming a directory.

The same rework made `**/` match zero directories as well as many, so `**/*.png` now covers a
root-level `a.png` — what a user writing that pattern means.

### An untested trap is the defect

The exclude module's comments are essentially a list of traps: the non-printable placeholder, the
escape class, the collapse order, the universal subtree suffix. Mutation testing found that
**fourteen edits to the compiler left the whole suite green** — including the two the comments
spend the most words on. Replacing the placeholder with a space passed. Removing `.` from the
escape class passed, which would make `*.png` exclude `abcpng`. Removing duplicate-slash
collapsing passed, which reopens the token leak, because `.obsidian//` then compiles to something
that does not match `.obsidian/app.json` at all — and a doubled slash is easy to paste.

The lesson is not "add more tests". It is that **a comment explaining why something is load-bearing
is a promise the test suite has to keep.** Nine mutations are now pinned explicitly, each verified
to fail without its guard.

That protection then paid for a simplification. The multi-step pipeline needed placeholder
sentinels purely to stop the `*` rule eating the asterisks inside `**`, and a single ordered
`String.replace` with an alternation needs none:

```js
p.replace(/\*\*\/|\*\*|\*|[.+^${}()|[\]\\?]/g, translate)
```

Longest wildcard first, everything else escaped, one pass. That deletes both sentinels, the comment
explaining why they must not be printable, and the possibility of escaping before translating. The
refactor was verified behaviour-identical over five million pattern/path comparisons — but it was
only safe to make *because* the traps had tests by then.

### `matchesEverything` can only see universality

Guarding against "this pattern excludes everything" turned out to have two levels, and the cheap
one is not the one that bites.

A vault-independent probe catches `*`, `**`, `***`, `*/` — genuinely universal patterns. It cannot
catch a pattern that excludes *this user's* entire vault while sparing something hypothetical:
`**` followed by `/*.md` excludes every file in a Markdown-only vault, which is the common Obsidian
case, and is not flagged because it spares a `.png`. Same harm, invisible.

Review also found the first probe set produced false positives: all five paths happened to contain
`a` and `.`, so `**a*` tripped it while sparing real files — and the warning text would have been
factually wrong. The probes now deliberately share no character.

So there are two checks, at two layers. `matchesEverything` stays as the abstract tripwire, and the
settings tab reports the vault-relative count — "N of M files in this vault are excluded" — which is
the only place the real answer exists. That readout also happens to surface a typo'd pattern that
matches nothing, and a case-mismatched one such as `.Obsidian/`.

### A guard placed one line too early only worked on desktop

`rel()` has to map git's repo root to the vault root, and it did — by testing `p === "."`. But
isomorphic-git's tree walker builds its paths by string concatenation, `` `${dir}/${entry}` ``, not
with its own `join()`. With the mobile base of `""` the root therefore arrives as **`"/."`**, which
fell straight through the `"."` test, had its slash stripped afterwards, and came back out as a
literal `"."` path. `adapter.stat(".")` returned null, and `statusMatrix` threw — so status,
clone-safe checkout, and merge were all unreachable.

Two things make this worth recording. First, the check existed *because* review had already
identified this exact hazard; it was simply ordered wrong, before the separator strip rather than
after. Second, and worse: **it broke only for `base === ""`, which is the mobile target.** With a
desktop base of `/vault` the path is `/vault/.`, the base-prefix branch strips it, and everything
works. A desktop-only test suite would have shipped this.

It also passed the plan's own tests, because those called `fs.stat(".")` — a shape the library never
actually sends. A test that exercises a convenient path shape rather than the real one proves
nothing about the real one.

### Throwing the right error code is necessary but not sufficient

The read-failure channel exists because isomorphic-git swallows most `readdir` errors as an empty
directory. Implementing it surfaced two refinements, both found by running real git rather than
reasoning about it:

- **Not every failure gets swallowed.** The tree walker calls `lstat` before `readdir`, so a failing
  stat propagates out of `statusMatrix` with nothing recorded at all. That is the safe direction —
  loud beats silent — but it means the channel alone is not the guard. `SafeGit` has to treat a
  thrown scan as a refusal too, and now does.
- **The channel had a silent hole of its own.** The bridge's `readdir` calls `stat` internally, and
  only the listing call was wrapped. A transient failure in that stat would be swallowed to `[]` with
  nothing recorded — exactly the outcome the channel was built to prevent. Both calls are wrapped now.

### An unreadable index made `commit` ship an empty tree

The read-failure channel was built for `readdir`, because isomorphic-git reports a failed
directory listing as an empty directory. Review found the same hole one function over, with a
larger blast radius: `FileSystem.read` has a bare `catch { return null }`.

Measured, with only the content read failing and `stat` still succeeding:

- **`.git/index` unreadable** → `statusMatrix` reports every file as `110`, and **`git.commit`
  succeeds, producing a commit whose tree is empty** — every file deleted — while the working tree
  is completely intact. Nothing recorded.
- **`.git/refs/heads/main` unreadable** → the repo looks unborn, history silently gone.

Pushing either result deletes the user's vault from the remote, from a transient read failure, with
a sync that reports success.

Every read path — `readFile`, `stat`, and both calls inside `readdir` — now goes through one
recorder. Recording is free of false positives here, which is what makes it safe to be
indiscriminate: the adapter signals genuine absence by returning `null` from `stat`, never by
throwing, so any throw is unambiguously a failure.

The general lesson, now three times over: **when a dependency swallows errors, the error code is
not a signal — it is a decoration.** Ask what the library does with the failure, not what you threw.

### A test that cannot distinguish two guards pins neither

Deleting the guard around the directory listing left the entire suite green. The test named
"records a failed directory listing" used the mock's `failReadsAt`, which fails `stat` too — and
`stat` runs first, so the test only ever exercised the stat guard. Two guards, one covered.

Same shape as the `fs.stat(".")` problem: a test that reaches the code by a convenient route proves
nothing about the route that actually occurs. The listing guard is now pinned by stubbing
`adapter.list` alone.

Also unpinned until now, and both verified by mutation: the exact-size `ArrayBuffer` copy (removing
it leaves the suite green, but Node pools small Buffers, so a real run writes an 8192-byte loose
object and git dies reading it back), and the root-mapping order itself.

### Backslashes are filenames, not separators

`rel()` rewrote every backslash to a forward slash. Only a Windows `basePath` needs that, and the
base is normalised separately — but backslashes are legal characters in an iOS or macOS filename.

A vault containing `a\b.md` was therefore unsyncable: `statusMatrix` threw `ENOENT` naming
`a/b.md`, a path the user does not have. Worse, if a real `a/b.md` also existed the failure went
silent — the listing reported `a/b.md` twice, `a\b.md` was never staged or committed, and nothing
was recorded. A note the user believed was backed up never was.

### Non-force checkout is not a repair

Measured: a non-force `checkout` to a ref that is already checked out is a no-op. It does not restore
a file deleted from the working tree, and it does not revert a locally modified one. That is the safe
direction, and it is precisely what "never forces" buys — but it means nothing downstream may treat
checkout as a way to fix a dirty tree.

### Two deliberate gaps against .gitignore

`?` is a literal, not a single-character wildcard, and bracket classes are literal too — so
`note?.md` does not match `note1.md`, and `f[0-9].md` does not match `f1.md`. Both divergences are
in the *under*-match direction, meaning files stay pushed, which is the safe way to be wrong. Worth
knowing before someone "fixes" them, since adding character classes would also add new
backtracking shapes.

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

### The read-failure guard has to cover both scan paths, not one

`scanWorkingTree` (behind `status`/`commitLocal`) clears and checks the bridge's `readFailures`
channel and refuses a scan it cannot trust. But `hasLocalContent` walked its *own* recursion with
swallowing catches and never consulted the channel. A transient read failure over a vault that holds
real notes therefore made it return `false` — "empty" — and `decideConnect` (Task 11) keys the
clone-safe-vs-refuse decision on exactly that boolean. The result: a momentary iOS read stall could
flip a *refuse* into *clone the remote over your vault*. `checkout({force:false})` blocks the worst
overlapping-file clobber, but relying on that alone is the "your error handling is a decoration"
anti-pattern this project keeps re-learning. Fix: `hasLocalContent` now clears and checks
`readFailures` and throws the same refusal, and Task 11 must let the throw propagate. The lesson is
that a safety guard on one code path does not protect a second path that reaches the same decision by
different code.

### A guard's test must take the route the guard defends

Both the `readFailures` refusal and the `stillOnDisk` deletion check passed a green suite yet
*survived mutation* — deleting either left every test passing. The single test aimed at them injected
a read failure on a **subdirectory**, where isomorphic-git's tree walker `lstat`s the folder first,
throws, and trips a *different* guard (the `statusMatrix` try/catch). The guards' actual job is the
**root** read failure, where `statusMatrix` *returns* a phantom-deletion row instead of throwing —
the route the tests never took. And `stillOnDisk` cannot be pinned by any `failReadsAt` injection at
all, because the bridge records every such failure and `scanWorkingTree`'s guard fires first; it can
only be reached by a `list`-omits-file / `stat`-still-finds-file shape that records nothing. A test
that reaches a guard by a convenient route proves nothing about the route that loses data.

### A correct guard with no test is a regression waiting to ship

Task 9's merge code was found correct — the binary pre-screen was reproduced end-to-end against real
isomorphic-git (a 200-byte binary changed in two separable regions merged "clean" into a 440-byte
blob with every invalid byte rewritten to U+FFFD, reported as success) and it correctly prevents
that. But two of its load-bearing guards had *no test that would notice their removal*. Mutating
`checkoutTracked`'s `force: false` to `force: true` — the exact call class that destroyed the
author's notes — left all fourteen tests green while silently clobbering local content and returning
`fast-forward`. Making `anyBinary` skip excluded paths likewise passed, while corrupting an excluded
attachment and pushing it. The code was right; the suite could not tell if it stopped being right.
The lesson: for a guard whose failure is silent data loss, the test that proves a mutation *fails* is
as load-bearing as the guard itself. Both are now pinned by a checkout-collision test and an
excluded-binary test.

### Stop safely and explain, uniformly — including the cases the plan forgot

`mergeSafe` already turned unrelated histories and multiple merge bases into a structured
`unmergeable` outcome, but a file-vs-directory type change fell through as a raw
`MergeNotSupportedError` thrown uncaught. It was loud and wrote nothing (the throw is at the dry-run
stage), so no data was at risk — but it was an inconsistency: one class of "the engine can't do this"
crashed while its siblings explained themselves. It is now `{ kind: "unmergeable", reason:
"type-change" }`. When a module's contract is "stop safely and explain," an edge the plan never
enumerated should still land inside that contract, not beside it.

### The deletion discriminator was verified against reality, not its own tests

Resolution deletes a file (unlink + commit) when the chosen side is `absent`, and a side is `absent`
only when `isPathAbsent(err, oid)` says so. If a merely-unreadable object — a torn packfile, an
out-of-memory — were misclassified as absent, resolution would delete a file that still exists and
commit the deletion. The function decides on the *shape* of isomorphic-git's `NotFoundError.data.what`:
a bare 40-hex oid means a missing object (unreadable — refuse), anything path-shaped means a missing
path (absent — safe to delete). Crucially it does **not** compare `data.what` against the commit oid,
because `resolveFilepath` reassigns to the blob's own oid before the object read, so a torn packfile
reports the blob oid — a comparison scheme would misfire exactly when it matters. Review reproduced
all four error shapes against real iso-git 1.41.8, including the torn-packfile case, and confirmed the
discriminator refuses rather than deletes. The general lesson: for the one line that can turn a read
failure into a durable deletion, a passing unit test is not enough — the unit tests were written to
match the function, so they cannot catch the function being wrong. The error shape had to be
reproduced against the real library. (During this task the review instruction itself stated the
expected direction inverted; the implementer matched the function's documented semantics instead, and
the real-git reproduction settled which was right.)

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
