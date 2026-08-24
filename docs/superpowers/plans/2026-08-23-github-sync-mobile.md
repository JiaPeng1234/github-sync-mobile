# github-sync-mobile Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a mobile-first Obsidian plugin that syncs a vault to a private GitHub repo with manual, git-CLI-like operations that can never silently lose data.

**Architecture:** A single `SafeGit` module is the only importer of `isomorphic-git`; it exports only safe operations and keeps every destructive primitive as a module-private function. `sync-service` orchestrates the fixed sequence (commit → fetch → safe-merge → push) using only those safe exports. Three thin, pure bridges (`exclude`, `fs-adapter`, `http-client`) are unit-testable in isolation, which is how the data-loss paths get proven safe without a real vault.

**Tech Stack:** TypeScript, esbuild (CJS bundle to `main.js`), isomorphic-git, Obsidian API (`requestUrl` + `DataAdapter`), Vitest for tests, `buffer` polyfill for mobile.

**Spec:** `docs/superpowers/specs/2026-08-23-github-sync-mobile-design.md`

---

## Compiler setting that affects every UI task

`tsconfig.json` sets **`noImplicitOverride: true`**. Any method that overrides a concrete
member of an Obsidian base class must therefore carry the `override` keyword, or the build
fails with TS4114. This applies to `Plugin.onload`/`onunload`, `Modal.onOpen`/`onClose`,
`PluginSettingTab.display`, and the `ItemView` lifecycle methods.

The code blocks in Tasks 14–18 include `override` where it is required. If `npx tsc --noEmit`
reports TS4114 on a member that does not have it, add the keyword — and if it reports TS4113
("this member cannot have an override modifier because it is not declared in the base class"),
remove it. Let the compiler settle the exact set rather than guessing.

## Testing philosophy for this project

Read this before starting — it determines whether the tests are worth anything.

**Do NOT mock isomorphic-git.** The whole point is proving that our *use* of git is safe. Tests
run **real isomorphic-git** against an **in-memory Obsidian `DataAdapter` mock** driven through our
own `fs-adapter`. That means tests exercise genuine git object storage, genuine merges, and
genuine checkout behaviour — so a test that says "untracked files survive" actually means it.

**Only the network is mocked.** `http-client` is replaced by a fake in tests. Fetch/push tests
assert on the requests we issue. Merge/conflict/status/commit/checkout tests need no network at
all: we create a local `refs/remotes/origin/main` ref by hand to simulate a fetched remote.

---

## File structure

| File | Responsibility |
|---|---|
| `package.json`, `tsconfig.json`, `esbuild.config.mjs`, `buffer-shim.mjs` | build toolchain |
| `manifest.json`, `versions.json` | Obsidian plugin metadata |
| `vitest.config.ts`, `tests/mocks/obsidian.ts` | test harness + `obsidian` module stub |
| `tests/mocks/memory-adapter.ts` | in-memory `DataAdapter` used as the test filesystem |
| `src/types.ts` | `PluginSettings`, `SyncReport`, `SyncStep`, `ConflictFile`, `MergeOutcome` |
| `src/constants.ts` | default branch, default excludes, commit author, message template |
| `src/git/exclude.ts` | pattern compiler + matcher; used at every git touchpoint |
| `src/git/fs-adapter.ts` | Obsidian `DataAdapter` → isomorphic-git `fs.promises` |
| `src/git/http-client.ts` | isomorphic-git http client over Obsidian `requestUrl` |
| `src/git/safe-git.ts` | **the chokepoint**: only safe ops exported, `force` unreachable |
| `src/sync/sync-service.ts` | the 4-step Sync sequence, emits `SyncReport` |
| `src/github/api.ts` | verify token, repo exists/empty |
| `src/ui/settings-tab.ts` | PAT, repo, exclude toggles + advanced globs, verbose log |
| `src/ui/log-modal.ts` | on-screen step trace with copy button |
| `src/ui/conflict-modal.ts` | per-file "Keep mine / Keep theirs" |
| `src/ui/sync-view.ts` | "Sync now" button, status line, Advanced verbs |
| `src/main.ts` | plugin lifecycle, wires everything, owns the single `SafeGit` |
| `.github/workflows/release.yml` | tag-triggered release |

---

## Task 1: Project scaffolding

**Files:**
- Create: `package.json`, `tsconfig.json`, `esbuild.config.mjs`, `buffer-shim.mjs`, `manifest.json`, `versions.json`
- Modify: `.gitignore`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "github-sync-mobile",
  "version": "0.1.0",
  "description": "Manual, safe GitHub sync for Obsidian on mobile",
  "main": "main.js",
  "license": "GPL-3.0",
  "private": true,
  "scripts": {
    "dev": "node esbuild.config.mjs",
    "build": "tsc --noEmit && node esbuild.config.mjs production",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "buffer": "^6.0.3",
    "isomorphic-git": "^1.41.0"
  },
  "devDependencies": {
    "@types/node": "^20.0.0",
    "esbuild": "^0.20.0",
    "obsidian": "latest",
    "typescript": "^5.3.0",
    "vitest": "^1.6.0"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "baseUrl": ".",
    "noEmit": true,
    "module": "ESNext",
    "target": "ES2018",
    "allowSyntheticDefaultImports": true,
    "esModuleInterop": true,
    "moduleResolution": "node",
    "isolatedModules": true,
    "strict": true,
    "noImplicitOverride": true,
    "skipLibCheck": true,
    "lib": ["ES2018", "DOM"],
    "types": ["node", "vitest/globals"]
  },
  "include": ["src/**/*.ts", "tests/**/*.ts"]
}
```

- [ ] **Step 3: Create `buffer-shim.mjs`**

isomorphic-git's dependencies (`readable-stream`, `sha.js`, `pako`, `crc-32`) need a global
`Buffer`. Mobile has no Node runtime, so we bundle the polyfill and inject it everywhere.

```js
// Mobile (iOS/Android) has no Node `buffer` builtin and no `Buffer` global.
// isomorphic-git's deps require both. esbuild injects this into every module.
//
// CONSTRAINT for the filesystem adapter: esbuild's `inject` rewrites the bare
// identifier `Buffer` at every bundled call site on every platform, so on desktop
// this polyfill coexists with (and shadows) Node's native Buffer. The polyfill's
// `Buffer.isBuffer(b)` tests `b._isBuffer === true`, which is false for a native
// Node Buffer -- and isomorphic-git's GitIndex calls `Buffer.isBuffer(...)`. So the
// fs adapter MUST always return `Uint8Array` and never a native Node Buffer.
// This is a hard correctness requirement, not a stylistic preference.
import { Buffer } from "buffer";

if (typeof globalThis.Buffer === "undefined") {
  globalThis.Buffer = Buffer;
}

export { Buffer };
```

- [ ] **Step 4: Create `esbuild.config.mjs`**

```js
import esbuild from "esbuild";
import process from "process";

const prod = process.argv[2] === "production";

const options = {
  banner: { js: "/* github-sync-mobile */" },
  entryPoints: ["src/main.ts"],
  bundle: true,
  // Only the modules Obsidian itself provides at runtime are external.
  // Node builtins are deliberately NOT listed: mobile has no Node runtime, so a
  // `require("crypto")` in the bundle would work on desktop Electron and crash on
  // iOS. Leaving builtins un-external makes such an import fail the build here
  // instead of failing on someone's phone.
  external: [
    "obsidian",
    "electron",
    "@codemirror/autocomplete",
    "@codemirror/collab",
    "@codemirror/commands",
    "@codemirror/language",
    "@codemirror/lint",
    "@codemirror/search",
    "@codemirror/state",
    "@codemirror/view",
    "@lezer/common",
    "@lezer/highlight",
    "@lezer/lr",
  ],
  // Load-bearing for iOS: `browser` makes isomorphic-git's `exports` map resolve
  // its browser entry (index.js) rather than the `node` condition (index.cjs,
  // which requires `crypto` and `path`). Switching this to "node" breaks mobile.
  platform: "browser",
  inject: ["buffer-shim.mjs"],
  format: "cjs",
  target: "es2018",
  logLevel: "info",
  sourcemap: prod ? false : "inline",
  treeShaking: true,
  outfile: "main.js",
  minify: prod,
};

if (prod) {
  await esbuild.build(options);
} else {
  const ctx = await esbuild.context(options);
  await ctx.watch();
}
```

- [ ] **Step 5: Create `manifest.json`**

`id` must match the folder name under `.obsidian/plugins/`. `isDesktopOnly: false` is what
makes it installable on iOS.

```json
{
  "id": "github-sync-mobile",
  "name": "GitHub Sync Mobile",
  "version": "0.1.0",
  "minAppVersion": "1.4.0",
  "description": "Manually sync your vault to your own private GitHub repo, designed for mobile. Never overwrites your notes without asking.",
  "author": "Peng Jia",
  "authorUrl": "https://github.com/JiaPeng1234",
  "isDesktopOnly": false
}
```

- [ ] **Step 6: Create `versions.json`**

```json
{
  "0.1.0": "1.4.0"
}
```

- [ ] **Step 7: Append build outputs to `.gitignore`**

```
.superpowers/
node_modules/
main.js
*.log
.DS_Store
```

- [ ] **Step 8: Install dependencies**

Run: `npm install`
Expected: completes, creates `node_modules/` and `package-lock.json`.

- [ ] **Step 9: Commit**

```bash
git add package.json package-lock.json tsconfig.json esbuild.config.mjs buffer-shim.mjs manifest.json versions.json .gitignore
git commit -m "chore: project scaffolding for github-sync-mobile"
```

---

## Task 2: Test harness

The `obsidian` module does not exist at test time (it is provided by the app at runtime and
marked external in the bundle), so tests alias it to a stub. The in-memory adapter is the
filesystem every later test runs against.

**Files:**
- Create: `vitest.config.ts`, `tests/mocks/obsidian.ts`, `tests/mocks/memory-adapter.ts`
- Test: `tests/mocks/memory-adapter.test.ts`

- [ ] **Step 1: Create `vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
  resolve: {
    alias: {
      obsidian: path.resolve(__dirname, "tests/mocks/obsidian.ts"),
    },
  },
});
```

- [ ] **Step 2: Create `tests/mocks/obsidian.ts`**

Only the surface our modules import. `requestUrl` is replaced per-test.

```ts
export interface RequestUrlParam {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: ArrayBuffer | string;
  throw?: boolean;
}

export interface RequestUrlResponse {
  status: number;
  headers: Record<string, string>;
  arrayBuffer: ArrayBuffer;
  text: string;
}

/** Tests overwrite this via setRequestUrlHandler(). */
let handler: (p: RequestUrlParam) => Promise<RequestUrlResponse> = async () => {
  throw new Error("requestUrl called but no handler installed in test");
};

export function setRequestUrlHandler(
  h: (p: RequestUrlParam) => Promise<RequestUrlResponse>,
): void {
  handler = h;
}

export function requestUrl(p: RequestUrlParam): Promise<RequestUrlResponse> {
  return handler(p);
}

// Stubs so `import { Plugin } from "obsidian"` type-checks in tests.
export class Plugin {}
export class PluginSettingTab {}
export class Modal {}
export class Setting {}
export class ItemView {}
export class Notice {
  constructor(public message: string) {}
}
```

- [ ] **Step 3: Write the failing test for the in-memory adapter**

Create `tests/mocks/memory-adapter.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { MemoryAdapter } from "./memory-adapter";

describe("MemoryAdapter", () => {
  it("writes and reads text", async () => {
    const a = new MemoryAdapter();
    await a.write("notes/a.md", "hello");
    expect(await a.read("notes/a.md")).toBe("hello");
  });

  it("lists files and folders at a path", async () => {
    const a = new MemoryAdapter();
    await a.write("notes/a.md", "x");
    await a.write("notes/sub/b.md", "y");
    const listing = await a.list("notes");
    expect(listing.files).toEqual(["notes/a.md"]);
    expect(listing.folders).toEqual(["notes/sub"]);
  });

  it("lists the vault root with an empty path", async () => {
    const a = new MemoryAdapter();
    await a.write("a.md", "x");
    const listing = await a.list("");
    expect(listing.files).toEqual(["a.md"]);
  });

  it("returns null from stat for a missing path", async () => {
    const a = new MemoryAdapter();
    expect(await a.stat("nope.md")).toBeNull();
  });

  it("round-trips binary data", async () => {
    const a = new MemoryAdapter();
    const bytes = new Uint8Array([1, 2, 3, 250]);
    await a.writeBinary("img.png", bytes.buffer);
    const out = new Uint8Array(await a.readBinary("img.png"));
    expect(Array.from(out)).toEqual([1, 2, 3, 250]);
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `npx vitest run tests/mocks/memory-adapter.test.ts`
Expected: FAIL — cannot resolve `./memory-adapter`.

- [ ] **Step 5: Create `tests/mocks/memory-adapter.ts`**

Mirrors the subset of Obsidian's `DataAdapter` that `fs-adapter` uses. Paths are vault-relative
with forward slashes and no leading slash — exactly what Obsidian hands plugins.

```ts
export interface StatResult {
  type: "file" | "folder";
  ctime: number;
  mtime: number;
  size: number;
}

/** In-memory stand-in for Obsidian's DataAdapter. */
export class MemoryAdapter {
  private files = new Map<string, Uint8Array>();
  private folders = new Set<string>();
  private clock = 1000;

  private touch(): number {
    return (this.clock += 1000);
  }

  private ensureParents(path: string): void {
    const parts = path.split("/");
    parts.pop();
    let acc = "";
    for (const p of parts) {
      acc = acc ? `${acc}/${p}` : p;
      if (acc) this.folders.add(acc);
    }
  }

  async write(path: string, data: string): Promise<void> {
    this.ensureParents(path);
    this.files.set(path, new TextEncoder().encode(data));
  }

  async writeBinary(path: string, data: ArrayBuffer): Promise<void> {
    this.ensureParents(path);
    this.files.set(path, new Uint8Array(data.slice(0)));
  }

  async read(path: string): Promise<string> {
    const b = this.files.get(path);
    if (!b) throw new Error(`ENOENT: ${path}`);
    return new TextDecoder().decode(b);
  }

  async readBinary(path: string): Promise<ArrayBuffer> {
    const b = this.files.get(path);
    if (!b) throw new Error(`ENOENT: ${path}`);
    return b.slice().buffer;
  }

  async exists(path: string): Promise<boolean> {
    return this.files.has(path) || this.folders.has(path) || path === "";
  }

  async stat(path: string): Promise<StatResult | null> {
    if (this.files.has(path)) {
      const size = this.files.get(path)!.byteLength;
      return { type: "file", ctime: 1000, mtime: this.touch(), size };
    }
    if (this.folders.has(path) || path === "") {
      return { type: "folder", ctime: 1000, mtime: 1000, size: 0 };
    }
    return null;
  }

  async list(path: string): Promise<{ files: string[]; folders: string[] }> {
    const prefix = path === "" ? "" : `${path}/`;
    const files: string[] = [];
    const folders = new Set<string>();
    for (const f of this.files.keys()) {
      if (!f.startsWith(prefix)) continue;
      const rest = f.slice(prefix.length);
      if (!rest) continue;
      const slash = rest.indexOf("/");
      if (slash === -1) files.push(f);
      else folders.add(prefix + rest.slice(0, slash));
    }
    for (const d of this.folders) {
      if (!d.startsWith(prefix)) continue;
      const rest = d.slice(prefix.length);
      if (!rest) continue;
      if (!rest.includes("/")) folders.add(d);
    }
    return { files: files.sort(), folders: [...folders].sort() };
  }

  async mkdir(path: string): Promise<void> {
    this.ensureParents(`${path}/x`);
    this.folders.add(path);
  }

  async rmdir(path: string, recursive: boolean): Promise<void> {
    this.folders.delete(path);
    if (recursive) {
      const p = `${path}/`;
      for (const f of [...this.files.keys()]) if (f.startsWith(p)) this.files.delete(f);
      for (const d of [...this.folders]) if (d.startsWith(p)) this.folders.delete(d);
    }
  }

  async remove(path: string): Promise<void> {
    if (!this.files.delete(path)) throw new Error(`ENOENT: ${path}`);
  }

  /** Test helper: snapshot of every file path currently present. */
  paths(): string[] {
    return [...this.files.keys()].sort();
  }
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run tests/mocks/memory-adapter.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 7: Commit**

```bash
git add vitest.config.ts tests/
git commit -m "test: vitest harness with obsidian stub and in-memory DataAdapter"
```

---

## Task 3: Types and constants

**Files:**
- Create: `src/types.ts`, `src/constants.ts`

- [ ] **Step 1: Create `src/types.ts`**

```ts
export interface PluginSettings {
  /** Fine-grained GitHub PAT with contents read/write on the target repo. */
  token: string;
  /** GitHub account or org that owns the repo. */
  owner: string;
  /** Repository name, supplied explicitly so the right repo is connected. */
  repo: string;
  branch: string;
  /** Paths never read from, written to, staged, or pushed. */
  excludePatterns: string[];
  /** Show the step-by-step trace on screen. Off in stable releases. */
  verboseLog: boolean;
  commitMessageTemplate: string;
}

/**
 * One side's version of a conflicting file.
 *
 * Deliberately not `string | null`. Vaults contain images and PDFs, and decoding
 * a blob to a string to carry it through resolution is lossy: a non-fatal
 * TextDecoder turns every invalid UTF-8 byte into U+FFFD, so writing the result
 * back would silently corrupt the attachment and commit the damage. Both ends of
 * this pipeline already speak bytes, so bytes are what we carry.
 *
 * `unreadable` is separate from `absent` on purpose. A failed blob read must never
 * be mistaken for "the user deleted this file", because resolution acts on
 * `absent` by deleting and committing.
 */
export type ConflictSide =
  | { state: "absent" }
  | { state: "text"; content: string }
  | { state: "binary"; bytes: Uint8Array }
  | { state: "unreadable"; error: string };

/** A file that differs on both sides and needs a user decision. */
export interface ConflictFile {
  path: string;
  /** The working-tree/local version. */
  ours: ConflictSide;
  /** The fetched remote version. */
  theirs: ConflictSide;
}

/**
 * `unmergeable` is distinct from `conflict` because the two demand different
 * responses: a conflict is resolvable per file in the app, an unmergeable history
 * cannot be resolved here at all.
 */
export type MergeOutcome =
  | { kind: "up-to-date" }
  | { kind: "fast-forward"; oid: string }
  | { kind: "merged"; oid: string }
  | { kind: "conflict"; files: ConflictFile[] }
  | { kind: "unmergeable"; reason: UnmergeableReason };

/**
 * Histories isomorphic-git cannot merge: no recursive merge strategy, so it throws
 * when several merge bases exist (two devices diverging), and it cannot join two
 * unrelated roots.
 */
export type UnmergeableReason = "unrelated-histories" | "multiple-merge-bases";

export interface RepoStatus {
  /** Non-excluded files differing from HEAD. */
  changed: string[];
  ahead: number;
  behind: number;
}

export type StepResult = "ok" | "skipped" | "failed";

export type StepName = "commit" | "fetch" | "merge" | "push";

export interface SyncStep {
  name: StepName;
  result: StepResult;
  detail: string;
}

export interface SyncReport {
  readonly steps: readonly SyncStep[];
  readonly conflicts: readonly ConflictFile[];
  /**
   * Set by whoever builds the report; read it rather than recomputing. True when
   * no attempted step failed and no conflict is outstanding — a `skipped` step
   * does not make a sync unsuccessful.
   */
  readonly success: boolean;
  /** Mutable: the plugin appends its own trace lines after the sync returns. */
  logs: string[];
}
```

- [ ] **Step 2: Create `src/constants.ts`**

```ts
export const DEFAULT_BRANCH = "main";

/**
 * Never synced, in either direction.
 *
 * `.obsidian/` and `.trash/` are per-device and would conflict constantly.
 * `.obsidian/` also holds this plugin's settings — including the GitHub token —
 * in plaintext, so excluding it is what keeps the token out of the repository.
 * `.git/` is git's own metadata; isomorphic-git already skips it, so listing it is
 * defence in depth rather than a fix for an observed problem.
 *
 * `readonly` is deliberate: this array is the token-leak guard, and every consumer
 * must copy it (`[...DEFAULT_EXCLUDES]`) before editing. Without the modifier, one
 * aliasing assignment plus a later `push` would corrupt the defaults that "reset
 * to defaults" restores.
 */
export const DEFAULT_EXCLUDES: readonly string[] = [
  ".obsidian/",
  ".git/",
  ".trash/",
];

/** Substituted with the current local date and time when a commit is made. */
export const TIMESTAMP_TOKEN = "{{timestamp}}";

export const DEFAULT_COMMIT_TEMPLATE = `Vault sync from mobile — ${TIMESTAMP_TOKEN}`;

/**
 * Fallback commit identity, used only when the authenticated login is unknown.
 *
 * The address is under `invalid.` — a reserved TLD that can never be registered or
 * delivered to (RFC 2606). A plausible-looking `@users.noreply.github.com` address
 * would be worse: GitHub would fail to attribute the commits, and if anyone ever
 * registered the matching account, every commit this plugin had made would be
 * attributed to them.
 */
export const COMMIT_AUTHOR: { readonly name: string; readonly email: string } = {
  name: "github-sync-mobile",
  email: "github-sync-mobile@localhost.invalid",
};

export const GITHUB_API = "https://api.github.com";

/**
 * Owner, repo, and branch names the plugin is willing to interpolate into a URL or
 * a ref. Deliberately strict: these come straight from text fields, and on iOS a
 * malformed value produces a confusing failure the user cannot inspect. Rejecting
 * it early lets the caller name the offending field instead.
 */
const SEGMENT = /^[A-Za-z0-9._-]+$/;

export function isValidSegment(value: string): boolean {
  return SEGMENT.test(value) && value !== "." && value !== "..";
}

export function repoUrl(owner: string, repo: string): string {
  if (!isValidSegment(owner)) {
    throw new Error(`Invalid repository owner: ${JSON.stringify(owner)}`);
  }
  if (!isValidSegment(repo)) {
    throw new Error(`Invalid repository name: ${JSON.stringify(repo)}`);
  }
  return `https://github.com/${owner}/${repo}.git`;
}
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/types.ts src/constants.ts
git commit -m "feat: settings, sync report, and merge outcome types"
```

---

## Task 4: Exclude engine

The single most load-bearing safety primitive. On iOS the user cannot see or repair
`.obsidian`/`.git`, so excluding a path is their only manual protection lever — it must be
exact and it must work in both directions.

**Files:**
- Create: `src/git/exclude.ts`
- Test: `tests/git/exclude.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/git/exclude.test.ts`. The final file has **31 tests** — the 12 below plus twelve
added while implementing, covering the bare-directory form, zero-depth `**`, both backtracking
collapses, and `matchesEverything`. Copy the committed file rather than only the block below:

```ts
import { describe, it, expect } from "vitest";
import { compileExcludes } from "../../src/git/exclude";
import { DEFAULT_EXCLUDES } from "../../src/constants";

describe("compileExcludes", () => {
  it("excludes a directory and everything beneath it", () => {
    const m = compileExcludes([".obsidian/"]);
    expect(m.isExcluded(".obsidian")).toBe(true);
    expect(m.isExcluded(".obsidian/app.json")).toBe(true);
    expect(m.isExcluded(".obsidian/plugins/x/data.json")).toBe(true);
  });

  it("does not exclude unrelated paths", () => {
    const m = compileExcludes([".obsidian/"]);
    expect(m.isExcluded("notes/a.md")).toBe(false);
    expect(m.isExcluded("obsidian-notes.md")).toBe(false);
  });

  // The prior plugin only supported `*`, so users wrote `.obsidian/*` and it
  // silently failed to match nested paths. Treat a trailing /* or /** as the
  // directory form so that footgun cannot recur.
  it("treats a trailing /* as the whole directory", () => {
    const m = compileExcludes([".obsidian/*"]);
    expect(m.isExcluded(".obsidian/plugins/x/data.json")).toBe(true);
  });

  it("treats a trailing /** as the whole directory", () => {
    const m = compileExcludes([".obsidian/**"]);
    expect(m.isExcluded(".obsidian/plugins/x/data.json")).toBe(true);
  });

  it("matches * within a single path segment only", () => {
    const m = compileExcludes(["*.png"]);
    expect(m.isExcluded("a.png")).toBe(true);
    expect(m.isExcluded("sub/a.png")).toBe(false);
  });

  it("matches ** across path segments", () => {
    const m = compileExcludes(["**/*.png"]);
    expect(m.isExcluded("sub/deep/a.png")).toBe(true);
  });

  it("normalises leading ./ and / in both pattern and path", () => {
    const m = compileExcludes(["/.obsidian/"]);
    expect(m.isExcluded("./.obsidian/app.json")).toBe(true);
  });

  it("ignores blank lines and # comments", () => {
    const m = compileExcludes(["", "  ", "# a comment", ".git/"]);
    expect(m.isExcluded(".git/config")).toBe(true);
    expect(m.isExcluded("notes/a.md")).toBe(false);
  });

  it("excludes nothing when given no patterns", () => {
    const m = compileExcludes([]);
    expect(m.isExcluded(".obsidian/app.json")).toBe(false);
  });

  it("escapes regex metacharacters in patterns", () => {
    const m = compileExcludes(["a+b.md"]);
    expect(m.isExcluded("a+b.md")).toBe(true);
    expect(m.isExcluded("aab.md")).toBe(false);
  });

  it("applies the shipped defaults to the paths that caused the original bug", () => {
    const m = compileExcludes(DEFAULT_EXCLUDES);
    expect(m.isExcluded(".obsidian/app.json")).toBe(true);
    expect(m.isExcluded(".obsidian/plugins/github-sync-mobile/data.json")).toBe(true);
    expect(m.isExcluded(".git/config")).toBe(true);
    expect(m.isExcluded(".trash/old.md")).toBe(true);
    expect(m.isExcluded("LifeSystem/Skills.md")).toBe(false);
  });

  it("filters a list of paths, keeping order", () => {
    const m = compileExcludes([".obsidian/"]);
    expect(m.filter(["a.md", ".obsidian/app.json", "b.md"])).toEqual(["a.md", "b.md"]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/git/exclude.test.ts`
Expected: FAIL — cannot resolve `../../src/git/exclude`.

- [ ] **Step 3: Create `src/git/exclude.ts`**

```ts
export interface ExcludeMatcher {
  isExcluded(path: string): boolean;
  /**
   * Keeps only the non-excluded paths, preserving order.
   *
   * Named for what it returns rather than what it removes: read as `filter`, a call
   * site could plausibly be understood as keeping the excluded ones, and inverted at
   * clone-checkout that would write the remote's `.obsidian` over this device's config
   * and skip every note.
   */
  withoutExcluded(paths: string[]): string[];
}

/** Vault-relative, forward slashes, no leading ./ or /. */
function normalise(p: string): string {
  let out = p.replace(/\\/g, "/").trim();
  while (out.startsWith("./")) out = out.slice(2);
  while (out.startsWith("/")) out = out.slice(1);
  return out.replace(/\/{2,}/g, "/");
}

function toRegExp(rawPattern: string): RegExp {
  let p = normalise(rawPattern);

  // `dir/`, `dir/*` and `dir/**` all mean "dir and everything under it". Users of the
  // prior plugin wrote `dir/*` expecting recursion, so honour that intent rather than
  // silently under-matching. All three collapse to the bare name, because the
  // trailing-subtree match below applies to every pattern.
  //
  // Not redundant: stripping them is what makes `isExcluded(".obsidian")` true for
  // every spelling, which is how a caller prunes a whole subtree instead of walking
  // into it.
  if (p.endsWith("/**")) p = p.slice(0, -3);
  else if (p.endsWith("/*")) p = p.slice(0, -2);
  else if (p.endsWith("/")) p = p.slice(0, -1);

  // Collapse asterisk runs before translating them. Adjacent `.*` groups backtrack
  // exponentially in the length of the path being tested, and there is no timeout
  // anywhere in the sync path — so a pasted `****` is a wedged app, not a stutter.
  // Neither rewrite can ever broaden a pattern, and the star-run rewrite additionally
  // repairs a pre-existing over-match in `*{3,}/` shapes.
  //
  // Measurements, and why the plain-`*` case is the one that actually reaches a
  // settings box, are in docs/decisions-and-learnings.md under "A user-editable regex
  // is an attack surface on your own phone".
  p = p.replace(/\*{3,}/g, "**").replace(/(?:\*\*\/)+/g, "**/");

  // One ordered pass: longest wildcard first, everything else escaped.
  //
  // Single-pass is deliberate. A multi-step pipeline needs a placeholder to stop the
  // `*` rule eating the asterisks inside `**`, and a printable placeholder would itself
  // be rewritten — so `My Notes` would compile to `^My.*Notes$` and match
  // `My/Notes/a.md`. Over-matching an exclude means the file is never pushed, which is
  // silent backup loss. Here there is no placeholder to get wrong, and escaping cannot
  // accidentally run before translation.
  const body = p.replace(/\*\*\/|\*\*|\*|[.+^${}()|[\]\\?]/g, (token) => {
    if (token === "**/") return "(?:.*/)?";
    if (token === "**") return ".*";
    if (token === "*") return "[^/]*";
    return `\\${token}`;
  });

  // Every pattern also matches everything beneath whatever it matched.
  //
  // This is what makes a bare `.obsidian` behave like `.obsidian/`. Without it, a user
  // who drops the trailing slash still excludes the directory entry but silently syncs
  // its contents — which for `.obsidian` means publishing the plugin's settings file,
  // and with it the GitHub token. Same rule .gitignore uses for a pattern naming a
  // directory.
  return new RegExp(`^${body}(?:/.*)?$`);
}

/**
 * True when a single pattern would exclude every file in any vault.
 *
 * Decided by probing rather than by inspecting the pattern, so no arrangement of
 * asterisks slips past a structural check.
 *
 * Detects *universality* only, and that limit is real: a pattern covering every
 * extension a given vault happens to use — `**` followed by `/*.md` in a Markdown-only
 * vault, the common Obsidian case — excludes everything the user has while sparing a
 * hypothetical `.png`, so it is not flagged here. The vault-relative question ("how many
 * of this user's files would this exclude?") can only be answered where the file list
 * is, so the settings tab reports that separately. Both matter, because silencing the
 * sync yields a successful-looking sync over an empty change set.
 */
export function matchesEverything(pattern: string): boolean {
  // Deliberately share no character in common. An earlier probe set all contained "a"
  // and ".", so patterns like `**a*` tripped it while sparing real files.
  const probes = [
    "a.md",
    "sub/a.md",
    "sub/deep/a.png",
    ".obsidian/app.json",
    "z",
    "Q3/log.txt",
    "no-extension",
  ];
  const m = compileExcludes([pattern]);
  return probes.every((probe) => m.isExcluded(probe));
}

export function compileExcludes(patterns: readonly string[]): ExcludeMatcher {
  const regexes = patterns
    .map((p) => p.trim())
    .filter((p) => p.length > 0 && !p.startsWith("#"))
    .map(toRegExp);

  const isExcluded = (path: string): boolean => {
    const n = normalise(path);
    if (n === "") return false;
    return regexes.some((re) => re.test(n));
  };

  return {
    isExcluded,
    withoutExcluded: (paths) => paths.filter((p) => !isExcluded(p)),
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/git/exclude.test.ts`
Expected: PASS, 31 tests. Four matter most: the bare-directory case closes a token-leak footgun,
the two backtracking guards close a wedged app, and `matchesEverything` is what stops one stray
character silencing the whole sync.

- [ ] **Step 5: Commit**

```bash
git add src/git/exclude.ts tests/git/exclude.test.ts
git commit -m "feat: exclude engine with recursive directory semantics"
```

---

## Task 5: Filesystem adapter

Bridges Obsidian's `DataAdapter` to the `fs.promises` shape isomorphic-git expects.

Three constraints inherited from earlier tasks, all load-bearing:

- **Never produce a native Node `Buffer`.** esbuild's `inject` shadows the `Buffer` identifier
  on every platform, and the polyfill's `Buffer.isBuffer` tests `_isBuffer === true`, which is
  false for a native Buffer — while isomorphic-git's GitIndex calls `Buffer.isBuffer(...)`.
  Return `Uint8Array` from `readFile` and stay on `Uint8Array`/`ArrayBuffer` throughout.
- **Hand `writeBinary` an exact-size `ArrayBuffer`.** `writeBinary` stores the whole underlying
  buffer, so passing `someView.buffer` for a subarray silently writes trailing garbage.
  `new Uint8Array(data)` then `.buffer` is exact-size and correct; do not "optimise" the copy away.
- **Do not silently create parent directories on write.** The adapter refuses, matching the real
  one. isomorphic-git recovers on its own by mkdir-ing the parent and retrying, so propagate the
  error (with `code: "ENOENT"`) instead of masking it. If a needed `mkdir` were hidden here, the
  omission would only ever surface on a phone. **If real isomorphic-git turns out not to recover,
  report it — do not loosen the adapter.**
- **`EISDIR` is a real outcome now.** The adapter enforces that files and folders never occupy
  the same path, so writing to a path held by a folder rejects with `code: "EISDIR"` and
  `mkdir` at or under an existing file rejects with `code: "ENOTDIR"`. Map or propagate these;
  do not swallow them.
- **Record unexpected read failures, because no error code can save you here.**
  isomorphic-git's `readdir` maps only `ENOTDIR` to `null` and swallows **everything else,
  including `ENOENT`, as `[]`** — an empty directory. So a directory read that fails for a
  transient reason is indistinguishable from an empty directory at the walker, and every file
  beneath it is reported as deleted. That deletion then flows into commit and push: a durable
  removal of files that still exist.

  No choice of error code fixes this, so the bridge exposes the failure out of band. Alongside
  `promises`, `createFs` returns a `readFailures` list and a `clearReadFailures()`. The bridge
  records a path whenever a read fails for a reason that is *not* genuine absence — notably when
  `stat` says a path is a folder but `list` then throws. `SafeGit` clears the list before
  computing status and refuses to proceed if anything landed in it. Still throw with the right
  code (`ENOENT` for missing, `ENOTDIR` for a file path) — the codes matter for the write-retry
  path — but do not rely on them being visible to the walker.

Two further gotchas were real bugs in the prior plugin and are covered by tests:

1. The vault root must map to `""`. Obsidian's adapter treats `""` as the root; passing the
   absolute base path instead makes `list()` look for a subfolder named after the vault, which
   reports an empty working tree and produces phantom commits on mobile.
2. `readFile` is called both as `{ encoding: "utf8" }` and as the bare string `"utf8"`.
   Handling only the object form returns a Buffer where a string is expected and silently
   breaks gitignore parsing.

**Files:**
- Create: `src/git/fs-adapter.ts`
- Test: `tests/git/fs-adapter.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/git/fs-adapter.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { createFs } from "../../src/git/fs-adapter";
import { MemoryAdapter } from "../mocks/memory-adapter";

function setup(base = "") {
  const adapter = new MemoryAdapter();
  const fs = createFs(adapter, base);
  return { adapter, fs: fs.promises };
}

describe("fs-adapter", () => {
  it("writes and reads a utf8 file with the options-object form", async () => {
    const { fs } = setup();
    await fs.writeFile("a.md", "hello");
    expect(await fs.readFile("a.md", { encoding: "utf8" })).toBe("hello");
  });

  it("accepts the bare-string encoding form", async () => {
    const { fs } = setup();
    await fs.writeFile("a.md", "hello");
    expect(await fs.readFile("a.md", "utf8")).toBe("hello");
  });

  it("returns a Uint8Array when no encoding is given", async () => {
    const { fs } = setup();
    await fs.writeFile("a.bin", new Uint8Array([1, 2, 3]));
    const out = await fs.readFile("a.bin");
    expect(out instanceof Uint8Array).toBe(true);
    expect(Array.from(out as Uint8Array)).toEqual([1, 2, 3]);
  });

  // isomorphic-git hands "." to the fs for working-tree walks. Left unmapped it
  // reaches Obsidian as a path that does not exist, and statusMatrix/checkout throw.
  it("maps the repo root \".\" to the vault root", async () => {
    const { adapter, fs } = setup();
    await adapter.write("a.md", "x");
    expect(await fs.readdir(".")).toEqual(["a.md"]);
    expect((await fs.stat(".")).isDirectory()).toBe(true);
  });

  it("maps the repo root \".\" to the vault root with a base configured too", async () => {
    const { adapter, fs } = setup("/vault");
    await adapter.write("a.md", "x");
    expect(await fs.readdir(".")).toEqual(["a.md"]);
  });

  it("maps the vault root to an empty path when a base is configured", async () => {
    const { adapter, fs } = setup("/vault");
    await adapter.write("a.md", "x");
    // Listing the base itself must list the vault root, not a subfolder.
    expect(await fs.readdir("/vault")).toEqual(["a.md"]);
  });

  it("strips the base prefix from nested absolute paths", async () => {
    const { adapter, fs } = setup("/vault");
    await adapter.mkdir("notes");
    await adapter.write("notes/a.md", "x");
    expect(await fs.readFile("/vault/notes/a.md", "utf8")).toBe("x");
  });

  it("throws ENOENT with a code for a missing file", async () => {
    const { fs } = setup();
    await expect(fs.readFile("missing.md", "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("throws ENOENT with a code from stat on a missing path", async () => {
    const { fs } = setup();
    await expect(fs.stat("missing.md")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports files and directories through stat", async () => {
    const { fs } = setup();
    await fs.mkdir("dir");
    await fs.writeFile("dir/a.md", "x");
    const fileStat = await fs.stat("dir/a.md");
    expect(fileStat.isFile()).toBe(true);
    expect(fileStat.isDirectory()).toBe(false);
    const dirStat = await fs.stat("dir");
    expect(dirStat.isDirectory()).toBe(true);
  });

  it("lists only immediate children as bare names", async () => {
    const { fs } = setup();
    await fs.mkdir("dir");
    await fs.writeFile("dir/a.md", "x");
    await fs.mkdir("dir/sub");
    await fs.writeFile("dir/sub/b.md", "y");
    expect((await fs.readdir("dir")).sort()).toEqual(["a.md", "sub"]);
  });

  // The adapter refuses to invent parent folders, exactly like the real one.
  // isomorphic-git recovers from this itself (it catches the failed write, mkdirs
  // the parent, and retries), so the bridge must propagate the error rather than
  // hiding it behind an implicit mkdir -- otherwise a missing mkdir would only
  // ever surface on a phone.
  it("propagates ENOENT when the parent directory does not exist", async () => {
    const { fs } = setup();
    await expect(fs.writeFile("missing/a.md", "x")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("throws ENOENT from readdir for a missing path", async () => {
    const { fs } = setup();
    await expect(fs.readdir("nope")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("throws ENOTDIR from readdir for a file path", async () => {
    const { fs } = setup();
    await fs.writeFile("a.md", "x");
    await expect(fs.readdir("a.md")).rejects.toMatchObject({ code: "ENOTDIR" });
  });

  // The distinction being protected: an existing but empty directory must list
  // as empty, not throw -- that is what separates "empty" from "gone".
  it("returns an empty array for an existing empty directory", async () => {
    const { fs } = setup();
    await fs.mkdir("empty");
    expect(await fs.readdir("empty")).toEqual([]);
  });

  it("deletes a file with unlink", async () => {
    const { fs } = setup();
    await fs.writeFile("a.md", "x");
    await fs.unlink("a.md");
    await expect(fs.stat("a.md")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("creates and removes directories", async () => {
    const { fs } = setup();
    await fs.mkdir("d");
    expect((await fs.stat("d")).isDirectory()).toBe(true);
    await fs.rmdir("d");
    await expect(fs.stat("d")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports no symlinks via lstat", async () => {
    const { fs } = setup();
    await fs.writeFile("a.md", "x");
    expect((await fs.lstat("a.md")).isSymbolicLink()).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/git/fs-adapter.test.ts`
Expected: FAIL — cannot resolve `../../src/git/fs-adapter`.

- [ ] **Step 3: Create `src/git/fs-adapter.ts`**

```ts
import type { DataAdapter } from "obsidian";

/**
 * Exactly the DataAdapter surface this bridge is allowed to touch.
 *
 * Naming the subset keeps the contract load-bearing: the in-memory adapter used
 * in tests satisfies this type structurally, so no cast is needed at the seam,
 * and a bridge that reached for some other DataAdapter member would fail to
 * compile rather than pass its tests and break on a device.
 */
export type VaultAdapter = Pick<
  DataAdapter,
  | "read"
  | "readBinary"
  | "write"
  | "writeBinary"
  | "exists"
  | "stat"
  | "list"
  | "mkdir"
  | "rmdir"
  | "remove"
>;

export interface FsPromises {
  readFile(path: string, options?: unknown): Promise<string | Uint8Array>;
  writeFile(path: string, data: string | Uint8Array, options?: unknown): Promise<void>;
  unlink(path: string): Promise<void>;
  readdir(path: string): Promise<string[]>;
  mkdir(path: string): Promise<void>;
  rmdir(path: string): Promise<void>;
  stat(path: string): Promise<StatsLike>;
  lstat(path: string): Promise<StatsLike>;
  readlink(path: string): Promise<string>;
  symlink(): Promise<void>;
}

interface StatsLike {
  type: "file" | "dir";
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  mode: number;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
  uid: number;
  gid: number;
  dev: number;
  ino: number;
}

function enoent(path: string): Error & { code: string } {
  const e = new Error(`ENOENT: no such file or directory, '${path}'`) as Error & {
    code: string;
  };
  e.code = "ENOENT";
  return e;
}

function enotdir(path: string): Error & { code: string } {
  const e = new Error(`ENOTDIR: not a directory, '${path}'`) as Error & {
    code: string;
  };
  e.code = "ENOTDIR";
  return e;
}

function makeStats(type: "file" | "dir", size: number, mtimeMs: number): StatsLike {
  return {
    type,
    size,
    mtimeMs,
    ctimeMs: mtimeMs,
    mode: type === "file" ? 0o100644 : 0o040755,
    isFile: () => type === "file",
    isDirectory: () => type === "dir",
    isSymbolicLink: () => false,
    uid: 0,
    gid: 0,
    dev: 1,
    ino: 0,
  };
}

/** isomorphic-git passes either { encoding } or a bare "utf8". Both must work. */
function wantsText(options: unknown): boolean {
  if (options === "utf8" || options === "utf-8") return true;
  if (typeof options === "object" && options !== null) {
    const enc = (options as { encoding?: string }).encoding;
    return enc === "utf8" || enc === "utf-8";
  }
  return false;
}

/**
 * Adapts Obsidian's DataAdapter to the fs.promises surface isomorphic-git needs.
 *
 * `base` is the vault's absolute path on desktop and "" on mobile. All paths
 * handed to the adapter must be vault-relative.
 */
export interface VaultFs {
  promises: FsPromises;
  /** Paths whose read failed for a reason other than genuine absence. */
  readonly readFailures: readonly string[];
  clearReadFailures(): void;
}

export function createFs(adapter: VaultAdapter, base: string): VaultFs {
  const normBase = base.replace(/\\/g, "/").replace(/\/+$/, "");

  /**
   * Reads that failed for a reason other than the path being absent.
   *
   * isomorphic-git cannot see these — its `readdir` reports any failure as an empty
   * directory — so they are surfaced here instead and checked by SafeGit before it trusts
   * a status. See the note above `readdir`.
   */
  const readFailures: string[] = [];

  const rel = (abs: string): string => {
    let p = abs.replace(/\\/g, "/");
    if (normBase) {
      // The base itself is the vault root, which Obsidian addresses as "".
      if (p === normBase) return "";
      if (p.startsWith(`${normBase}/`)) p = p.slice(normBase.length + 1);
    }
    // isomorphic-git normalises the repo root to "." and passes that through for
    // working-tree walks. Obsidian addresses the root as "", so "." must map to "" --
    // otherwise statusMatrix and checkout both fail with ENOENT on lstat('.'), and
    // status, clone-safe checkout, and merge are all unreachable. This bites on mobile
    // in particular, where the base path is "" and every path arrives root-relative.
    if (p === "." || p === "./") return "";
    while (p.startsWith("./")) p = p.slice(2);
    while (p.startsWith("/")) p = p.slice(1);
    return p;
  };

  const promises = {
    async readFile(path: string, options?: unknown): Promise<string | Uint8Array> {
      const p = rel(path);
      const st = await adapter.stat(p);
      if (!st || st.type !== "file") throw enoent(path);
      if (wantsText(options)) return adapter.read(p);
      return new Uint8Array(await adapter.readBinary(p));
    },

    async writeFile(
      path: string,
      data: string | Uint8Array,
      _options?: unknown,
    ): Promise<void> {
      const p = rel(path);
      if (typeof data === "string") {
        await adapter.write(p, data);
      } else {
        const copy = new Uint8Array(data);
        await adapter.writeBinary(p, copy.buffer as ArrayBuffer);
      }
    },

    async unlink(path: string): Promise<void> {
      const p = rel(path);
      const st = await adapter.stat(p);
      if (!st) throw enoent(path);
      await adapter.remove(p);
    },

    async readdir(path: string): Promise<string[]> {
      const p = rel(path);
      const st = await adapter.stat(p);
      // isomorphic-git converts ENOENT/ENOTDIR from readdir into `null`, which is
      // how it tells "absent or not a directory" apart from "an empty directory".
      // Collapsing the two would make a tree walk read an absent subtree as empty,
      // i.e. as deleted. Keep the codes distinct.
      if (p !== "") {
        if (!st) throw enoent(path);
        if (st.type !== "folder") throw enotdir(path);
      }
      // A failure here is invisible to isomorphic-git, which will read it as an empty
      // directory and conclude everything beneath was deleted. Record it so SafeGit can
      // refuse, then rethrow.
      let listing: { files: string[]; folders: string[] };
      try {
        listing = await adapter.list(p);
      } catch (err) {
        readFailures.push(p);
        throw err;
      }
      const base = p === "" ? "" : `${p}/`;
      return [...listing.files, ...listing.folders].map((f) =>
        f.startsWith(base) ? f.slice(base.length) : f,
      );
    },

    async mkdir(path: string): Promise<void> {
      await adapter.mkdir(rel(path));
    },

    async rmdir(path: string): Promise<void> {
      const p = rel(path);
      const st = await adapter.stat(p);
      if (!st) throw enoent(path);
      await adapter.rmdir(p, false);
    },

    async stat(path: string): Promise<StatsLike> {
      const p = rel(path);
      if (p === "") return makeStats("dir", 0, 0);
      const st = await adapter.stat(p);
      if (!st) throw enoent(path);
      return makeStats(st.type === "file" ? "file" : "dir", st.size, st.mtime);
    },

    async lstat(path: string): Promise<StatsLike> {
      return promises.stat(path);
    },

    async readlink(path: string): Promise<string> {
      throw enoent(path);
    },

    async symlink(): Promise<void> {
      throw new Error("symlinks are not supported in an Obsidian vault");
    },
  };

  return {
    promises,
    get readFailures() {
      return readFailures;
    },
    clearReadFailures() {
      readFailures.length = 0;
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/git/fs-adapter.test.ts`
Expected: PASS, 18 tests.

- [ ] **Step 5: Commit**

```bash
git add src/git/fs-adapter.ts tests/git/fs-adapter.test.ts
git commit -m "feat: Obsidian DataAdapter to isomorphic-git fs bridge"
```

---

## Task 6: HTTP client

Routes every git request through Obsidian's `requestUrl`, which is not subject to browser
CORS. This is what removes the need for a third-party CORS proxy — important because a proxy
would see the contents of a private vault.

### Two `requestUrl` rules that apply to every network task (6 and 13)

Both come from the test harness having a deliberately narrower stub than the real API, so
violating either would pass tests and behave differently on a device.

1. **Always `await` the call, then read properties off the result.** The real API also allows
   `await requestUrl(p).json` — awaiting a *property* of the returned promise object. The stub
   does not model that form: it returns a plain promise, so `.json` reads as `undefined` in every
   test while working on a phone. Code written that way typechecks (because `tsc` resolves
   `obsidian` in `src/` to the real package) and silently takes the wrong branch under test.
   Use `const res = await requestUrl({...})` and then `res.status` / `res.text` /
   `res.arrayBuffer` / `res.headers`.
2. **Pass `throw: false` and inspect the status yourself; never rely on a thrown error carrying
   a status.** The real `requestUrl` throws on 400+ unless `throw: false`, and the typings promise
   no `status` property on that error. The stub attaches one for convenience, so keying a decision
   on `err.status` would work in tests and read `undefined` in production. Git and the GitHub API
   both need to see 401/403/404/409 as ordinary responses, which is exactly why both clients pass
   `throw: false`.

**Files:**
- Create: `src/git/http-client.ts`
- Test: `tests/git/http-client.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/git/http-client.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { setRequestUrlHandler, type RequestUrlParam } from "../mocks/obsidian";
import { httpClient } from "../../src/git/http-client";

function capture(status = 200, responseBody = "ok") {
  const calls: RequestUrlParam[] = [];
  setRequestUrlHandler(async (p) => {
    calls.push(p);
    return {
      status,
      headers: { "content-type": "application/x-git-upload-pack-result" },
      arrayBuffer: new TextEncoder().encode(responseBody).buffer as ArrayBuffer,
      text: responseBody,
      json: undefined,
    };
  });
  return calls;
}

async function drain(body: AsyncIterableIterator<Uint8Array> | Uint8Array[]) {
  const chunks: number[] = [];
  for await (const c of body as AsyncIterable<Uint8Array>) chunks.push(...c);
  return new Uint8Array(chunks);
}

describe("httpClient", () => {
  it("passes url, method and headers through to requestUrl", async () => {
    const calls = capture();
    await httpClient.request({
      url: "https://github.com/o/r.git/info/refs",
      method: "GET",
      headers: { Authorization: "Basic abc" },
    });
    expect(calls[0].url).toBe("https://github.com/o/r.git/info/refs");
    expect(calls[0].method).toBe("GET");
    expect(calls[0].headers?.Authorization).toBe("Basic abc");
  });

  it("never lets requestUrl throw on non-2xx, so git sees the status", async () => {
    const calls = capture(401, "bad creds");
    const res = await httpClient.request({ url: "https://x", method: "GET" });
    expect(calls[0].throw).toBe(false);
    expect(res.statusCode).toBe(401);
  });

  it("concatenates an async-iterable request body before sending", async () => {
    const calls = capture();
    async function* body() {
      yield new Uint8Array([1, 2]);
      yield new Uint8Array([3]);
    }
    await httpClient.request({
      url: "https://x",
      method: "POST",
      body: body() as never,
    });
    expect(Array.from(new Uint8Array(calls[0].body as ArrayBuffer))).toEqual([1, 2, 3]);
  });

  it("accepts an array of Uint8Array as the body", async () => {
    const calls = capture();
    await httpClient.request({
      url: "https://x",
      method: "POST",
      body: [new Uint8Array([7, 8])] as never,
    });
    expect(Array.from(new Uint8Array(calls[0].body as ArrayBuffer))).toEqual([7, 8]);
  });

  it("returns the response body as an iterable of Uint8Array", async () => {
    capture(200, "hello");
    const res = await httpClient.request({ url: "https://x", method: "GET" });
    expect(new TextDecoder().decode(await drain(res.body))).toBe("hello");
  });

  it("returns response headers and echoes url and method", async () => {
    capture();
    const res = await httpClient.request({ url: "https://x", method: "GET" });
    expect(res.url).toBe("https://x");
    expect(res.method).toBe("GET");
    expect(res.headers["content-type"]).toContain("git-upload-pack-result");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/git/http-client.test.ts`
Expected: FAIL — cannot resolve `../../src/git/http-client`.

- [ ] **Step 3: Create `src/git/http-client.ts`**

```ts
import { requestUrl } from "obsidian";

export interface GitHttpRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: AsyncIterableIterator<Uint8Array> | Uint8Array[];
}

export interface GitHttpResponse {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Uint8Array[];
  statusCode: number;
  statusMessage: string;
}

async function concatBody(
  body: AsyncIterableIterator<Uint8Array> | Uint8Array[] | undefined,
): Promise<ArrayBuffer | undefined> {
  if (!body) return undefined;
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of body as AsyncIterable<Uint8Array>) {
    chunks.push(chunk);
    total += chunk.byteLength;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out.buffer as ArrayBuffer;
}

/**
 * isomorphic-git http plugin backed by Obsidian's requestUrl.
 *
 * requestUrl is not CORS-bound, so no CORS proxy is needed — nothing outside
 * GitHub ever sees the vault. `throw: false` is essential: git must observe
 * 401/404 status codes itself rather than having them raised as exceptions.
 */
export const httpClient = {
  async request(req: GitHttpRequest): Promise<GitHttpResponse> {
    const method = req.method ?? "GET";
    const body = await concatBody(req.body);

    const res = await requestUrl({
      url: req.url,
      method,
      headers: req.headers,
      body,
      throw: false,
    });

    return {
      url: req.url,
      method,
      headers: res.headers ?? {},
      body: [new Uint8Array(res.arrayBuffer)],
      statusCode: res.status,
      statusMessage: String(res.status),
    };
  },
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/git/http-client.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/git/http-client.ts tests/git/http-client.test.ts
git commit -m "feat: git http client over Obsidian requestUrl"
```

---

## Task 7: SafeGit — construction, repo state, and status

`safe-git.ts` is the only module allowed to import `isomorphic-git`. Destructive primitives
live here as module-private functions; the exported class never accepts a `force` flag.

This task builds the read-only surface, including the **phantom-deletion suppression** that
prevents excluded-but-remote-tracked files from being reported as deletions and pushed as
removals.

**Files:**
- Create: `src/git/safe-git.ts`
- Test: `tests/git/safe-git-status.test.ts`, `tests/helpers/repo.ts`

- [ ] **Step 1: Create the shared test repo helper**

Create `tests/helpers/repo.ts`:

```ts
import git from "isomorphic-git";
import { createFs } from "../../src/git/fs-adapter";
import { compileExcludes } from "../../src/git/exclude";
import { MemoryAdapter } from "../mocks/memory-adapter";
import { SafeGit } from "../../src/git/safe-git";
import { COMMIT_AUTHOR } from "../../src/constants";

export interface Harness {
  adapter: MemoryAdapter;
  fs: ReturnType<typeof createFs>;
  dir: string;
  safeGit: SafeGit;
  /** Write a working-tree file. */
  write(path: string, content: string): Promise<void>;
  /** Stage and commit given paths, returning the new oid. */
  commit(paths: string[], message: string): Promise<string>;
}

export async function makeHarness(
  excludes: string[] = [".obsidian/", ".git/", ".trash/"],
): Promise<Harness> {
  const adapter = new MemoryAdapter();
  const fs = createFs(adapter, "");
  const dir = "";

  const safeGit = new SafeGit({
    fs,
    http: { request: async () => { throw new Error("network not used in this test"); } },
    dir,
    url: "https://github.com/o/r.git",
    token: "t",
    branch: "main",
    exclude: compileExcludes(excludes),
  });

  /**
   * Writes a working-tree file, creating parent folders first.
   *
   * The adapter deliberately refuses to invent parents, matching the real one. Real git
   * copes because isomorphic-git catches the failed write, mkdirs, and retries — but this
   * helper bypasses git, so it has to do that itself. Without this, `initRepo`'s first
   * line fails and with it every test in Tasks 7 through 12.
   */
  const write = async (path: string, content: string) => {
    const i = path.lastIndexOf("/");
    if (i > 0) await adapter.mkdir(path.slice(0, i));
    await adapter.write(path, content);
  };

  const commit = async (paths: string[], message: string) => {
    for (const p of paths) await git.add({ fs, dir, filepath: p });
    return git.commit({ fs, dir, message, author: COMMIT_AUTHOR });
  };

  return { adapter, fs, dir, safeGit, write, commit };
}

/** Initialise a repo on `main` with one commit. */
export async function initRepo(h: Harness): Promise<string> {
  await git.init({ fs: h.fs, dir: h.dir, defaultBranch: "main" });
  await h.write("notes/a.md", "first\n");
  return h.commit(["notes/a.md"], "initial");
}

/**
 * Simulate a fetched remote by pointing refs/remotes/origin/main at an oid,
 * so merge tests need no network.
 */
export async function setOriginRef(h: Harness, oid: string): Promise<void> {
  await git.writeRef({
    fs: h.fs,
    dir: h.dir,
    ref: "refs/remotes/origin/main",
    value: oid,
    force: true,
  });
}
```

- [ ] **Step 2: Write the failing status tests**

Create `tests/git/safe-git-status.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import git from "isomorphic-git";
import { makeHarness, initRepo, setOriginRef } from "../helpers/repo";

describe("SafeGit.isRepo / hasLocalContent", () => {
  it("reports not-a-repo before init", async () => {
    const h = await makeHarness();
    expect(await h.safeGit.isRepo()).toBe(false);
  });

  it("reports a repo after init", async () => {
    const h = await makeHarness();
    await initRepo(h);
    expect(await h.safeGit.isRepo()).toBe(true);
  });

  it("treats a vault holding only excluded files as having no content", async () => {
    const h = await makeHarness();
    await h.write(".obsidian/app.json", "{}");
    await h.write(".obsidian/plugins/github-sync-mobile/data.json", "{}");
    expect(await h.safeGit.hasLocalContent()).toBe(false);
  });

  it("treats a vault holding a real note as having content", async () => {
    const h = await makeHarness();
    await h.write(".obsidian/app.json", "{}");
    await h.write("notes/a.md", "hello");
    expect(await h.safeGit.hasLocalContent()).toBe(true);
  });
});

describe("SafeGit.status", () => {
  it("lists a modified non-excluded file as changed", async () => {
    const h = await makeHarness();
    await initRepo(h);
    await h.write("notes/a.md", "changed\n");
    const s = await h.safeGit.status();
    expect(s.changed).toEqual(["notes/a.md"]);
  });

  it("lists a new non-excluded file as changed", async () => {
    const h = await makeHarness();
    await initRepo(h);
    await h.write("notes/new.md", "new\n");
    const s = await h.safeGit.status();
    expect(s.changed).toContain("notes/new.md");
  });

  it("ignores changes inside excluded paths", async () => {
    const h = await makeHarness();
    await initRepo(h);
    await h.write(".obsidian/app.json", "{}");
    const s = await h.safeGit.status();
    expect(s.changed).toEqual([]);
  });

  // The phantom-deletion trap: the remote already tracks .obsidian/*, we never
  // check those files out, so a naive status would call them deletions and push
  // the removal — wiping them from the cloud.
  it("does not report an excluded file tracked in HEAD but absent on disk as a deletion", async () => {
    const h = await makeHarness();
    await git.init({ fs: h.fs, dir: h.dir, defaultBranch: "main" });
    await h.write("notes/a.md", "a\n");
    await h.write(".obsidian/app.json", "{}");
    await h.commit(["notes/a.md", ".obsidian/app.json"], "tracks obsidian config");
    // Simulate clone-safe: the excluded file is in HEAD but never written to disk.
    await h.adapter.remove(".obsidian/app.json");

    const s = await h.safeGit.status();
    expect(s.changed).toEqual([]);
  });

  /**
   * The guard for a hazard the git layer cannot see. isomorphic-git's readdir reports any
   * read failure other than ENOTDIR as an EMPTY directory, so a transient failure makes
   * every file beneath look deleted while the files are still on disk. Committing that
   * would push a deletion of files that exist.
   */
  it("refuses to report a status when a directory read failed", async () => {
    const h = await makeHarness();
    await initRepo(h);
    h.adapter.failReadsAt("notes", "EIO");

    await expect(h.safeGit.status()).rejects.toThrow(/refusing to continue/i);

    h.adapter.clearReadFailures();
    expect((await h.safeGit.status()).changed).toEqual([]);
  });

  it("refuses to commit a deletion for a file that is still on disk", async () => {
    const h = await makeHarness();
    await initRepo(h);
    // The file is present, but the scan will claim it is gone.
    h.adapter.failReadsAt("notes", "EIO");
    await expect(h.safeGit.commitLocal("sync")).rejects.toThrow(/nothing was changed/i);
    h.adapter.clearReadFailures();
    expect(await h.adapter.read("notes/a.md")).toBe("first\n");
  });

  it("reports a genuine deletion of a non-excluded file", async () => {
    const h = await makeHarness();
    await initRepo(h);
    await h.adapter.remove("notes/a.md");
    const s = await h.safeGit.status();
    expect(s.changed).toEqual(["notes/a.md"]);
  });

  it("computes ahead and behind against the remote-tracking ref", async () => {
    const h = await makeHarness();
    const first = await initRepo(h);
    await setOriginRef(h, first);
    await h.write("notes/b.md", "b\n");
    await h.commit(["notes/b.md"], "second");

    const s = await h.safeGit.status();
    expect(s.ahead).toBe(1);
    expect(s.behind).toBe(0);
  });

  it("reports zero ahead and behind when in sync", async () => {
    const h = await makeHarness();
    const first = await initRepo(h);
    await setOriginRef(h, first);
    const s = await h.safeGit.status();
    expect(s.ahead).toBe(0);
    expect(s.behind).toBe(0);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run tests/git/safe-git-status.test.ts`
Expected: FAIL — cannot resolve `../../src/git/safe-git`.

- [ ] **Step 4: Create `src/git/safe-git.ts` with construction, state, and status**

```ts
import git, { TREE } from "isomorphic-git";
import type { ExcludeMatcher } from "./exclude";
import type { VaultFs } from "./fs-adapter";
import type { ConflictFile, RepoStatus } from "../types";
import { COMMIT_AUTHOR } from "../constants";

interface ThreeWayRow {
  path: string;
  baseOid: string | null;
  oursOid: string | null;
  theirsOid: string | null;
}

/**
 * A conflict awaiting the user's decision. Recorded by `mergeSafe` and consumed by
 * `resolveConflicts`; while it is set, the repository is byte-identical to its
 * pre-merge state.
 */
interface PendingConflict {
  ourHead: string;
  theirHead: string;
  files: ConflictFile[];
}

export interface SafeGitOptions {
  /** The bridge from `createFs`. Typed so its read-failure channel stays reachable. */
  fs: VaultFs;
  http: unknown;
  /** Repo working directory. "" is the vault root on mobile. */
  dir: string;
  url: string;
  token: string;
  branch: string;
  exclude: ExcludeMatcher;
  onLog?: (line: string) => void;
}

/**
 * The only module that imports isomorphic-git.
 *
 * Safety rules enforced here and nowhere else:
 *  - `force: true` checkout is never reachable from any public method.
 *  - Working-tree-touching operations dry-run first.
 *  - Excluded paths are inert in both directions and never register as deletions.
 *
 * Destructive primitives are module-private functions; the class exposes no
 * parameter that could turn a safe call into a clobbering one.
 */
export class SafeGit {
  /** Passed to isomorphic-git, which only ever touches `.promises`. */
  private readonly fs: never;
  /** The same object, typed so `readFailures` and `promises` are reachable. */
  private readonly fsChannel: VaultFs;
  private readonly http: never;
  private readonly dir: string;
  private readonly url: string;
  private readonly token: string;
  private readonly branch: string;
  private readonly exclude: ExcludeMatcher;
  private readonly onLog: (line: string) => void;
  /** Set while a conflict awaits resolution; see PendingConflict. */
  private pending: PendingConflict | null = null;

  constructor(opts: SafeGitOptions) {
    this.fs = opts.fs as unknown as never;
    this.fsChannel = opts.fs;
    this.http = opts.http as never;
    this.dir = opts.dir;
    this.url = opts.url;
    this.token = opts.token;
    this.branch = opts.branch;
    this.exclude = opts.exclude;
    this.onLog = opts.onLog ?? (() => {});
  }

  private log(line: string): void {
    this.onLog(line);
  }

  /** Shared options for local operations. */
  private base() {
    return { fs: this.fs, dir: this.dir };
  }

  /** Shared options for network operations. Credentials come from onAuth. */
  private net() {
    return {
      fs: this.fs,
      http: this.http,
      dir: this.dir,
      url: this.url,
      onAuth: () => ({ username: this.token, password: "x-oauth-basic" }),
    };
  }

  async isRepo(): Promise<boolean> {
    try {
      await git.resolveRef({ ...this.base(), ref: "HEAD", depth: 1 });
      return true;
    } catch {
      try {
        await git.findRoot({ fs: this.fs, filepath: this.dir });
        return true;
      } catch {
        return false;
      }
    }
  }

  /** The configured remote URL, or null when there is none. */
  async currentRemoteUrl(): Promise<string | null> {
    try {
      const remotes = await git.listRemotes(this.base());
      return remotes.find((r) => r.remote === "origin")?.url ?? null;
    } catch {
      return null;
    }
  }

  /** True when at least one non-excluded file exists in the working tree. */
  async hasLocalContent(): Promise<boolean> {
    const files = await this.listWorkingFiles("");
    return files.length > 0;
  }

  /** Recursively lists non-excluded working-tree files. */
  private async listWorkingFiles(prefix: string): Promise<string[]> {
    const fs = this.fsChannel;
    const out: string[] = [];
    let entries: string[];
    try {
      entries = await fs.promises.readdir(prefix === "" ? this.dir : prefix);
    } catch {
      return out;
    }
    for (const entry of entries) {
      const rel = prefix === "" ? entry : `${prefix}/${entry}`;
      if (this.exclude.isExcluded(rel)) continue;
      let isDir = false;
      try {
        isDir = (await fs.promises.stat(rel)).isDirectory();
      } catch {
        continue;
      }
      if (isDir) out.push(...(await this.listWorkingFiles(rel)));
      else out.push(rel);
    }
    return out;
  }

  /**
   * Changed non-excluded files plus ahead/behind counts.
   *
   * Excluded paths are erased from the matrix entirely — they are not
   * modifications and, critically, not deletions. Without this an excluded file
   * that the remote tracks but we never checked out would be committed as a
   * deletion and pushed, removing it from the remote.
   */
  async status(): Promise<RepoStatus> {
    const matrix = await this.scanWorkingTree();

    const changed = matrix
      .filter(([, head, workdir, stage]) => !(head === 1 && workdir === 1 && stage === 1))
      .map(([filepath]) => filepath)
      .filter((f) => !this.exclude.isExcluded(f));

    const { ahead, behind } = await this.aheadBehind();
    return { changed, ahead, behind };
  }

  /**
   * Runs `statusMatrix`, refusing the result if any directory read failed.
   *
   * This is the guard for a hazard nothing downstream can see. isomorphic-git's `readdir`
   * reports any read failure other than ENOTDIR as an *empty directory*, so a transient
   * failure — iOS suspending the app, memory pressure — makes every file beneath that
   * folder look deleted, while the files are still on disk. Committing that status would
   * push a deletion of files that exist.
   *
   * The fs bridge records such failures out of band; if any occurred, the scan is not
   * trustworthy and we stop rather than guess.
   */
  private async scanWorkingTree(): Promise<Array<[string, number, number, number]>> {
    this.fsChannel.clearReadFailures();
    const matrix = (await git.statusMatrix({
      ...this.base(),
      filter: (f) => !this.exclude.isExcluded(f),
    })) as Array<[string, number, number, number]>;

    const failed = this.fsChannel.readFailures;
    if (failed.length > 0) {
      throw new Error(
        `Could not read ${failed.length} path(s) while scanning the vault ` +
          `(${failed.slice(0, 3).join(", ")}). Refusing to continue, because an ` +
          `unreadable folder is indistinguishable from an empty one and would look ` +
          `like you had deleted its contents. Nothing was changed — try again.`,
      );
    }
    return matrix;
  }

  private async aheadBehind(): Promise<{ ahead: number; behind: number }> {
    const local = await this.tryResolve(`refs/heads/${this.branch}`);
    const remote = await this.tryResolve(`refs/remotes/origin/${this.branch}`);
    if (!local || !remote) return { ahead: local ? 1 : 0, behind: remote ? 1 : 0 };
    if (local === remote) return { ahead: 0, behind: 0 };

    const localLog = await this.oidSet(local);
    const remoteLog = await this.oidSet(remote);
    const ahead = [...localLog].filter((o) => !remoteLog.has(o)).length;
    const behind = [...remoteLog].filter((o) => !localLog.has(o)).length;
    return { ahead, behind };
  }

  private async oidSet(ref: string): Promise<Set<string>> {
    const commits = await git.log({ ...this.base(), ref });
    return new Set(commits.map((c) => c.oid));
  }

  /** True when the path is still present in the working tree. */
  private async stillOnDisk(filepath: string): Promise<boolean> {
    try {
      await this.fsChannel.promises.stat(this.join(filepath));
      return true;
    } catch {
      return false;
    }
  }

  private async tryResolve(ref: string): Promise<string | null> {
    try {
      return await git.resolveRef({ ...this.base(), ref });
    } catch {
      return null;
    }
  }

  private author() {
    return COMMIT_AUTHOR;
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/git/safe-git-status.test.ts`
Expected: PASS, 13 tests. The phantom-deletion test and the two read-failure refusals are
the important ones.

- [ ] **Step 6: Commit**

```bash
git add src/git/safe-git.ts tests/git/safe-git-status.test.ts tests/helpers/repo.ts
git commit -m "feat: SafeGit repo state and status with phantom-deletion suppression"
```

---

## Task 8: SafeGit — commit local changes

Invariant 2: local work becomes a real commit **before** any merge. This is what makes
isomorphic-git issue #1046 (pull silently discarding uncommitted edits) unreachable.

**Files:**
- Modify: `src/git/safe-git.ts`
- Test: `tests/git/safe-git-commit.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/git/safe-git-commit.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import git from "isomorphic-git";
import { makeHarness, initRepo } from "../helpers/repo";

describe("SafeGit.commitLocal", () => {
  it("commits a modified file and returns the new oid", async () => {
    const h = await makeHarness();
    const first = await initRepo(h);
    await h.write("notes/a.md", "changed\n");

    const oid = await h.safeGit.commitLocal("sync");
    expect(oid).not.toBeNull();
    expect(oid).not.toBe(first);

    const head = await git.resolveRef({ fs: h.fs, dir: h.dir, ref: "HEAD" });
    expect(head).toBe(oid);
  });

  it("commits a newly added file", async () => {
    const h = await makeHarness();
    await initRepo(h);
    await h.write("notes/new.md", "new\n");
    await h.safeGit.commitLocal("sync");

    const files = await git.listFiles({ fs: h.fs, dir: h.dir, ref: "HEAD" });
    expect(files).toContain("notes/new.md");
  });

  it("commits a deletion of a tracked file", async () => {
    const h = await makeHarness();
    await initRepo(h);
    await h.adapter.remove("notes/a.md");
    await h.safeGit.commitLocal("sync");

    const files = await git.listFiles({ fs: h.fs, dir: h.dir, ref: "HEAD" });
    expect(files).not.toContain("notes/a.md");
  });

  it("returns null and creates no commit when nothing changed", async () => {
    const h = await makeHarness();
    const first = await initRepo(h);

    expect(await h.safeGit.commitLocal("sync")).toBeNull();
    const head = await git.resolveRef({ fs: h.fs, dir: h.dir, ref: "HEAD" });
    expect(head).toBe(first);
  });

  it("never stages an excluded file", async () => {
    const h = await makeHarness();
    await initRepo(h);
    await h.write(".obsidian/app.json", "{}");
    await h.write("notes/a.md", "changed\n");
    await h.safeGit.commitLocal("sync");

    const files = await git.listFiles({ fs: h.fs, dir: h.dir, ref: "HEAD" });
    expect(files).not.toContain(".obsidian/app.json");
    expect(files).toContain("notes/a.md");
  });

  it("does not create a commit when only excluded files changed", async () => {
    const h = await makeHarness();
    const first = await initRepo(h);
    await h.write(".obsidian/app.json", "{}");

    expect(await h.safeGit.commitLocal("sync")).toBeNull();
    const head = await git.resolveRef({ fs: h.fs, dir: h.dir, ref: "HEAD" });
    expect(head).toBe(first);
  });

  it("keeps an excluded file tracked in HEAD rather than committing its removal", async () => {
    const h = await makeHarness();
    await git.init({ fs: h.fs, dir: h.dir, defaultBranch: "main" });
    await h.write("notes/a.md", "a\n");
    await h.write(".obsidian/app.json", "{}");
    await h.commit(["notes/a.md", ".obsidian/app.json"], "tracks config");
    await h.adapter.remove(".obsidian/app.json");
    await h.write("notes/a.md", "changed\n");

    await h.safeGit.commitLocal("sync");

    const files = await git.listFiles({ fs: h.fs, dir: h.dir, ref: "HEAD" });
    expect(files).toContain(".obsidian/app.json");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/git/safe-git-commit.test.ts`
Expected: FAIL — `commitLocal is not a function`.

- [ ] **Step 3: Add `commitLocal` to `src/git/safe-git.ts`**

Insert these methods inside the `SafeGit` class, before the closing brace:

```ts
  /**
   * Stages every changed non-excluded path and commits, but only when the
   * staged tree actually differs from HEAD. Committing unconditionally would
   * create empty commits that push local ahead of remote for no reason.
   *
   * Returns the new commit oid, or null when there was nothing to commit.
   */
  async commitLocal(message: string): Promise<string | null> {
    const matrix = await this.scanWorkingTree();

    let staged = 0;
    for (const [filepath, head, workdir] of matrix) {
      if (this.exclude.isExcluded(filepath)) continue;
      if (head === 1 && workdir === 1) continue;

      if (workdir === 0) {
        // Belt and braces on top of scanWorkingTree's guard: confirm the file really is
        // gone before staging its removal. A `workdir === 0` that came from a swallowed
        // directory-read failure would otherwise commit a deletion of a file that exists.
        if (await this.stillOnDisk(filepath)) {
          throw new Error(
            `${filepath} is reported as deleted but is still present. Refusing to ` +
              `commit a deletion that may be a read failure. Nothing was changed.`,
          );
        }
        await git.remove({ ...this.base(), filepath });
        staged += 1;
      } else {
        await git.add({ ...this.base(), filepath });
        staged += 1;
      }
    }

    if (staged === 0) {
      this.log("commit: nothing to commit");
      return null;
    }

    const oid = await git.commit({
      ...this.base(),
      message,
      author: this.author(),
    });
    this.log(`commit: created ${oid.slice(0, 7)} (${staged} path(s))`);
    return oid;
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/git/safe-git-commit.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/git/safe-git.ts tests/git/safe-git-commit.test.ts
git commit -m "feat: commit local changes, skipping excluded paths and empty commits"
```

---

## Task 9: SafeGit — safe merge

The heart of the plugin. Every branch of this method must be non-destructive.

**Files:**
- Modify: `src/git/safe-git.ts`
- Test: `tests/git/safe-git-merge.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/git/safe-git-merge.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import git from "isomorphic-git";
import { makeHarness, initRepo, setOriginRef, type Harness } from "../helpers/repo";
import { COMMIT_AUTHOR } from "../../src/constants";

/**
 * Build a second lineage to act as the remote, then restore local HEAD.
 *
 * Test scaffolding only — it uses force checkout to move between lineages,
 * which product code must never do.
 */
async function divergeRemote(
  h: Harness,
  base: string,
  changes: Record<string, string>,
  message: string,
  /** Extra staging for cases text changes cannot express, e.g. binary writes. */
  extra?: () => Promise<void>,
): Promise<string> {
  const localHead = await git.resolveRef({ fs: h.fs, dir: h.dir, ref: "refs/heads/main" });

  await git.writeRef({ fs: h.fs, dir: h.dir, ref: "refs/heads/main", value: base, force: true });
  await git.checkout({ fs: h.fs, dir: h.dir, ref: "main", force: true });
  for (const [p, c] of Object.entries(changes)) await h.write(p, c);
  for (const p of Object.keys(changes)) await git.add({ fs: h.fs, dir: h.dir, filepath: p });
  if (extra) await extra();
  const remoteOid = await git.commit({ fs: h.fs, dir: h.dir, message, author: COMMIT_AUTHOR });

  await git.writeRef({ fs: h.fs, dir: h.dir, ref: "refs/heads/main", value: localHead, force: true });
  await git.checkout({ fs: h.fs, dir: h.dir, ref: "main", force: true });
  await setOriginRef(h, remoteOid);
  return remoteOid;
}

describe("SafeGit.mergeSafe", () => {
  it("reports up-to-date when local and remote match", async () => {
    const h = await makeHarness();
    const first = await initRepo(h);
    await setOriginRef(h, first);
    expect((await h.safeGit.mergeSafe()).kind).toBe("up-to-date");
  });

  it("reports up-to-date when there is no remote ref yet", async () => {
    const h = await makeHarness();
    await initRepo(h);
    expect((await h.safeGit.mergeSafe()).kind).toBe("up-to-date");
  });

  it("fast-forwards when local is strictly behind", async () => {
    const h = await makeHarness();
    const first = await initRepo(h);
    const remoteOid = await divergeRemote(h, first, { "notes/remote.md": "r\n" }, "remote work");
    // Local is still at `first`, so this is a pure fast-forward.
    await git.writeRef({ fs: h.fs, dir: h.dir, ref: "refs/heads/main", value: first, force: true });

    const out = await h.safeGit.mergeSafe();
    expect(out.kind).toBe("fast-forward");
    const head = await git.resolveRef({ fs: h.fs, dir: h.dir, ref: "HEAD" });
    expect(head).toBe(remoteOid);
    expect(await h.adapter.read("notes/remote.md")).toBe("r\n");
  });

  it("does not write excluded paths during a fast-forward", async () => {
    const h = await makeHarness();
    const first = await initRepo(h);
    await divergeRemote(h, first, { ".obsidian/app.json": "{\"remote\":true}" }, "remote config");
    await git.writeRef({ fs: h.fs, dir: h.dir, ref: "refs/heads/main", value: first, force: true });

    // The setup wrote this file to disk in order to commit it on the remote
    // lineage. Clear it so the assertion below genuinely proves mergeSafe did
    // not materialise it, rather than passing on a leftover from setup.
    if (h.adapter.paths().includes(".obsidian/app.json")) {
      await h.adapter.remove(".obsidian/app.json");
    }

    const out = await h.safeGit.mergeSafe();
    expect(out.kind).toBe("fast-forward");
    expect(h.adapter.paths()).not.toContain(".obsidian/app.json");
    // The remote still tracks it, so it must remain in history.
    const tracked = await git.listFiles({ fs: h.fs, dir: h.dir, ref: "HEAD" });
    expect(tracked).toContain(".obsidian/app.json");
  });

  it("creates a merge commit when both sides changed different files", async () => {
    const h = await makeHarness();
    const first = await initRepo(h);
    await h.write("notes/local.md", "l\n");
    await h.commit(["notes/local.md"], "local work");
    await divergeRemote(h, first, { "notes/remote.md": "r\n" }, "remote work");

    const out = await h.safeGit.mergeSafe();
    expect(out.kind).toBe("merged");
    expect(await h.adapter.read("notes/local.md")).toBe("l\n");
    expect(await h.adapter.read("notes/remote.md")).toBe("r\n");
  });

  it("reports a conflict and leaves the working tree untouched when both sides changed the same file", async () => {
    const h = await makeHarness();
    const first = await initRepo(h);
    await h.write("notes/a.md", "local version\n");
    const localOid = await h.commit(["notes/a.md"], "local edit");
    await divergeRemote(h, first, { "notes/a.md": "remote version\n" }, "remote edit");

    const before = await h.adapter.read("notes/a.md");
    const out = await h.safeGit.mergeSafe();

    expect(out.kind).toBe("conflict");
    if (out.kind === "conflict") {
      expect(out.files.map((f) => f.path)).toContain("notes/a.md");
    }
    // Nothing written, no conflict markers, HEAD unmoved.
    expect(await h.adapter.read("notes/a.md")).toBe(before);
    expect(await h.adapter.read("notes/a.md")).not.toContain("<<<<<<<");
    expect(await git.resolveRef({ fs: h.fs, dir: h.dir, ref: "HEAD" })).toBe(localOid);
  });

  it("surfaces both sides' content in the conflict report", async () => {
    const h = await makeHarness();
    const first = await initRepo(h);
    await h.write("notes/a.md", "local version\n");
    await h.commit(["notes/a.md"], "local edit");
    await divergeRemote(h, first, { "notes/a.md": "remote version\n" }, "remote edit");

    const out = await h.safeGit.mergeSafe();
    if (out.kind !== "conflict") throw new Error("expected conflict");
    const f = out.files.find((x) => x.path === "notes/a.md")!;
    expect(f.ours).toEqual({ state: "text", content: "local version\n" });
    expect(f.theirs).toEqual({ state: "text", content: "remote version\n" });
  });

  /**
   * The test that pins the binary pre-screen.
   *
   * The attachment exists at the merge base and is edited in two well-separated
   * regions, so isomorphic-git's three-way merge finds them separable and reports a
   * CLEAN merge — corrupting the file silently and never asking. Deleting the
   * pre-screen makes this test fail; the add/add cases below still pass without it,
   * because there the engine raises a conflict on its own.
   */
  it("refuses to let the engine merge a binary changed on both sides", async () => {
    const h = await makeHarness();

    // Newline-separated so diff3 sees distinct regions, with invalid UTF-8 in each.
    const row = (n: number) => [0x89, 0xff, 0xfe, n, 0x0a];
    const baseBytes = new Uint8Array(
      Array.from({ length: 40 }, (_, i) => row(i)).flat(),
    );
    await git.init({ fs: h.fs, dir: h.dir, defaultBranch: "main" });
    await h.write("notes/a.md", "first\n");
    await h.adapter.writeBinary("img.png", baseBytes.slice().buffer);
    const base = await h.commit(["notes/a.md", "img.png"], "base with attachment");

    const ourBytes = baseBytes.slice();
    ourBytes[3] = 0x01; // edit near the start
    await h.adapter.writeBinary("img.png", ourBytes.slice().buffer);
    const localOid = await h.commit(["img.png"], "local edits the attachment");

    const theirBytes = baseBytes.slice();
    theirBytes[baseBytes.length - 2] = 0x02; // edit near the end
    await divergeRemote(h, base, {}, "remote edits the attachment", async () => {
      await h.adapter.writeBinary("img.png", theirBytes.slice().buffer);
      await git.add({ fs: h.fs, dir: h.dir, filepath: "img.png" });
    });

    const out = await h.safeGit.mergeSafe();

    // Without the pre-screen this is `merged`, with a corrupted blob committed.
    expect(out.kind).toBe("conflict");
    expect(await git.resolveRef({ fs: h.fs, dir: h.dir, ref: "HEAD" })).toBe(localOid);
    const onDisk = new Uint8Array(await h.adapter.readBinary("img.png"));
    expect(Array.from(onDisk)).toEqual(Array.from(ourBytes));
  });

  // A conflicting attachment must survive resolution byte-for-byte. Carrying it
  // as a string would replace every invalid UTF-8 byte with U+FFFD and commit the
  // damage, which is the failure this plugin exists to prevent.
  it("reports a conflicting binary file as bytes, not as text", async () => {
    const h = await makeHarness();
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe]);
    const first = await initRepo(h);
    await h.adapter.writeBinary("img.png", png.slice().buffer);
    await h.commit(["img.png"], "local binary");

    const other = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
    await divergeRemote(h, first, {}, "remote binary", async () => {
      await h.adapter.writeBinary("img.png", other.slice().buffer);
      await git.add({ fs: h.fs, dir: h.dir, filepath: "img.png" });
    });

    const out = await h.safeGit.mergeSafe();
    if (out.kind !== "conflict") throw new Error("expected conflict");
    const f = out.files.find((x) => x.path === "img.png")!;
    expect(f.ours.state).toBe("binary");
    expect(f.theirs.state).toBe("binary");
    if (f.ours.state === "binary") expect(Array.from(f.ours.bytes)).toEqual(Array.from(png));
  });

  it("treats unrelated histories as a conflict rather than crashing", async () => {
    const h = await makeHarness();
    await initRepo(h);
    // An orphan commit with no shared ancestry.
    const tree = await git.writeTree({ fs: h.fs, dir: h.dir, tree: [] });
    const orphan = await git.writeCommit({
      fs: h.fs,
      dir: h.dir,
      commit: {
        tree,
        parent: [],
        message: "unrelated root\n",
        author: { ...COMMIT_AUTHOR, timestamp: 1, timezoneOffset: 0 },
        committer: { ...COMMIT_AUTHOR, timestamp: 1, timezoneOffset: 0 },
      },
    });
    await setOriginRef(h, orphan);

    const out = await h.safeGit.mergeSafe();
    expect(out.kind).toBe("unmergeable");
    if (out.kind === "unmergeable") expect(out.reason).toBe("unrelated-histories");
  });

  it("does not report a conflict for changes confined to excluded paths", async () => {
    const h = await makeHarness();
    const first = await initRepo(h);
    await h.write(".obsidian/app.json", "{\"local\":true}");
    await h.commit(["notes/a.md"], "local touch");
    await divergeRemote(h, first, { ".obsidian/app.json": "{\"remote\":true}" }, "remote config");

    const out = await h.safeGit.mergeSafe();
    expect(out.kind).not.toBe("conflict");
  });
});

// Invariant 8: iOS can suspend or kill the app mid-operation, so re-running
// from any state must be safe. These prove repeatability rather than a one-shot
// happy path.
describe("SafeGit idempotency", () => {
  it("is a no-op when mergeSafe runs twice after a fast-forward", async () => {
    const h = await makeHarness();
    const first = await initRepo(h);
    const remoteOid = await divergeRemote(h, first, { "notes/remote.md": "r\n" }, "remote work");
    await git.writeRef({ fs: h.fs, dir: h.dir, ref: "refs/heads/main", value: first, force: true });

    expect((await h.safeGit.mergeSafe()).kind).toBe("fast-forward");
    expect((await h.safeGit.mergeSafe()).kind).toBe("up-to-date");
    expect(await git.resolveRef({ fs: h.fs, dir: h.dir, ref: "HEAD" })).toBe(remoteOid);
  });

  it("reports the same conflict on a repeated mergeSafe without writing anything", async () => {
    const h = await makeHarness();
    const first = await initRepo(h);
    await h.write("notes/a.md", "local version\n");
    const localOid = await h.commit(["notes/a.md"], "local edit");
    await divergeRemote(h, first, { "notes/a.md": "remote version\n" }, "remote edit");

    const one = await h.safeGit.mergeSafe();
    const two = await h.safeGit.mergeSafe();

    expect(one.kind).toBe("conflict");
    expect(two.kind).toBe("conflict");
    expect(await h.adapter.read("notes/a.md")).toBe("local version\n");
    expect(await git.resolveRef({ fs: h.fs, dir: h.dir, ref: "HEAD" })).toBe(localOid);
  });

  it("creates no second commit when commitLocal runs twice", async () => {
    const h = await makeHarness();
    await initRepo(h);
    await h.write("notes/a.md", "changed\n");

    const firstOid = await h.safeGit.commitLocal("sync");
    expect(firstOid).not.toBeNull();
    expect(await h.safeGit.commitLocal("sync")).toBeNull();

    expect(await git.resolveRef({ fs: h.fs, dir: h.dir, ref: "HEAD" })).toBe(firstOid);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/git/safe-git-merge.test.ts`
Expected: FAIL — `mergeSafe is not a function`.

- [ ] **Step 3: Add merge support to `src/git/safe-git.ts`**

Widen the existing type import at the top of the file (Task 7 already imports
`ConflictFile` and `RepoStatus`):

```ts
import type { ConflictFile, ConflictSide, MergeOutcome, RepoStatus } from "../types";
```

Add these methods inside the `SafeGit` class:

```ts
  /**
   * Integrates the fetched remote into the local branch without ever
   * overwriting unsaved work.
   *
   * Order of decisions:
   *  1. No remote ref, or identical oids  -> nothing to do.
   *  2. Zero or multiple merge bases      -> surfaced as a conflict, because
   *     isomorphic-git cannot merge these (no recursive strategy).
   *  3. Local is an ancestor of remote    -> fast-forward, checking out only
   *     non-excluded paths and never with force.
   *  4. Diverged                          -> dry-run probe first. A conflict
   *     means we write nothing at all; a clean probe means we merge for real.
   */
  async mergeSafe(): Promise<MergeOutcome> {
    const local = await this.tryResolve(`refs/heads/${this.branch}`);
    const remote = await this.tryResolve(`refs/remotes/origin/${this.branch}`);

    if (!remote || !local) {
      this.log("merge: no remote ref yet, nothing to merge");
      return { kind: "up-to-date" };
    }
    if (local === remote) {
      this.log("merge: already up to date");
      return { kind: "up-to-date" };
    }

    let bases: string[];
    try {
      bases = await git.findMergeBase({ ...this.base(), oids: [local, remote] });
    } catch {
      bases = [];
    }

    if (bases.length === 0) {
      this.log("merge: no common ancestor — refusing to merge unrelated histories");
      return { kind: "unmergeable", reason: "unrelated-histories" };
    }
    if (bases.length > 1) {
      this.log("merge: multiple merge bases — unsupported by the engine, stopping safely");
      return { kind: "unmergeable", reason: "multiple-merge-bases" };
    }

    if (bases[0] === local) {
      const oid = await this.fastForwardTo(remote);
      return { kind: "fast-forward", oid };
    }

    // Diverged.
    //
    // Before letting the engine merge, check whether any file changed on both
    // sides is binary. isomorphic-git's merge decodes both sides with a non-fatal
    // UTF-8 conversion and re-encodes the result, so it would corrupt a binary and
    // — because the three-way algorithm usually finds separable regions in a large
    // file — report a CLEAN merge, never asking the user. Any binary in the set
    // means we resolve whole-file instead.
    //
    // When a binary is present we surface *every* both-sides change, not only the
    // binary ones. Conflicting on the binary alone would leave the text files that
    // also changed on both sides to be swept in as "theirs", silently discarding
    // this device's edits to them.
    const bothChanged = await this.diffBothSides(local, remote, bases[0]);
    if (await this.anyBinary(bothChanged, [bases[0], local, remote])) {
      // describePaths drops excluded paths from what the user is asked about; the
      // gate above already considered them, which is why the engine is skipped.
      const files = await this.describePaths(bothChanged, local, remote);
      this.pending = { ourHead: local, theirHead: remote, files };
      this.log(`merge: ${files.length} path(s) include binary content — resolving whole-file`);
      return { kind: "conflict", files };
    }

    // No binaries involved, so the engine's text merge is safe: valid UTF-8
    // survives its decode/re-encode round trip losslessly, and diff3 can combine
    // non-overlapping edits to the same note instead of forcing a choice.
    try {
      await git.merge({
        ...this.base(),
        ours: this.branch,
        theirs: `refs/remotes/origin/${this.branch}`,
        fastForward: false,
        abortOnConflict: true,
        dryRun: true,
        author: this.author(),
      });
    } catch (err) {
      const conflicts = await this.describeConflicts(err, local, remote, bases[0]);
      if (conflicts.length === 0) throw err;
      this.log(`merge: conflict in ${conflicts.length} file(s) — nothing written`);
      return { kind: "conflict", files: conflicts };
    }

    // Probe was clean, so this cannot conflict.
    const result = await git.merge({
      ...this.base(),
      ours: this.branch,
      theirs: `refs/remotes/origin/${this.branch}`,
      fastForward: false,
      abortOnConflict: true,
      dryRun: false,
      author: this.author(),
    });
    const merged = result.oid ?? (await git.resolveRef({ ...this.base(), ref: "HEAD" }));
    await this.checkoutTracked(merged);
    this.log(`merge: merged as ${merged.slice(0, 7)}`);
    return { kind: "merged", oid: merged };
  }

  /**
   * Moves the branch to `oid` and materialises only non-excluded paths.
   * `force` is deliberately absent: any path that would clobber an untracked
   * working-tree file is left alone rather than overwritten.
   */
  private async fastForwardTo(oid: string): Promise<string> {
    await git.writeRef({
      ...this.base(),
      ref: `refs/heads/${this.branch}`,
      value: oid,
      force: true,
    });
    await this.checkoutTracked(oid);
    this.log(`merge: fast-forwarded to ${oid.slice(0, 7)}`);
    return oid;
  }

  /** Checks out the non-excluded files of a commit. Never forces. */
  private async checkoutTracked(oid: string): Promise<void> {
    const tracked = await git.listFiles({ ...this.base(), ref: oid });
    const wanted = this.exclude.withoutExcluded(tracked);
    if (wanted.length === 0) return;
    await git.checkout({
      ...this.base(),
      ref: this.branch,
      filepaths: wanted,
      force: false,
    });
  }

  /**
   * Turns a merge failure into per-file conflict records carrying both sides'
   * content, filtering out any path the user excluded.
   */
  private async describeConflicts(
    err: unknown,
    local: string,
    remote: string,
    base: string,
  ): Promise<ConflictFile[]> {
    const name = (err as { code?: string; name?: string })?.code ?? (err as Error)?.name;
    if (name !== "MergeConflictError") return [];

    const reported =
      (err as { data?: { filepaths?: string[] } })?.data?.filepaths ??
      (await this.diffBothSides(local, remote, base));

    return this.describePaths(reported, local, remote);
  }

  /** Builds conflict records for the given paths, dropping excluded ones. */
  private async describePaths(
    paths: string[],
    local: string,
    remote: string,
  ): Promise<ConflictFile[]> {
    const out: ConflictFile[] = [];
    for (const path of this.exclude.withoutExcluded(paths)) {
      out.push({
        path,
        ours: await this.readAtCommit(local, path),
        theirs: await this.readAtCommit(remote, path),
      });
    }
    return out;
  }

  /**
   * True when any of the given paths is binary in any of the given commits.
   *
   * Binary-ness is decided by whether the bytes survive a strict UTF-8 decode —
   * the same test `readAtCommit` uses — not by file extension, which would miss an
   * unlabelled attachment.
   *
   * Deliberately does NOT skip excluded paths. This is a safety gate, not a list of
   * things to materialise. An excluded path can still be tracked by the remote, and
   * the engine merges the whole tree regardless of what we check out, so filtering
   * here would let it corrupt an excluded binary inside the commit and push it.
   * "Don't sync this" must not become "corrupt this silently".
   */
  private async anyBinary(paths: string[], oids: string[]): Promise<boolean> {
    for (const path of paths) {
      for (const oid of oids) {
        const side = await this.readAtCommit(oid, path);
        if (side.state === "binary") return true;
      }
    }
    return false;
  }

  /**
   * Per-path blob oids in the merge base, ours, and theirs, in one tree walk.
   *
   * Compares oids, never content: content comparison would have to decode first,
   * and two different binaries can decode to the same string of replacement
   * characters, hiding a real conflict.
   *
   * A single `git.walk` is used rather than per-path `readBlob` calls because
   * `readBlob` inflates the whole blob just to learn its oid. On a vault of a few
   * thousand notes that difference is roughly 16 seconds versus 30 milliseconds,
   * and inflating every attachment three times risks being killed for memory on a
   * phone. `entry.oid()` reads the tree entry only.
   */
  private async threeWayOids(
    base: string,
    local: string,
    remote: string,
  ): Promise<ThreeWayRow[]> {
    const rows: ThreeWayRow[] = [];
    await git.walk({
      ...this.base(),
      trees: [TREE({ ref: base }), TREE({ ref: local }), TREE({ ref: remote })],
      map: async (filepath, entries) => {
        if (filepath === ".") return undefined;
        const types = await Promise.all(entries.map((e) => (e ? e.type() : null)));
        const anyTree = types.some((t) => t === "tree");
        const anyBlob = types.some((t) => t === "blob");

        // A path that is a directory on every side is just a directory: let the walk
        // descend and compare its leaves.
        if (anyTree && !anyBlob) return undefined;

        // A path that is a file on one side and a directory on another is a type
        // change. Record it with a null oid for the directory sides so it is treated
        // as changed rather than silently dropped -- skipping it would lose the
        // change without telling anyone.
        const oids = await Promise.all(
          entries.map(async (e, i) => (e && types[i] === "blob" ? e.oid() : null)),
        );
        const [baseOid, oursOid, theirsOid] = oids;
        rows.push({ path: filepath, baseOid, oursOid, theirsOid });
        // Still descend if some side is a directory, so its contents are compared too.
        return undefined;
      },
    });
    return rows;
  }

  /** Paths that changed on both sides, and differently, since the merge base. */
  private async diffBothSides(
    local: string,
    remote: string,
    base: string,
  ): Promise<string[]> {
    const rows = await this.threeWayOids(base, local, remote);
    return rows
      .filter(
        (r) =>
          r.oursOid !== r.baseOid && r.theirsOid !== r.baseOid && r.oursOid !== r.theirsOid,
      )
      .map((r) => r.path);
  }

  /**
   * One side's version of a file at a commit.
   *
   * Keeps the raw bytes and only decodes when the content is valid UTF-8, using a
   * fatal decoder. A non-fatal decode would replace every invalid byte with U+FFFD,
   * and writing that back during resolution would corrupt the attachment.
   *
   * A read failure is reported as `unreadable`, never as `absent`: resolution
   * deletes and commits on `absent`, so conflating the two would turn a torn
   * packfile or an out-of-memory into a durable deletion of a file that exists.
   */
  private async readAtCommit(oid: string, filepath: string): Promise<ConflictSide> {
    let bytes: Uint8Array;
    try {
      const { blob } = await git.readBlob({ ...this.base(), oid, filepath });
      bytes = blob;
    } catch (err) {
      if (isPathAbsent(err, oid)) return { state: "absent" };
      return { state: "unreadable", error: message(err) };
    }
    try {
      return { state: "text", content: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
    } catch {
      return { state: "binary", bytes };
    }
  }
```

Add these module-private helpers at the bottom of the file, outside the class:

```ts
/**
 * True when a git read failed because the path is genuinely absent from that tree,
 * as opposed to an object being unreadable.
 *
 * isomorphic-git raises `NotFoundError` for both, so the code alone cannot decide.
 * The distinction is in `data.what`: for a missing path it is a human-readable
 * string like `file or directory found at "<oid>:<path>"`, whereas for a missing
 * object it is the bare oid. Testing that shape is the reliable discriminator.
 *
 * Comparing `data.what` against the commit oid does NOT work, even though the
 * library does something similar elsewhere for a missing commit: `resolveFilepath`
 * reassigns the oid to the blob's own oid before reading the object, so a torn
 * packfile reports the blob oid, which never equals the commit oid passed in. That
 * mistake classified a damaged object as `absent`, and resolution acts on `absent`
 * by deleting and committing — turning corruption into deliberate-looking deletion.
 *
 * ENOENT is deliberately not treated as absent: that is a filesystem condition, and
 * the fs bridge keeps it distinct precisely so a read failure cannot read as a
 * deletion.
 */
const OID = /^[0-9a-f]{40}$/;

function isPathAbsent(err: unknown, oid: string): boolean {
  const e = err as { code?: string; data?: { what?: string } };
  if (e?.code !== "NotFoundError") return false;
  // Only trustworthy for a full oid. An abbreviated oid or a ref name such as
  // "main" is not expanded before the object read, so it reports itself in
  // `data.what` and would look like a missing path. Answering false in that case
  // routes to `unreadable`, which refuses rather than deletes.
  if (!OID.test(oid)) return false;
  return !OID.test(e.data?.what ?? "");
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/git/safe-git-merge.test.ts`
Expected: PASS, 15 tests. The pre-screen test, the "working tree untouched" assertions, and
the idempotency block are the critical ones.

- [ ] **Step 5: Commit**

```bash
git add src/git/safe-git.ts tests/git/safe-git-merge.test.ts
git commit -m "feat: safe merge with dry-run probe and non-destructive conflict reporting"
```

---

## Task 10: SafeGit — whole-file conflict resolution

Phase-1 resolution: per file, keep mine or keep theirs. Non-destructive because the losing
side already exists in history.

**Files:**
- Modify: `src/git/safe-git.ts`
- Test: `tests/git/safe-git-resolve.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/git/safe-git-resolve.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import git from "isomorphic-git";
import { makeHarness, initRepo, setOriginRef, type Harness } from "../helpers/repo";
import { COMMIT_AUTHOR } from "../../src/constants";

async function conflicted(h: Harness) {
  const first = await initRepo(h);
  await h.write("notes/a.md", "local version\n");
  await h.commit(["notes/a.md"], "local edit");

  await git.writeRef({ fs: h.fs, dir: h.dir, ref: "refs/heads/tmp", value: first, force: true });
  const localHead = await git.resolveRef({ fs: h.fs, dir: h.dir, ref: "refs/heads/main" });
  await git.writeRef({ fs: h.fs, dir: h.dir, ref: "refs/heads/main", value: first, force: true });
  await git.checkout({ fs: h.fs, dir: h.dir, ref: "main", force: true });
  await h.write("notes/a.md", "remote version\n");
  await git.add({ fs: h.fs, dir: h.dir, filepath: "notes/a.md" });
  const remoteOid = await git.commit({ fs: h.fs, dir: h.dir, message: "remote edit", author: COMMIT_AUTHOR });
  await git.writeRef({ fs: h.fs, dir: h.dir, ref: "refs/heads/main", value: localHead, force: true });
  await git.checkout({ fs: h.fs, dir: h.dir, ref: "main", force: true });
  await setOriginRef(h, remoteOid);

  const out = await h.safeGit.mergeSafe();
  if (out.kind !== "conflict") throw new Error("expected a conflict");
  return { localHead, remoteOid };
}

describe("SafeGit.resolveConflicts", () => {
  it("keeps the local version and records a merge commit with both parents", async () => {
    const h = await makeHarness();
    const { localHead, remoteOid } = await conflicted(h);

    const oid = await h.safeGit.resolveConflicts([{ path: "notes/a.md", choice: "mine" }]);

    expect(await h.adapter.read("notes/a.md")).toBe("local version\n");
    const commit = await git.readCommit({ fs: h.fs, dir: h.dir, oid });
    expect(commit.commit.parent).toEqual([localHead, remoteOid]);
  });

  it("keeps the remote version when asked", async () => {
    const h = await makeHarness();
    await conflicted(h);
    await h.safeGit.resolveConflicts([{ path: "notes/a.md", choice: "theirs" }]);
    expect(await h.adapter.read("notes/a.md")).toBe("remote version\n");
  });

  it("preserves the losing version in history", async () => {
    const h = await makeHarness();
    const { localHead } = await conflicted(h);
    await h.safeGit.resolveConflicts([{ path: "notes/a.md", choice: "theirs" }]);

    const { blob } = await git.readBlob({
      fs: h.fs,
      dir: h.dir,
      oid: localHead,
      filepath: "notes/a.md",
    });
    expect(new TextDecoder().decode(blob)).toBe("local version\n");
  });

  it("writes no conflict markers into the file", async () => {
    const h = await makeHarness();
    await conflicted(h);
    await h.safeGit.resolveConflicts([{ path: "notes/a.md", choice: "mine" }]);
    const text = await h.adapter.read("notes/a.md");
    expect(text).not.toContain("<<<<<<<");
    expect(text).not.toContain(">>>>>>>");
  });

  it("deletes the file when the chosen side had deleted it", async () => {
    const h = await makeHarness();
    const first = await initRepo(h);
    await h.adapter.remove("notes/a.md");
    await h.safeGit.commitLocal("local delete");
    const localHead = await git.resolveRef({ fs: h.fs, dir: h.dir, ref: "refs/heads/main" });

    await git.writeRef({ fs: h.fs, dir: h.dir, ref: "refs/heads/main", value: first, force: true });
    await git.checkout({ fs: h.fs, dir: h.dir, ref: "main", force: true });
    await h.write("notes/a.md", "remote edit\n");
    await git.add({ fs: h.fs, dir: h.dir, filepath: "notes/a.md" });
    const remoteOid = await git.commit({ fs: h.fs, dir: h.dir, message: "remote edit", author: COMMIT_AUTHOR });
    await git.writeRef({ fs: h.fs, dir: h.dir, ref: "refs/heads/main", value: localHead, force: true });
    await setOriginRef(h, remoteOid);

    await h.safeGit.resolveConflicts([{ path: "notes/a.md", choice: "mine" }]);
    expect(h.adapter.paths()).not.toContain("notes/a.md");
  });

  // The reason ConflictSide carries bytes at all. If someone reintroduced a
  // decode/encode round trip inside materialise, this is what would catch it.
  it("writes a chosen binary version back byte-for-byte", async () => {
    const h = await makeHarness();
    const ourPng = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe, 0x00, 0x01]);
    const theirPng = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xfe, 0xff, 0x02, 0x03]);

    const first = await initRepo(h);
    await h.adapter.writeBinary("img.png", ourPng.slice().buffer);
    await h.commit(["img.png"], "local binary");
    const localHead = await git.resolveRef({ fs: h.fs, dir: h.dir, ref: "refs/heads/main" });

    await git.writeRef({ fs: h.fs, dir: h.dir, ref: "refs/heads/main", value: first, force: true });
    await git.checkout({ fs: h.fs, dir: h.dir, ref: "main", force: true });
    await h.adapter.writeBinary("img.png", theirPng.slice().buffer);
    await git.add({ fs: h.fs, dir: h.dir, filepath: "img.png" });
    const remoteOid = await git.commit({
      fs: h.fs,
      dir: h.dir,
      message: "remote binary",
      author: COMMIT_AUTHOR,
    });
    await git.writeRef({ fs: h.fs, dir: h.dir, ref: "refs/heads/main", value: localHead, force: true });
    await git.checkout({ fs: h.fs, dir: h.dir, ref: "main", force: true });
    await setOriginRef(h, remoteOid);

    const out = await h.safeGit.mergeSafe();
    expect(out.kind).toBe("conflict");

    await h.safeGit.resolveConflicts([{ path: "img.png", choice: "theirs" }]);

    const onDisk = new Uint8Array(await h.adapter.readBinary("img.png"));
    expect(Array.from(onDisk)).toEqual(Array.from(theirPng));
    expect(Array.from(onDisk)).not.toContain(0xef); // no U+FFFD bytes
  });

  /**
   * Two conflicting files, the second unreadable. With writes decided up front the
   * first file is untouched; screening as we went would already have written and
   * staged it before refusing, making the "Nothing was changed" message a lie.
   */
  it("refuses without writing anything when a later chosen side is unreadable", async () => {
    const h = await makeHarness();
    const first = await initRepo(h);
    await h.write("notes/a.md", "local a\n");
    await h.write("notes/b.md", "local b\n");
    const localOid = await h.commit(["notes/a.md", "notes/b.md"], "local edits both");
    await divergeRemote(
      h,
      first,
      { "notes/a.md": "remote a\n", "notes/b.md": "remote b\n" },
      "remote edits both",
    );

    const out = await h.safeGit.mergeSafe();
    if (out.kind !== "conflict") throw new Error("expected a conflict");
    expect(out.files.length).toBe(2);

    // Damage whichever file the resolver would reach second.
    const pending = (h.safeGit as unknown as {
      pending: { files: Array<{ path: string; theirs: unknown }> };
    }).pending;
    const damaged = pending.files[1].path;
    pending.files[1].theirs = { state: "unreadable", error: "simulated damage" };
    const intact = pending.files[0].path;
    const before = await h.adapter.read(intact);

    await expect(
      h.safeGit.resolveConflicts(
        pending.files.map((f) => ({ path: f.path, choice: "theirs" as const })),
      ),
    ).rejects.toThrow(/could not be read/i);

    expect(damaged).not.toBe(intact);
    expect(await h.adapter.read(intact)).toBe(before);
    expect(await git.resolveRef({ fs: h.fs, dir: h.dir, ref: "HEAD" })).toBe(localOid);
  });

  it("throws when there is no pending conflict", async () => {
    const h = await makeHarness();
    await initRepo(h);
    await expect(
      h.safeGit.resolveConflicts([{ path: "notes/a.md", choice: "mine" }]),
    ).rejects.toThrow(/no pending conflict/i);
  });

  it("throws when a resolution is missing for a conflicting path", async () => {
    const h = await makeHarness();
    await conflicted(h);
    await expect(h.safeGit.resolveConflicts([])).rejects.toThrow(/unresolved/i);
  });

  it("leaves the repo unchanged after abandoning a conflict", async () => {
    const h = await makeHarness();
    const { localHead } = await conflicted(h);
    h.safeGit.abandonConflict();

    expect(await git.resolveRef({ fs: h.fs, dir: h.dir, ref: "HEAD" })).toBe(localHead);
    expect(await h.adapter.read("notes/a.md")).toBe("local version\n");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/git/safe-git-resolve.test.ts`
Expected: FAIL — `resolveConflicts is not a function`.

- [ ] **Step 3: Add resolution support to `src/git/safe-git.ts`**

Add this interface near the top of the file, after the imports:

```ts
export interface ConflictResolution {
  path: string;
  choice: "mine" | "theirs";
}
```

`PendingConflict` and the `pending` field are already declared in Task 7, alongside the
other class fields; `mergeSafe` (Task 9) is what sets them.

In `mergeSafe`, record the pending conflict. Replace the `return { kind: "conflict", files: conflicts };` line with:

```ts
      this.pending = { ourHead: local, theirHead: remote, files: conflicts };
      return { kind: "conflict", files: conflicts };
```

Then add these methods to the class:

```ts
  /**
   * Discards the pending conflict without touching the repo, so the next sync
   * offers it again. The working tree was never modified, so there is nothing
   * to roll back.
   */
  abandonConflict(): void {
    this.pending = null;
    this.log("merge: conflict abandoned, repo unchanged");
  }

  /**
   * Applies a whole-file decision per conflicting path and records a real merge
   * commit with both parents.
   *
   * This is non-destructive: the losing content is already reachable from the
   * parent commits, so nothing is lost — only postponed.
   */
  async resolveConflicts(resolutions: ConflictResolution[]): Promise<string> {
    const pending = this.pending;
    if (!pending) throw new Error("no pending conflict to resolve");

    const byPath = new Map(resolutions.map((r) => [r.path, r.choice]));

    // A file neither side can supply is undecidable, not unresolved: refusing to
    // finish would leave the user permanently stuck with no way out on a phone.
    const decidable = pending.files.filter(
      (f) => !(f.ours.state === "unreadable" && f.theirs.state === "unreadable"),
    );
    const missing = decidable.filter((f) => !byPath.has(f.path)).map((f) => f.path);
    if (missing.length > 0) {
      throw new Error(`unresolved conflict(s): ${missing.join(", ")}`);
    }

    // Decide the complete set of writes BEFORE performing any of them.
    //
    // Everything that could fail is resolved first, so a refusal genuinely leaves
    // the working tree untouched. Screening as we went would let an early write
    // land and then abort with a message claiming nothing had changed.
    const planned: Array<{ path: string; side: ConflictSide }> = [];

    for (const file of decidable) {
      const side = byPath.get(file.path) === "mine" ? file.ours : file.theirs;
      if (side.state === "unreadable") {
        throw new Error(
          `Cannot resolve ${file.path}: the chosen version could not be read (${side.error}). ` +
            `Nothing was changed.`,
        );
      }
      planned.push({ path: file.path, side });
    }

    // Bring in every non-conflicting remote change too, using ordinary three-way
    // logic: take theirs where the remote changed a path and this device did not.
    //
    // Walking the merge base as well as both heads is what makes remote *deletions*
    // apply. Iterating only the remote's file list would skip them, leaving the local
    // copy in place while the merge commit claimed that commit had been merged — so
    // the deletion would never be offered again.
    const bases = await git.findMergeBase({
      ...this.base(),
      oids: [pending.ourHead, pending.theirHead],
    });
    const rows = await this.threeWayOids(bases[0], pending.ourHead, pending.theirHead);
    const conflictPaths = new Set(pending.files.map((f) => f.path));

    for (const row of rows) {
      if (conflictPaths.has(row.path)) continue;
      if (this.exclude.isExcluded(row.path)) continue;
      const remoteChanged = row.theirsOid !== row.baseOid;
      const weChanged = row.oursOid !== row.baseOid;
      if (!remoteChanged || weChanged) continue;

      if (row.theirsOid === null) {
        planned.push({ path: row.path, side: { state: "absent" } });
        continue;
      }
      const theirs = await this.readAtCommit(pending.theirHead, row.path);
      if (theirs.state === "unreadable") {
        throw new Error(
          `Cannot apply the remote version of ${row.path} (${theirs.error}). ` +
            `Nothing was changed.`,
        );
      }
      planned.push({ path: row.path, side: theirs });
    }

    // Everything that could be screened has been. A failure inside this loop (an
    // adapter error mid-write) leaves earlier files applied and no merge commit;
    // `pending` is deliberately not cleared, so the next sync re-offers the conflict
    // rather than treating the partial state as merged.
    for (const { path, side } of planned) {
      await this.materialise(path, side);
    }

    const oid = await git.commit({
      ...this.base(),
      message: `Merge remote ${this.branch} (resolved ${pending.files.length} conflict(s))`,
      author: this.author(),
      parent: [pending.ourHead, pending.theirHead],
    });

    this.pending = null;
    this.log(`merge: resolved and committed ${oid.slice(0, 7)}`);
    return oid;
  }

  /**
   * Writes one decided side to the working tree and stages it.
   *
   * Text is written as a string and binary as bytes; a binary file must never go
   * through a string, or the attachment is corrupted. `absent` means the chosen
   * side deleted the file, so the deletion is what gets staged.
   */
  private async materialise(filepath: string, side: ConflictSide): Promise<void> {
    const fs = this.fsChannel;

    if (side.state === "absent") {
      try {
        await fs.promises.unlink(this.join(filepath));
      } catch {
        // Already gone from the working tree.
      }
      await git.remove({ ...this.base(), filepath });
      return;
    }
    if (side.state === "unreadable") {
      // Callers must screen this out before reaching here.
      throw new Error(`Refusing to write unreadable content for ${filepath}`);
    }

    // The vault adapter refuses to invent parent folders, and unlike
    // isomorphic-git this call has no mkdir-and-retry behind it. A remote-added
    // attachment in a folder this device does not have yet would otherwise fail
    // partway through resolution.
    const parent = filepath.includes("/")
      ? filepath.slice(0, filepath.lastIndexOf("/"))
      : "";
    if (parent) {
      try {
        await fs.promises.mkdir(this.join(parent));
      } catch {
        // Already present.
      }
    }

    const data = side.state === "text" ? side.content : side.bytes;
    await fs.promises.writeFile(this.join(filepath), data);
    await git.add({ ...this.base(), filepath });
  }

  /** Absolute path for the fs adapter, honouring an empty vault-root dir. */
  private join(filepath: string): string {
    return this.dir === "" ? filepath : `${this.dir}/${filepath}`;
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/git/safe-git-resolve.test.ts`
Expected: PASS, 10 tests. The binary round-trip and the unreadable refusal are the ones that
protect attachments.

- [ ] **Step 5: Commit**

```bash
git add src/git/safe-git.ts tests/git/safe-git-resolve.test.ts
git commit -m "feat: whole-file conflict resolution with real merge commits"
```

---

## Task 11: SafeGit — connect decision, clone-safe, fetch, push

**Files:**
- Modify: `src/git/safe-git.ts`
- Test: `tests/git/safe-git-connect.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/git/safe-git-connect.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import git from "isomorphic-git";
import { makeHarness, initRepo } from "../helpers/repo";

describe("SafeGit.decideConnect", () => {
  it("chooses clone-safe for a remote with content and no local notes", async () => {
    const h = await makeHarness();
    await h.write(".obsidian/app.json", "{}");
    const d = await h.safeGit.decideConnect({ remoteHasContent: true });
    expect(d.kind).toBe("clone-safe");
  });

  it("refuses when the remote has content and the vault already holds notes", async () => {
    const h = await makeHarness();
    await h.write("notes/mine.md", "existing\n");
    const d = await h.safeGit.decideConnect({ remoteHasContent: true });
    expect(d.kind).toBe("refuse");
    if (d.kind === "refuse") expect(d.reason).toMatch(/already contains notes/i);
  });

  it("chooses init-push for an empty remote", async () => {
    const h = await makeHarness();
    await h.write("notes/mine.md", "existing\n");
    const d = await h.safeGit.decideConnect({ remoteHasContent: false });
    expect(d.kind).toBe("init-push");
  });

  it("refuses to re-point a vault already connected to a different repo", async () => {
    const h = await makeHarness();
    await initRepo(h);
    await git.addRemote({
      fs: h.fs,
      dir: h.dir,
      remote: "origin",
      url: "https://github.com/other/other.git",
    });
    const d = await h.safeGit.decideConnect({ remoteHasContent: true });
    expect(d.kind).toBe("refuse");
    if (d.kind === "refuse") expect(d.reason).toMatch(/already connected/i);
  });

  it("allows reconnecting to the same repo", async () => {
    const h = await makeHarness();
    await initRepo(h);
    await git.addRemote({
      fs: h.fs,
      dir: h.dir,
      remote: "origin",
      url: "https://github.com/o/r.git",
    });
    const d = await h.safeGit.decideConnect({ remoteHasContent: true });
    expect(d.kind).toBe("reconnect");
  });
});

describe("SafeGit.push", () => {
  it("skips pushing when local is not ahead", async () => {
    const h = await makeHarness();
    const first = await initRepo(h);
    await git.writeRef({
      fs: h.fs,
      dir: h.dir,
      ref: "refs/remotes/origin/main",
      value: first,
      force: true,
    });
    // http throws if called, so a skip is proven by this not rejecting.
    await expect(h.safeGit.push()).resolves.toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/git/safe-git-connect.test.ts`
Expected: FAIL — `decideConnect is not a function`.

- [ ] **Step 3: Add connect, clone, fetch, and push to `src/git/safe-git.ts`**

Add this type near the other exported types:

```ts
export type ConnectDecision =
  | { kind: "clone-safe" }
  | { kind: "init-push" }
  | { kind: "reconnect" }
  | { kind: "refuse"; reason: string };
```

Add these methods to the class:

```ts
  /**
   * Decides how to connect, refusing rather than improvising whenever the
   * assumption "remote has content, local vault is empty" does not hold.
   */
  async decideConnect(opts: { remoteHasContent: boolean }): Promise<ConnectDecision> {
    const existing = await this.currentRemoteUrl();
    if (existing && !sameRepo(existing, this.url)) {
      return {
        kind: "refuse",
        reason:
          `This vault is already connected to ${existing}. ` +
          `Disconnect first before connecting it to a different repository.`,
      };
    }
    if (existing) return { kind: "reconnect" };

    if (!opts.remoteHasContent) return { kind: "init-push" };

    // Note the interaction with the exclude set: `hasLocalContent()` asks whether any
    // NON-excluded file exists, so an exclude pattern that matches everything makes any
    // vault look empty and sends this decision down the clone-safe path. Task 16 warns
    // about such a pattern at the point of entry; nothing here can distinguish "empty
    // vault" from "everything excluded", which is why that warning matters.
    if (await this.hasLocalContent()) {
      return {
        kind: "refuse",
        reason:
          "This vault already contains notes, and the remote repository also has content. " +
          "Connecting would mix two unrelated histories. Use an empty vault on this device, " +
          "or reconcile the two on a desktop first.",
      };
    }
    return { kind: "clone-safe" };
  }

  /**
   * Clones history without writing anything, then materialises only
   * non-excluded paths. The remote's `.obsidian/*` therefore stays in history
   * but never lands on disk, so it cannot collide with this device's config.
   */
  async cloneSafe(): Promise<void> {
    this.log("clone: fetching history without checkout");
    await git.clone({
      ...this.net(),
      ref: this.branch,
      singleBranch: true,
      noCheckout: true,
    });

    const head = await this.tryResolve(`refs/heads/${this.branch}`);
    if (!head) {
      this.log("clone: remote had no commits on this branch");
      return;
    }
    const tracked = await git.listFiles({ ...this.base(), ref: head });
    const wanted = this.exclude.withoutExcluded(tracked);
    this.log(`clone: checking out ${wanted.length} of ${tracked.length} tracked path(s)`);
    if (wanted.length > 0) {
      await git.checkout({
        ...this.base(),
        ref: this.branch,
        filepaths: wanted,
        force: false,
      });
    }
  }

  /** Initialises a repo here and pushes the vault to an empty remote. */
  async initAndPush(message: string): Promise<void> {
    if (!(await this.isRepo())) {
      await git.init({ ...this.base(), defaultBranch: this.branch });
    }
    if (!(await this.currentRemoteUrl())) {
      await git.addRemote({ ...this.base(), remote: "origin", url: this.url });
    }
    await this.commitLocal(message);
    await git.push({
      ...this.net(),
      ref: this.branch,
      remoteRef: this.branch,
    });
    this.log("init: pushed initial commit");
  }

  /** Fetches into the remote-tracking ref. Writes nothing to the working tree. */
  async fetch(): Promise<string | null> {
    const res = await git.fetch({
      ...this.net(),
      ref: this.branch,
      remoteRef: this.branch,
      singleBranch: true,
      tags: false,
    });
    const oid = res.fetchHead ?? (await this.tryResolve(`refs/remotes/origin/${this.branch}`));
    this.log(`fetch: remote head ${oid ? oid.slice(0, 7) : "none"}`);
    return oid;
  }

  /** Pushes only when local is genuinely ahead. Returns whether it pushed. */
  async push(): Promise<boolean> {
    const local = await this.tryResolve(`refs/heads/${this.branch}`);
    const remote = await this.tryResolve(`refs/remotes/origin/${this.branch}`);
    if (!local) {
      this.log("push: no local branch, skipping");
      return false;
    }
    if (local === remote) {
      this.log("push: nothing to push");
      return false;
    }
    await git.push({ ...this.net(), ref: this.branch, remoteRef: this.branch });
    this.log(`push: pushed ${local.slice(0, 7)}`);
    return true;
  }
```

Add this module-private helper at the bottom of the file, outside the class:

```ts
/** Compares remote URLs ignoring a trailing .git and case. */
function sameRepo(a: string, b: string): boolean {
  const norm = (u: string) => u.trim().replace(/\.git$/i, "").replace(/\/+$/, "").toLowerCase();
  return norm(a) === norm(b);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/git/safe-git-connect.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Run the whole suite**

Run: `npx vitest run`
Expected: PASS, all tests from Tasks 2–11.

- [ ] **Step 6: Commit**

```bash
git add src/git/safe-git.ts tests/git/safe-git-connect.test.ts
git commit -m "feat: connect decision, clone-safe, fetch, and guarded push"
```

---

## Task 12: Sync service

Orchestrates the fixed sequence using only SafeGit's safe exports.

**Files:**
- Create: `src/sync/sync-service.ts`
- Test: `tests/sync/sync-service.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/sync/sync-service.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { SyncService } from "../../src/sync/sync-service";
import type { MergeOutcome } from "../../src/types";

function fakeGit(over: Partial<Record<string, unknown>> = {}) {
  return {
    commitLocal: vi.fn(async () => "abc1234"),
    fetch: vi.fn(async () => "def5678"),
    mergeSafe: vi.fn(async (): Promise<MergeOutcome> => ({ kind: "up-to-date" })),
    push: vi.fn(async () => true),
    ...over,
  };
}

describe("SyncService.sync", () => {
  it("runs commit, fetch, merge, then push in order", async () => {
    const g = fakeGit();
    const order: string[] = [];
    g.commitLocal.mockImplementation(async () => { order.push("commit"); return "abc"; });
    g.fetch.mockImplementation(async () => { order.push("fetch"); return "def"; });
    g.mergeSafe.mockImplementation(async () => { order.push("merge"); return { kind: "up-to-date" }; });
    g.push.mockImplementation(async () => { order.push("push"); return true; });

    const report = await new SyncService(g as never, () => "msg").sync();
    expect(order).toEqual(["commit", "fetch", "merge", "push"]);
    expect(report.success).toBe(true);
  });

  it("does not push when the merge conflicts", async () => {
    const g = fakeGit({
      mergeSafe: vi.fn(async (): Promise<MergeOutcome> => ({
        kind: "conflict",
        files: [
          {
            path: "a.md",
            ours: { state: "text", content: "x" },
            theirs: { state: "text", content: "y" },
          },
        ],
      })),
    });
    const report = await new SyncService(g as never, () => "msg").sync();

    expect(g.push).not.toHaveBeenCalled();
    expect(report.success).toBe(false);
    expect(report.conflicts.map((c) => c.path)).toEqual(["a.md"]);
    expect(report.steps.find((s) => s.name === "push")?.result).toBe("skipped");
  });

  it("does not push when the histories cannot be merged", async () => {
    const g = fakeGit({
      mergeSafe: vi.fn(async (): Promise<MergeOutcome> => ({
        kind: "unmergeable",
        reason: "unrelated-histories",
      })),
    });
    const report = await new SyncService(g as never, () => "msg").sync();

    expect(g.push).not.toHaveBeenCalled();
    expect(report.success).toBe(false);
    expect(report.conflicts).toEqual([]);
    expect(report.steps.find((s) => s.name === "merge")?.detail).toMatch(/no history/i);
    expect(report.steps.find((s) => s.name === "push")?.result).toBe("skipped");
  });

  it("stops after a failed fetch but keeps the commit result", async () => {
    const g = fakeGit({
      fetch: vi.fn(async () => { throw new Error("offline"); }),
    });
    const report = await new SyncService(g as never, () => "msg").sync();

    expect(report.steps.find((s) => s.name === "commit")?.result).toBe("ok");
    expect(report.steps.find((s) => s.name === "fetch")?.result).toBe("failed");
    expect(g.mergeSafe).not.toHaveBeenCalled();
    expect(report.success).toBe(false);
  });

  it("records a failed push without undoing the local commit", async () => {
    const g = fakeGit({
      push: vi.fn(async () => { throw new Error("bad credentials"); }),
    });
    const report = await new SyncService(g as never, () => "msg").sync();

    expect(report.steps.find((s) => s.name === "commit")?.result).toBe("ok");
    expect(report.steps.find((s) => s.name === "push")?.result).toBe("failed");
    expect(report.steps.find((s) => s.name === "push")?.detail).toContain("bad credentials");
    expect(report.success).toBe(false);
  });

  it("marks commit as skipped when there was nothing to commit", async () => {
    const g = fakeGit({ commitLocal: vi.fn(async () => null) });
    const report = await new SyncService(g as never, () => "msg").sync();
    expect(report.steps.find((s) => s.name === "commit")?.result).toBe("skipped");
    expect(report.success).toBe(true);
  });

  it("marks push as skipped when there was nothing to push", async () => {
    const g = fakeGit({ push: vi.fn(async () => false) });
    const report = await new SyncService(g as never, () => "msg").sync();
    expect(report.steps.find((s) => s.name === "push")?.result).toBe("skipped");
    expect(report.success).toBe(true);
  });

  it("refuses to run two syncs at once", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const g = fakeGit({ commitLocal: vi.fn(async () => { await gate; return "abc"; }) });
    const svc = new SyncService(g as never, () => "msg");

    const first = svc.sync();
    await expect(svc.sync()).rejects.toThrow(/already in progress/i);
    release();
    await first;
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/sync/sync-service.test.ts`
Expected: FAIL — cannot resolve `../../src/sync/sync-service`.

- [ ] **Step 3: Create `src/sync/sync-service.ts`**

```ts
import type { SafeGit } from "../git/safe-git";
import type {
  ConflictFile,
  SyncReport,
  SyncStep,
  UnmergeableReason,
} from "../types";

/**
 * Runs the one safe sync sequence. Knows the order; SafeGit knows the safety.
 *
 * commit -> fetch -> merge -> push
 *
 * Committing first is what makes a merge unable to discard unsaved work.
 * Merging before pushing is required because a remote that is ahead rejects a
 * push. A conflict stops the sequence before push.
 */
export class SyncService {
  private running = false;

  constructor(
    private readonly git: SafeGit,
    private readonly buildMessage: () => string,
  ) {}

  isRunning(): boolean {
    return this.running;
  }

  async sync(): Promise<SyncReport> {
    if (this.running) throw new Error("A sync is already in progress");
    this.running = true;

    const steps: SyncStep[] = [];
    const logs: string[] = [];
    let conflicts: ConflictFile[] = [];

    const note = (line: string) => logs.push(line);

    try {
      // 1. Commit local work.
      let committed = false;
      try {
        const oid = await this.git.commitLocal(this.buildMessage());
        committed = oid !== null;
        steps.push({
          name: "commit",
          result: committed ? "ok" : "skipped",
          detail: committed ? `committed ${oid!.slice(0, 7)}` : "nothing to commit",
        });
      } catch (err) {
        steps.push({ name: "commit", result: "failed", detail: message(err) });
        return this.finish(steps, conflicts, logs);
      }

      // 2. Fetch.
      try {
        const oid = await this.git.fetch();
        steps.push({
          name: "fetch",
          result: "ok",
          detail: oid ? `remote at ${oid.slice(0, 7)}` : "remote has no commits",
        });
      } catch (err) {
        steps.push({ name: "fetch", result: "failed", detail: message(err) });
        steps.push({ name: "merge", result: "skipped", detail: "fetch failed" });
        steps.push({ name: "push", result: "skipped", detail: "fetch failed" });
        return this.finish(steps, conflicts, logs);
      }

      // 3. Merge, safely.
      let stopped = false;
      try {
        const outcome = await this.git.mergeSafe();
        if (outcome.kind === "conflict") {
          stopped = true;
          conflicts = outcome.files;
          steps.push({
            name: "merge",
            result: "failed",
            detail: `${outcome.files.length} file(s) conflict — nothing was written`,
          });
        } else if (outcome.kind === "unmergeable") {
          stopped = true;
          steps.push({
            name: "merge",
            result: "failed",
            detail: describeUnmergeable(outcome.reason),
          });
        } else {
          steps.push({ name: "merge", result: "ok", detail: outcome.kind });
        }
      } catch (err) {
        steps.push({ name: "merge", result: "failed", detail: message(err) });
        steps.push({ name: "push", result: "skipped", detail: "merge failed" });
        return this.finish(steps, conflicts, logs);
      }

      if (stopped) {
        steps.push({
          name: "push",
          result: "skipped",
          detail:
            conflicts.length > 0
              ? "resolve the conflict first"
              : "the histories could not be merged",
        });
        return this.finish(steps, conflicts, logs);
      }

      // 4. Push.
      try {
        const pushed = await this.git.push();
        steps.push({
          name: "push",
          result: pushed ? "ok" : "skipped",
          detail: pushed ? "pushed" : "nothing to push",
        });
      } catch (err) {
        steps.push({ name: "push", result: "failed", detail: message(err) });
      }

      note("sync sequence complete");
      return this.finish(steps, conflicts, logs);
    } finally {
      this.running = false;
    }
  }

  private finish(
    steps: SyncStep[],
    conflicts: ConflictFile[],
    logs: string[],
  ): SyncReport {
    const success = steps.every((s) => s.result !== "failed") && conflicts.length === 0;
    return { steps, conflicts, success, logs };
  }
}

function message(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function describeUnmergeable(reason: UnmergeableReason): string {
  return reason === "unrelated-histories"
    ? "local and remote share no history — stopped without changing anything"
    : "history diverged in a way the git engine cannot merge — stopped safely";
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/sync/sync-service.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add src/sync/sync-service.ts tests/sync/sync-service.test.ts
git commit -m "feat: sync service orchestrating commit, fetch, merge, push"
```

---

## Task 13: GitHub API client

**Files:**
- Create: `src/github/api.ts`
- Test: `tests/github/api.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/github/api.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { setRequestUrlHandler, type RequestUrlParam } from "../mocks/obsidian";
import { GitHubApi } from "../../src/github/api";

function respond(map: Record<string, { status: number; body: unknown }>) {
  const calls: RequestUrlParam[] = [];
  setRequestUrlHandler(async (p) => {
    calls.push(p);
    const key = Object.keys(map).find((k) => p.url.includes(k));
    const entry = key ? map[key] : { status: 404, body: {} };
    const text = JSON.stringify(entry.body);
    return {
      status: entry.status,
      headers: {},
      arrayBuffer: new TextEncoder().encode(text).buffer as ArrayBuffer,
      text,
      json: entry.body,
    };
  });
  return calls;
}

describe("GitHubApi", () => {
  it("verifies a token and returns the login", async () => {
    respond({ "/user": { status: 200, body: { login: "octocat" } } });
    const api = new GitHubApi("tok");
    expect(await api.verifyToken()).toEqual({ ok: true, login: "octocat" });
  });

  it("reports an invalid token", async () => {
    respond({ "/user": { status: 401, body: { message: "Bad credentials" } } });
    const api = new GitHubApi("tok");
    const res = await api.verifyToken();
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("Bad credentials");
  });

  it("sends the token as a Bearer header", async () => {
    const calls = respond({ "/user": { status: 200, body: { login: "o" } } });
    await new GitHubApi("tok").verifyToken();
    expect(calls[0].headers?.Authorization).toBe("Bearer tok");
  });

  it("reports a repo that exists and has commits", async () => {
    respond({ "/repos/o/r": { status: 200, body: { size: 12, default_branch: "main" } } });
    const api = new GitHubApi("tok");
    expect(await api.inspectRepo("o", "r")).toEqual({
      exists: true,
      hasContent: true,
      defaultBranch: "main",
    });
  });

  it("reports an existing but empty repo", async () => {
    respond({ "/repos/o/r": { status: 200, body: { size: 0, default_branch: "main" } } });
    const api = new GitHubApi("tok");
    const info = await api.inspectRepo("o", "r");
    expect(info).toEqual({ exists: true, hasContent: false, defaultBranch: "main" });
  });

  it("reports a missing repo", async () => {
    respond({});
    const api = new GitHubApi("tok");
    expect(await api.inspectRepo("o", "r")).toEqual({
      exists: false,
      hasContent: false,
      defaultBranch: "main",
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/github/api.test.ts`
Expected: FAIL — cannot resolve `../../src/github/api`.

- [ ] **Step 3: Create `src/github/api.ts`**

```ts
import { requestUrl } from "obsidian";
import { GITHUB_API, DEFAULT_BRANCH } from "../constants";

export type VerifyResult =
  | { ok: true; login: string }
  | { ok: false; error: string };

export interface RepoInfo {
  exists: boolean;
  /** True when the repo has at least one commit worth of content. */
  hasContent: boolean;
  defaultBranch: string;
}

/** Minimal GitHub REST client. All traffic goes through requestUrl. */
export class GitHubApi {
  constructor(private readonly token: string) {}

  private async get(path: string): Promise<{ status: number; json: unknown }> {
    const res = await requestUrl({
      url: `${GITHUB_API}${path}`,
      method: "GET",
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      throw: false,
    });
    let json: unknown = {};
    try {
      json = JSON.parse(res.text);
    } catch {
      json = {};
    }
    return { status: res.status, json };
  }

  async verifyToken(): Promise<VerifyResult> {
    const { status, json } = await this.get("/user");
    if (status === 200) {
      return { ok: true, login: (json as { login: string }).login };
    }
    const msg = (json as { message?: string }).message ?? `HTTP ${status}`;
    return { ok: false, error: msg };
  }

  async inspectRepo(owner: string, repo: string): Promise<RepoInfo> {
    const { status, json } = await this.get(`/repos/${owner}/${repo}`);
    if (status !== 200) {
      return { exists: false, hasContent: false, defaultBranch: DEFAULT_BRANCH };
    }
    const body = json as { size?: number; default_branch?: string };
    return {
      exists: true,
      hasContent: (body.size ?? 0) > 0,
      defaultBranch: body.default_branch ?? DEFAULT_BRANCH,
    };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/github/api.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/github/api.ts tests/github/api.test.ts
git commit -m "feat: minimal GitHub API client for token and repo checks"
```

---

## Task 14: Log modal

**Files:**
- Create: `src/ui/log-modal.ts`

- [ ] **Step 1: Create `src/ui/log-modal.ts`**

Mobile has no developer console, so this is the only way to see what happened. It always
opens on error, and on success only when verbose logging is on.

```ts
import { App, Modal, Notice } from "obsidian";
import type { SyncReport } from "../types";

export class LogModal extends Modal {
  constructor(
    app: App,
    private readonly title: string,
    private readonly lines: string[],
  ) {
    super(app);
  }

  static fromReport(app: App, report: SyncReport): LogModal {
    const lines = report.steps.map((s) => `[${s.result}] ${s.name}: ${s.detail}`);
    if (report.logs.length > 0) lines.push("", ...report.logs);
    return new LogModal(app, report.success ? "Sync complete" : "Sync stopped", lines);
  }

  override onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h3", { text: this.title });

    const pre = contentEl.createEl("pre", {
      cls: "gsm-log",
      text: this.lines.join("\n"),
    });
    pre.style.whiteSpace = "pre-wrap";
    pre.style.userSelect = "text";
    pre.style.maxHeight = "50vh";
    pre.style.overflow = "auto";

    const copy = contentEl.createEl("button", { text: "Copy" });
    copy.onclick = async () => {
      await navigator.clipboard.writeText(this.lines.join("\n"));
      new Notice("Log copied");
    };
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/ui/log-modal.ts
git commit -m "feat: on-screen log modal for mobile diagnostics"
```

---

## Task 15: Conflict modal

**Files:**
- Create: `src/ui/conflict-modal.ts`

- [ ] **Step 1: Create `src/ui/conflict-modal.ts`**

```ts
import { App, Modal } from "obsidian";
import type { ConflictFile, ConflictSide } from "../types";
import type { ConflictResolution } from "../git/safe-git";

/**
 * Per-file whole-file choice. Both versions already exist in git history, so
 * neither option destroys anything — the losing side is only postponed.
 */
export class ConflictModal extends Modal {
  private readonly choices = new Map<string, "mine" | "theirs">();

  constructor(
    app: App,
    private readonly files: readonly ConflictFile[],
    private readonly onResolve: (r: ConflictResolution[]) => void,
    private readonly onAbandon: () => void,
  ) {
    super(app);
  }

  private resolved = false;

  override onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h3", { text: `Resolve ${this.files.length} conflict(s)` });
    contentEl.createEl("p", {
      text:
        "Both versions are saved in history, so nothing is lost either way. " +
        "Pick which version should be kept for each file.",
    });

    for (const file of this.files) {
      const box = contentEl.createDiv({ cls: "gsm-conflict" });
      box.style.border = "1px solid var(--background-modifier-border)";
      box.style.borderRadius = "8px";
      box.style.padding = "10px";
      box.style.marginBottom = "10px";

      box.createEl("strong", { text: file.path });

      const row = box.createDiv();
      row.style.display = "flex";
      row.style.gap = "8px";
      row.style.marginTop = "8px";

      // A side that could not be read cannot be chosen. If neither side is
      // readable the file is undecidable, so say so rather than leaving two dead
      // buttons and an Apply that never activates.
      if (file.ours.state === "unreadable" && file.theirs.state === "unreadable") {
        box.createEl("p", {
          text:
            "Neither version could be read, so this file cannot be resolved here. " +
            "Both versions remain in history.",
        });
        continue;
      }

      const mine = row.createEl("button", { text: describe("Keep mine", file.ours) });
      const theirs = row.createEl("button", { text: describe("Keep theirs", file.theirs) });
      if (file.ours.state === "unreadable") mine.disabled = true;
      if (file.theirs.state === "unreadable") theirs.disabled = true;

      const paint = () => {
        const c = this.choices.get(file.path);
        mine.style.fontWeight = c === "mine" ? "700" : "400";
        theirs.style.fontWeight = c === "theirs" ? "700" : "400";
      };
      mine.onclick = () => { this.choices.set(file.path, "mine"); paint(); };
      theirs.onclick = () => { this.choices.set(file.path, "theirs"); paint(); };
      paint();
    }

    const decidable = this.files.filter(
      (f) => !(f.ours.state === "unreadable" && f.theirs.state === "unreadable"),
    );

    const apply = contentEl.createEl("button", { text: "Apply and push" });
    apply.style.marginTop = "6px";
    apply.onclick = () => {
      if (this.choices.size !== decidable.length) return;
      this.resolved = true;
      this.onResolve(
        decidable.map((f) => ({ path: f.path, choice: this.choices.get(f.path)! })),
      );
      this.close();
    };
    if (decidable.length === 0) apply.disabled = true;
  }

  override onClose(): void {
    this.contentEl.empty();
    // Dismissing without deciding must leave the repo untouched.
    if (!this.resolved) this.onAbandon();
  }
}

/**
 * Summarises a side without ever rendering raw bytes. A binary attachment gets a
 * size, which is more useful than a wall of replacement characters would be, and
 * an unreadable side says so plainly rather than looking like an empty file.
 */
function describe(label: string, side: ConflictSide): string {
  switch (side.state) {
    case "absent":
      return `${label} (deleted)`;
    case "text": {
      const lines = side.content.split("\n").length;
      return `${label} (${lines} line${lines === 1 ? "" : "s"})`;
    }
    case "binary":
      return `${label} (binary, ${formatBytes(side.bytes.byteLength)})`;
    case "unreadable":
      return `${label} (unreadable)`;
  }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/ui/conflict-modal.ts
git commit -m "feat: whole-file conflict resolution modal"
```

---

## Task 16: Settings tab

**Files:**
- Create: `src/ui/settings-tab.ts`

- [ ] **Step 1: Create `src/ui/settings-tab.ts`**

Note the explicit token-leak warning when un-excluding `.obsidian/` — the token lives in
`.obsidian/plugins/<id>/data.json` in plaintext.

```ts
import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type GitHubSyncPlugin from "../main";
import { DEFAULT_EXCLUDES, TIMESTAMP_TOKEN } from "../constants";
import { compileExcludes, matchesEverything } from "../git/exclude";
import { GitHubApi } from "../github/api";

/** Every file in the vault, recursively. Folders are walked, not reported. */
async function listVaultFiles(
  adapter: { list(path: string): Promise<{ files: string[]; folders: string[] }> },
  path: string,
): Promise<string[]> {
  const out: string[] = [];
  const { files, folders } = await adapter.list(path);
  out.push(...files);
  for (const folder of folders) out.push(...(await listVaultFiles(adapter, folder)));
  return out;
}

export class SettingsTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: GitHubSyncPlugin) {
    super(app, plugin);
  }

  override display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "GitHub Sync Mobile" });

    new Setting(containerEl)
      .setName("Personal access token")
      .setDesc(
        "Fine-grained token with Contents: read and write on just this repository. " +
          "Stored in this vault's plugin settings, which is why .obsidian must stay excluded.",
      )
      .addText((t) => {
        t.inputEl.type = "password";
        t.setPlaceholder("github_pat_...")
          .setValue(this.plugin.settings.token)
          .onChange(async (v) => {
            this.plugin.settings.token = v.trim();
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Repository owner")
      .setDesc("Your GitHub username or the organisation that owns the repo.")
      .addText((t) =>
        t
          .setPlaceholder("JiaPeng1234")
          .setValue(this.plugin.settings.owner)
          .onChange(async (v) => {
            this.plugin.settings.owner = v.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Repository name")
      .setDesc("Named explicitly so the wrong repo can never be connected by accident.")
      .addText((t) =>
        t
          .setPlaceholder("my-vault")
          .setValue(this.plugin.settings.repo)
          .onChange(async (v) => {
            this.plugin.settings.repo = v.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Branch")
      .addText((t) =>
        t.setValue(this.plugin.settings.branch).onChange(async (v) => {
          this.plugin.settings.branch = v.trim() || "main";
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl).setName("Connection").addButton((b) =>
      b.setButtonText("Test connection").onClick(async () => {
        const s = this.plugin.settings;
        if (!s.token || !s.owner || !s.repo) {
          new Notice("Fill in token, owner, and repository first");
          return;
        }
        const api = new GitHubApi(s.token);
        const who = await api.verifyToken();
        if (!who.ok) {
          new Notice(`Token rejected: ${who.error}`);
          return;
        }
        const info = await api.inspectRepo(s.owner, s.repo);
        new Notice(
          info.exists
            ? `OK as ${who.login} — repo found${info.hasContent ? " with content" : " (empty)"}`
            : `Signed in as ${who.login}, but ${s.owner}/${s.repo} was not found`,
        );
      }),
    );

    containerEl.createEl("h3", { text: "What syncs" });

    new Setting(containerEl)
      .setName("Sync Obsidian config (.obsidian)")
      .setDesc(
        "Off by default. Turning this on publishes your access token to GitHub, " +
          "because plugin settings are stored in .obsidian in plain text.",
      )
      .addToggle((t) =>
        t.setValue(!this.hasExclude(".obsidian")).onChange(async (on) => {
          if (on) {
            const ok = window.confirm(
              "Syncing .obsidian will upload this plugin's settings — including your " +
                "GitHub token — to the repository. Continue?",
            );
            if (!ok) {
              this.display();
              return;
            }
            this.plugin.settings.excludePatterns =
              this.plugin.settings.excludePatterns.filter(
                (p) => !p.startsWith(".obsidian"),
              );
          } else if (!this.hasExclude(".obsidian")) {
            this.plugin.settings.excludePatterns.push(".obsidian/");
          }
          await this.plugin.saveSettings();
          this.display();
        }),
      );

    // A pattern that matches everything silences the entire sync: nothing is staged,
    // nothing is pushed, and the sync still reports success over an empty change set.
    // `*` does this, because every pattern also matches what lies beneath what it
    // matched. On iOS the user cannot inspect anything, so it has to be caught here.
    const universal = this.plugin.settings.excludePatterns.filter(matchesEverything);
    if (universal.length > 0) {
      const warning = containerEl.createEl("p", {
        text:
          `Warning: ${universal.map((p) => `"${p}"`).join(", ")} matches every possible ` +
          `file, so nothing will be synced at all. Remove it or make it more specific.`,
      });
      warning.style.color = "var(--text-error)";
      warning.style.fontWeight = "600";
    }

    // `matchesEverything` only catches patterns that are universal in the abstract. A
    // pattern can still exclude this particular user's entire vault while sparing some
    // hypothetical file — `**` plus `/*.md` in a Markdown-only vault, which is the common
    // Obsidian case. The vault-relative count is the only way to see that, and it also
    // surfaces a typo'd pattern that matches nothing and a case-mismatched one such as
    // `.Obsidian/`.
    //
    // Filled in asynchronously: `display()` is synchronous in Obsidian's API, and
    // widening it to return a promise would be a signature nobody awaits.
    const coverage = containerEl.createEl("p", { text: "Counting excluded files…" });
    void this.renderCoverage(coverage);

    new Setting(containerEl)
      .setName("Excluded paths (advanced)")
      .setDesc(
        "One pattern per line. A trailing / , /* or /** all mean the whole directory. " +
          "Excluded paths are never cloned, staged, merged, or pushed.",
      )
      .addTextArea((t) => {
        t.inputEl.rows = 6;
        t.setValue(this.plugin.settings.excludePatterns.join("\n")).onChange(async (v) => {
          this.plugin.settings.excludePatterns = v
            .split("\n")
            .map((s) => s.trim())
            .filter((s) => s.length > 0);
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl).setName("Reset excludes to defaults").addButton((b) =>
      b.setButtonText("Reset").onClick(async () => {
        this.plugin.settings.excludePatterns = [...DEFAULT_EXCLUDES];
        await this.plugin.saveSettings();
        this.display();
      }),
    );

    containerEl.createEl("h3", { text: "Diagnostics" });

    new Setting(containerEl)
      .setName("Verbose logging")
      .setDesc("Show the step-by-step trace after every sync. Off for normal use.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.verboseLog).onChange(async (v) => {
          this.plugin.settings.verboseLog = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Commit message")
      .setDesc(`${TIMESTAMP_TOKEN} is replaced with the current date and time.`)
      .addText((t) =>
        t
          .setValue(this.plugin.settings.commitMessageTemplate)
          .onChange(async (v) => {
            this.plugin.settings.commitMessageTemplate = v;
            await this.plugin.saveSettings();
          }),
      );
  }

  /** Reports how much of the actual vault the current patterns exclude. */
  private async renderCoverage(el: HTMLElement): Promise<void> {
    const matcher = compileExcludes(this.plugin.settings.excludePatterns);
    const files = await listVaultFiles(this.app.vault.adapter, "");
    const kept = matcher.withoutExcluded(files).length;

    if (files.length > 0 && kept === 0) {
      el.setText(
        `Every one of the ${files.length} files in this vault is excluded, so a sync ` +
          `would do nothing and still report success. Check the patterns above.`,
      );
      el.style.color = "var(--text-error)";
      el.style.fontWeight = "600";
      return;
    }
    el.setText(`${files.length - kept} of ${files.length} files in this vault are excluded.`);
    el.style.color = "var(--text-muted)";
  }

  private hasExclude(prefix: string): boolean {
    return this.plugin.settings.excludePatterns.some((p) => p.startsWith(prefix));
  }
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: errors only about the not-yet-created `../main` import. Proceed; Task 18 resolves it.

- [ ] **Step 3: Commit**

```bash
git add src/ui/settings-tab.ts
git commit -m "feat: settings tab with token-leak warning on .obsidian"
```

---

## Task 17: Sync view

**Files:**
- Create: `src/ui/sync-view.ts`

- [ ] **Step 1: Create `src/ui/sync-view.ts`**

One primary button plus a collapsed Advanced section holding the individual verbs.

```ts
import { ItemView, WorkspaceLeaf } from "obsidian";
import type GitHubSyncPlugin from "../main";

export const SYNC_VIEW_TYPE = "github-sync-mobile-view";

export class SyncView extends ItemView {
  private statusEl!: HTMLElement;

  constructor(leaf: WorkspaceLeaf, private readonly plugin: GitHubSyncPlugin) {
    super(leaf);
  }

  override getViewType(): string {
    return SYNC_VIEW_TYPE;
  }

  override getDisplayText(): string {
    return "GitHub Sync";
  }

  override getIcon(): string {
    return "refresh-cw";
  }

  override async onOpen(): Promise<void> {
    const root = this.contentEl;
    root.empty();
    root.style.padding = "12px";

    root.createEl("h3", { text: "GitHub Sync" });
    this.statusEl = root.createDiv({ cls: "gsm-status" });
    this.statusEl.style.marginBottom = "12px";
    this.statusEl.style.fontSize = "13px";

    const syncBtn = root.createEl("button", { text: "Sync now" });
    syncBtn.style.width = "100%";
    syncBtn.style.padding = "12px";
    syncBtn.style.fontWeight = "600";
    syncBtn.onclick = async () => {
      syncBtn.disabled = true;
      syncBtn.setText("Syncing…");
      try {
        await this.plugin.runSync();
      } finally {
        syncBtn.disabled = false;
        syncBtn.setText("Sync now");
        await this.refresh();
      }
    };

    const detail = root.createEl("details");
    detail.style.marginTop = "16px";
    detail.createEl("summary", { text: "Advanced" });

    const verbs = detail.createDiv();
    verbs.style.display = "flex";
    verbs.style.flexDirection = "column";
    verbs.style.gap = "6px";
    verbs.style.marginTop = "8px";

    this.verb(verbs, "Fetch", () => this.plugin.runFetch());
    this.verb(verbs, "Pull (fetch + safe merge)", () => this.plugin.runPull());
    this.verb(verbs, "Commit local changes", () => this.plugin.runCommit());
    this.verb(verbs, "Push", () => this.plugin.runPush());
    this.verb(verbs, "Show last log", () => {
      this.plugin.showLastLog();
      return Promise.resolve();
    });

    await this.refresh();
  }

  private verb(parent: HTMLElement, label: string, run: () => Promise<void>): void {
    const b = parent.createEl("button", { text: label });
    b.onclick = async () => {
      b.disabled = true;
      try {
        await run();
      } finally {
        b.disabled = false;
        await this.refresh();
      }
    };
  }

  async refresh(): Promise<void> {
    if (!this.statusEl) return;
    this.statusEl.setText(await this.plugin.statusLine());
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/ui/sync-view.ts
git commit -m "feat: sync view with one primary button and advanced verbs"
```

---

## Task 18: Plugin entry point

**Files:**
- Create: `src/main.ts`

- [ ] **Step 1: Create `src/main.ts`**

```ts
import { Notice, Plugin, WorkspaceLeaf } from "obsidian";
import {
  DEFAULT_BRANCH,
  DEFAULT_COMMIT_TEMPLATE,
  DEFAULT_EXCLUDES,
  TIMESTAMP_TOKEN,
  repoUrl,
} from "./constants";
import { compileExcludes } from "./git/exclude";
import { createFs } from "./git/fs-adapter";
import { httpClient } from "./git/http-client";
import { SafeGit, type ConflictResolution } from "./git/safe-git";
import { GitHubApi } from "./github/api";
import { SyncService } from "./sync/sync-service";
import { ConflictModal } from "./ui/conflict-modal";
import { LogModal } from "./ui/log-modal";
import { SettingsTab } from "./ui/settings-tab";
import { SYNC_VIEW_TYPE, SyncView } from "./ui/sync-view";
import type { PluginSettings, SyncReport } from "./types";

const DEFAULT_SETTINGS: PluginSettings = {
  token: "",
  owner: "",
  repo: "",
  branch: DEFAULT_BRANCH,
  excludePatterns: [...DEFAULT_EXCLUDES],
  verboseLog: false,
  commitMessageTemplate: DEFAULT_COMMIT_TEMPLATE,
};

export default class GitHubSyncPlugin extends Plugin {
  settings: PluginSettings = { ...DEFAULT_SETTINGS };
  private lastReport: SyncReport | null = null;
  private logLines: string[] = [];
  /** Why the current settings cannot produce a client, if they cannot. */
  private configError: string | null = null;

  override async onload(): Promise<void> {
    await this.loadSettings();

    this.addSettingTab(new SettingsTab(this.app, this));

    this.registerView(SYNC_VIEW_TYPE, (leaf: WorkspaceLeaf) => new SyncView(leaf, this));

    this.addRibbonIcon("refresh-cw", "GitHub Sync", () => this.openView());

    this.addCommand({
      id: "open-github-sync",
      name: "Open GitHub Sync panel",
      callback: () => this.openView(),
    });

    this.addCommand({
      id: "sync-now",
      name: "Sync now",
      callback: () => void this.runSync(),
    });

    this.addCommand({
      id: "connect-repo",
      name: "Connect this vault to GitHub",
      callback: () => void this.connect(),
    });
  }

  override async onunload(): Promise<void> {
    // Nothing to flush: sync only ever runs on explicit user action.
  }

  async loadSettings(): Promise<void> {
    this.settings = { ...DEFAULT_SETTINGS, ...(await this.loadData()) };
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  private async openView(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(SYNC_VIEW_TYPE);
    if (existing.length > 0) {
      await this.app.workspace.revealLeaf(existing[0]);
      return;
    }
    const leaf = this.app.workspace.getRightLeaf(false);
    if (!leaf) return;
    await leaf.setViewState({ type: SYNC_VIEW_TYPE, active: true });
    await this.app.workspace.revealLeaf(leaf);
  }

  /**
   * Builds a SafeGit bound to current settings, or null when the settings cannot
   * produce one. Returns null rather than throwing: `repoUrl` rejects a malformed
   * owner or repo, and an unhandled throw here would leave every button inert with
   * no explanation — the exact unexaminable failure this plugin exists to avoid.
   */
  private makeGit(): SafeGit | null {
    const s = this.settings;
    if (!s.token || !s.owner || !s.repo) return null;

    let url: string;
    try {
      url = repoUrl(s.owner, s.repo);
    } catch (err) {
      this.configError = err instanceof Error ? err.message : String(err);
      return null;
    }
    this.configError = null;

    const adapter = this.app.vault.adapter;
    const base = (adapter as { basePath?: string }).basePath ?? "";

    this.logLines = [];
    return new SafeGit({
      fs: createFs(adapter, base),
      http: httpClient,
      dir: base,
      url,
      token: s.token,
      branch: s.branch,
      exclude: compileExcludes(s.excludePatterns),
      onLog: (line) => this.logLines.push(line),
    });
  }

  private requireGit(): SafeGit | null {
    const git = this.makeGit();
    if (!git) {
      new Notice(
        this.configError ?? "Set your token, owner, and repository in settings first",
      );
    }
    return git;
  }

  private commitMessage(): string {
    return this.settings.commitMessageTemplate.replace(
      TIMESTAMP_TOKEN,
      new Date().toLocaleString(),
    );
  }

  /** Connects this vault, refusing whenever the safe assumption is violated. */
  async connect(): Promise<void> {
    const git = this.requireGit();
    if (!git) return;

    const s = this.settings;
    const api = new GitHubApi(s.token);

    const who = await api.verifyToken();
    if (!who.ok) {
      new Notice(`Token rejected: ${who.error}`);
      return;
    }
    const info = await api.inspectRepo(s.owner, s.repo);
    if (!info.exists) {
      new Notice(`Repository ${s.owner}/${s.repo} not found. Create it on GitHub first.`);
      return;
    }

    const decision = await git.decideConnect({ remoteHasContent: info.hasContent });

    if (decision.kind === "refuse") {
      new Notice(decision.reason, 15000);
      new LogModal(this.app, "Cannot connect", [decision.reason]).open();
      return;
    }

    try {
      if (decision.kind === "clone-safe") {
        new Notice("Cloning from GitHub…");
        await git.cloneSafe();
        new Notice("Connected. Your notes have been downloaded.");
      } else if (decision.kind === "init-push") {
        new Notice("Remote is empty — pushing this vault…");
        await git.initAndPush(this.commitMessage());
        new Notice("Connected. Your vault is now on GitHub.");
      } else {
        new Notice("Already connected to this repository.");
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      new Notice(`Connect failed: ${msg}`, 10000);
      new LogModal(this.app, "Connect failed", [...this.logLines, "", msg]).open();
    }
  }

  async runSync(): Promise<void> {
    const git = this.requireGit();
    if (!git) return;
    if (!(await git.isRepo())) {
      new Notice("Not connected yet — run 'Connect this vault to GitHub' first");
      return;
    }

    const service = new SyncService(git, () => this.commitMessage());
    let report: SyncReport;
    try {
      report = await service.sync();
    } catch (err) {
      new Notice(err instanceof Error ? err.message : String(err));
      return;
    }
    for (const line of this.logLines) report.logs.push(line);
    this.lastReport = report;

    if (report.conflicts.length > 0) {
      new ConflictModal(
        this.app,
        report.conflicts,
        (resolutions) => void this.applyResolutions(git, resolutions),
        () => {
          git.abandonConflict();
          new Notice("Conflict left unresolved. Nothing was changed.");
        },
      ).open();
      return;
    }

    if (!report.success) {
      new Notice("Sync stopped — see the log");
      LogModal.fromReport(this.app, report).open();
      return;
    }

    new Notice("Sync complete");
    if (this.settings.verboseLog) LogModal.fromReport(this.app, report).open();
  }

  private async applyResolutions(
    git: SafeGit,
    resolutions: ConflictResolution[],
  ): Promise<void> {
    try {
      await git.resolveConflicts(resolutions);
      const pushed = await git.push();
      new Notice(pushed ? "Conflicts resolved and pushed" : "Conflicts resolved");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      new Notice(`Could not finish resolving: ${msg}`, 10000);
      new LogModal(this.app, "Resolution failed", [...this.logLines, "", msg]).open();
    }
  }

  async runFetch(): Promise<void> {
    const git = this.requireGit();
    if (!git) return;
    try {
      const oid = await git.fetch();
      new Notice(oid ? `Fetched ${oid.slice(0, 7)}` : "Remote has no commits");
    } catch (err) {
      new Notice(`Fetch failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async runPull(): Promise<void> {
    const git = this.requireGit();
    if (!git) return;
    try {
      await git.fetch();
      const outcome = await git.mergeSafe();
      if (outcome.kind === "conflict") {
        new ConflictModal(
          this.app,
          outcome.files,
          (r) => void this.applyResolutions(git, r),
          () => {
            git.abandonConflict();
            new Notice("Conflict left unresolved. Nothing was changed.");
          },
        ).open();
        return;
      }
      if (outcome.kind === "unmergeable") {
        const detail =
          outcome.reason === "unrelated-histories"
            ? "This vault and the remote share no history, so they cannot be merged here."
            : "The history diverged in a way the git engine cannot merge.";
        new Notice(`${detail} Nothing was changed.`, 15000);
        new LogModal(this.app, "Cannot merge", [...this.logLines, "", detail]).open();
        return;
      }
      new Notice(`Pull: ${outcome.kind}`);
    } catch (err) {
      new Notice(`Pull failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async runCommit(): Promise<void> {
    const git = this.requireGit();
    if (!git) return;
    try {
      const oid = await git.commitLocal(this.commitMessage());
      new Notice(oid ? `Committed ${oid.slice(0, 7)}` : "Nothing to commit");
    } catch (err) {
      new Notice(`Commit failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async runPush(): Promise<void> {
    const git = this.requireGit();
    if (!git) return;
    try {
      const pushed = await git.push();
      new Notice(pushed ? "Pushed" : "Nothing to push");
    } catch (err) {
      new Notice(`Push failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  showLastLog(): void {
    if (!this.lastReport) {
      new Notice("No sync has run yet");
      return;
    }
    LogModal.fromReport(this.app, this.lastReport).open();
  }

  /** One-line summary for the panel. */
  async statusLine(): Promise<string> {
    const git = this.makeGit();
    if (!git) return this.configError ?? "Not configured — open settings";
    if (!(await git.isRepo())) return "Not connected";
    try {
      const s = await git.status();
      return `${s.changed.length} changed · ${s.ahead} ahead · ${s.behind} behind`;
    } catch {
      return "Connected";
    }
  }
}
```

- [ ] **Step 2: Typecheck the whole project**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Run the full test suite**

Run: `npx vitest run`
Expected: PASS, all tests.

- [ ] **Step 4: Build the bundle**

Run: `npm run build`
Expected: writes `main.js`, no errors.

- [ ] **Step 5: Commit**

```bash
git add src/main.ts
git commit -m "feat: plugin entry point wiring connect, sync, and manual verbs"
```

---

## Task 19: Release workflow and docs

**Files:**
- Create: `.github/workflows/release.yml`, `README.md`

- [ ] **Step 1: Create `.github/workflows/release.yml`**

```yaml
name: Release Obsidian Plugin

on:
  push:
    tags:
      - "*"

permissions:
  contents: write

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: "20.x"

      - run: npm ci

      - run: npm test

      - run: npm run build

      - name: Create release
        uses: softprops/action-gh-release@v2
        with:
          files: |
            main.js
            manifest.json
          token: ${{ secrets.GITHUB_TOKEN }}
```

- [ ] **Step 2: Create `README.md`**

```markdown
# GitHub Sync Mobile

Manually sync an Obsidian vault to your own private GitHub repository, designed
for iOS where there is no git CLI and no way to inspect hidden files.

## Why

Built after another sync plugin silently destroyed uncommitted notes. The goal
here is not "sync" — it is **never losing data**, on a platform where you cannot
repair anything by hand.

## Design rules

- Local changes are committed **before** any merge, so a merge can never discard
  unsaved work.
- Destructive git operations are unreachable: `checkout --force` is not exported
  from the module that owns the git engine.
- Every operation that touches the working tree dry-runs first.
- Conflicts stop the sync with the working tree **byte-identical**, then let you
  choose per file: keep mine, or keep theirs. Both versions stay in history.
- Excluded paths are inert in both directions — never cloned, staged, merged, or
  pushed — and never register as deletions.

## Setup

1. Create a private repository on GitHub.
2. Create a **fine-grained** personal access token with `Contents: read and write`
   scoped to that one repository.
3. Install this plugin, open its settings, and fill in the token, owner, and
   repository name.
4. Run **Connect this vault to GitHub** from the command palette.

Connect expects the remote to have content and this vault to be empty. If the
vault already holds notes, it refuses and explains rather than mixing two
histories.

## Usage

Open the panel from the ribbon icon and tap **Sync now**:

```
commit local → fetch → safe merge → push
```

Individual verbs (Fetch, Pull, Commit, Push) live under **Advanced**.

## Security

Your token is stored in `.obsidian/plugins/github-sync-mobile/data.json` in plain
text. `.obsidian/` is excluded by default, which keeps the token out of the
repository. Do not un-exclude it.

## Known limitation: memory on mobile

Git operations load objects into memory, and iOS caps how much a single app may
use. Very large vaults, or vaults with big binaries, can exhaust that budget
during clone or merge. Shallow cloning would reduce memory use but removes the
history that merges need to find a common ancestor, so this plugin keeps full
history on a single branch instead. Keep large attachments (video, large PDFs)
out of the synced set using exclude patterns.

## Status

Phase 1: manual sync with whole-file conflict resolution.
Phase 2: line-level conflict merging.

## License

GPL-3.0-or-later. Copyright (C) 2026 Peng Jia.

Bundled dependencies: `isomorphic-git` (MIT) and `buffer` (MIT). `main.js` is a minified
bundle; their notices are reproduced in `THIRD-PARTY-NOTICES.md`.
```

- [ ] **Step 2b: Create `THIRD-PARTY-NOTICES.md`**

GPL-3.0 is compatible with MIT, but MIT requires its notice to travel with redistributed
copies — and `main.js` is a minified bundle that drops them. Reproduce the `isomorphic-git`
and `buffer` licence texts (copy them from `node_modules/<pkg>/LICENSE`) so the release
artifacts satisfy that.

Note the `LICENSE` file itself must NOT be edited: the `<year> <name of author>` placeholders
near the end sit inside the GPL's own "How to Apply These Terms" appendix, which is part of the
licence text and is meant to stay verbatim. The real copyright notice belongs in the README
above.

- [ ] **Step 3: Verify the full pipeline**

Run: `npm ci && npm test && npm run build`
Expected: install clean, all tests pass, `main.js` produced.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/release.yml README.md
git commit -m "chore: release workflow and README"
```

- [ ] **Step 5: Tag a release (lightweight tag only)**

`softprops/action-gh-release` fails on **annotated** tags. Always use a lightweight
tag — this exact mistake blocked a release in the predecessor project.

```bash
git tag 0.1.0
git push origin main
git push origin 0.1.0
```

Expected: the Actions run publishes a release with `main.js` and `manifest.json`.

---

## Manual verification on iPhone (author)

Automated tests cover the data-loss paths; these steps confirm real-device behaviour.

- [ ] Install via BRAT into a **throwaway** vault, not the real one.
- [ ] Enter token, owner, repo; run **Test connection** — expect success.
- [ ] Run **Connect this vault to GitHub** on the empty vault — expect the notes to
      download and **no** `.obsidian` conflict, the failure that motivated this project.
- [ ] Edit a note on the phone, tap **Sync now** — expect commit and push.
- [ ] Edit the *same* note on GitHub and on the phone, then **Sync now** — expect the
      conflict modal, and confirm the note on disk is unchanged until a choice is made.
- [ ] Choose "Keep mine", verify the push, then check the losing version is still
      reachable in the repo's history on GitHub.
- [ ] Turn on verbose logging and confirm the step trace is readable and copyable.
- [ ] Only after all of the above pass, connect the real vault.
