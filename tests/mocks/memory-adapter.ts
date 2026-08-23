import type { DataAdapter, DataWriteOptions, Stat } from "obsidian";

interface StoredFile {
  data: Uint8Array;
  ctime: number;
  mtime: number;
}

interface StoredFolder {
  ctime: number;
  mtime: number;
}

/**
 * An error carrying a `code` property, like Node's fs errors.
 *
 * The code is load-bearing, not decorative. isomorphic-git's write helper catches a
 * failed write, calls `mkdir` on the parent, and retries, keying that recovery on the
 * code rather than the message; its `readdir` converts ENOENT/ENOTDIR into `null` to
 * distinguish "absent or not a directory" from "an empty directory".
 */
function fsError(code: "ENOENT" | "ENOTDIR" | "EISDIR", message: string): Error {
  const e = new Error(`${code}: ${message}`) as Error & { code: string };
  e.code = code;
  return e;
}

/**
 * In-memory stand-in for Obsidian's DataAdapter.
 *
 * Invariant: `files` and `folders` have disjoint key sets. One path is a file or a
 * folder, never both. Every mutating method preserves this, because a path that
 * answers to both `read` and `list` is a state no real filesystem can reach, and a
 * safety test running against it would be measuring fiction.
 *
 * DELIBERATE DIVERGENCES from the real adapter. Each is an accepted trade-off, not an
 * oversight -- do not "harden" these without re-reading why:
 *   - `mkdir` on an existing folder succeeds instead of throwing EEXIST. Load-bearing:
 *     isomorphic-git's mkdir-and-retry path calls mkdir on parents that usually already
 *     exist, and making this throw would break that recovery.
 *   - Non-recursive `rmdir` of a non-empty folder succeeds instead of failing, which
 *     strands the children. Tolerated because nothing in this plugin relies on the
 *     failure, and modelling it buys no safety.
 *   - Paths are case-sensitive, where iOS and macOS vaults are typically
 *     case-insensitive. A real device would collide two notes differing only in case;
 *     here they coexist. Modelling this faithfully would mean a whole case-folding
 *     layer, and no planned test depends on the collision.
 *   - `remove()` on a folder path throws ENOENT rather than the platform's error, since
 *     it only ever consults `files`.
 *   - `list("f.md/sub")` -- a path *under* a file -- gives ENOENT where a real
 *     filesystem gives ENOTDIR. isomorphic-git collapses both into `null`, so no branch
 *     changes; distinguishing them would mean walking every ancestor on each call.
 */
export class MemoryAdapter {
  private files = new Map<string, StoredFile>();
  private folders = new Map<string, StoredFolder>();

  /**
   * Deterministic stand-in for wall-clock time, so timestamps are reproducible across
   * runs. Advanced by writes and mkdir only -- never by stat, which must be
   * side-effect free.
   */
  private clock = 1000;

  private tick(): number {
    return (this.clock += 1000);
  }

  private parentOf(path: string): string {
    const i = path.lastIndexOf("/");
    return i === -1 ? "" : path.slice(0, i);
  }

  /** Every accumulated prefix of a path, outermost first: "a/b/c" -> a, a/b, a/b/c. */
  private prefixesOf(path: string): string[] {
    const out: string[] = [];
    let acc = "";
    for (const p of path.split("/")) {
      acc = acc ? `${acc}/${p}` : p;
      if (acc) out.push(acc);
    }
    return out;
  }

  /**
   * The real adapter does not create missing parent folders on write: desktop
   * (fs.writeFile) and mobile (Capacitor) both fail with ENOENT. Mirroring that
   * strictness is deliberate -- a lenient write path here would let a filesystem
   * bridge that forgets to mkdir pass its tests and then fail on a phone, which is
   * the one place this project's users cannot inspect or repair anything.
   */
  private put(path: string, data: Uint8Array, options?: DataWriteOptions): void {
    if (this.folders.has(path)) {
      throw fsError("EISDIR", `'${path}' is a folder, not a file`);
    }
    const parent = this.parentOf(path);
    if (parent !== "" && !this.folders.has(parent)) {
      throw fsError("ENOENT", `no such folder '${parent}' to write '${path}' into`);
    }

    const now = this.tick();
    const existing = this.files.get(path);
    this.files.set(path, {
      data,
      ctime: options?.ctime ?? existing?.ctime ?? now,
      mtime: options?.mtime ?? now,
    });
  }

  async write(path: string, data: string, options?: DataWriteOptions): Promise<void> {
    this.put(path, new TextEncoder().encode(data), options);
  }

  async writeBinary(
    path: string,
    data: ArrayBuffer,
    options?: DataWriteOptions,
  ): Promise<void> {
    this.put(path, new Uint8Array(data.slice(0)), options);
  }

  async read(path: string): Promise<string> {
    const f = this.files.get(path);
    if (!f) throw fsError("ENOENT", path);
    return new TextDecoder().decode(f.data);
  }

  async readBinary(path: string): Promise<ArrayBuffer> {
    const f = this.files.get(path);
    if (!f) throw fsError("ENOENT", path);
    return f.data.slice().buffer;
  }

  async exists(path: string): Promise<boolean> {
    return this.files.has(path) || this.folders.has(path) || path === "";
  }

  async stat(path: string): Promise<Stat | null> {
    const f = this.files.get(path);
    if (f) {
      return { type: "file", ctime: f.ctime, mtime: f.mtime, size: f.data.byteLength };
    }
    const d = this.folders.get(path);
    if (d) return { type: "folder", ctime: d.ctime, mtime: d.mtime, size: 0 };
    // The vault root always exists and was never created by anyone.
    if (path === "") return { type: "folder", ctime: 1000, mtime: 1000, size: 0 };
    return null;
  }

  /**
   * Non-recursive, returning full vault-relative paths. `folders` is the single source
   * of truth for what folders exist -- nothing is inferred from file path prefixes.
   *
   * Throws for a missing path and for a file, as the real adapter does. Returning an
   * empty listing instead would collapse "absent" and "empty" into one answer, and a
   * git tree walk reading a vanished subtree as "no entries" is exactly how a
   * deleted-files bug hides from a test that is supposed to catch it.
   */
  async list(path: string): Promise<{ files: string[]; folders: string[] }> {
    if (path !== "" && !this.folders.has(path)) {
      throw this.files.has(path)
        ? fsError("ENOTDIR", `'${path}' is a file, not a folder`)
        : fsError("ENOENT", `no such folder '${path}'`);
    }

    const prefix = path === "" ? "" : `${path}/`;
    const files: string[] = [];
    const folders: string[] = [];
    for (const f of this.files.keys()) {
      if (!f.startsWith(prefix)) continue;
      const rest = f.slice(prefix.length);
      if (rest && !rest.includes("/")) files.push(f);
    }
    for (const d of this.folders.keys()) {
      if (!d.startsWith(prefix)) continue;
      const rest = d.slice(prefix.length);
      if (rest && !rest.includes("/")) folders.push(d);
    }
    return { files: files.sort(), folders: folders.sort() };
  }

  /** Creates intermediate parents, so callers can set up a tree in one call. */
  async mkdir(path: string): Promise<void> {
    const prefixes = this.prefixesOf(path);
    // Validate the whole chain before creating anything, so a rejected mkdir leaves no
    // partial tree behind.
    for (const p of prefixes) {
      if (this.files.has(p)) {
        throw fsError("ENOTDIR", `'${p}' is a file, so '${path}' cannot be created`);
      }
    }
    let now = 0;
    for (const p of prefixes) {
      if (this.folders.has(p)) continue;
      if (now === 0) now = this.tick();
      this.folders.set(p, { ctime: now, mtime: now });
    }
  }

  async rmdir(path: string, recursive: boolean): Promise<void> {
    if (!this.folders.has(path)) {
      throw fsError("ENOENT", `no such folder '${path}'`);
    }
    this.folders.delete(path);
    if (recursive) {
      const p = `${path}/`;
      for (const f of [...this.files.keys()]) if (f.startsWith(p)) this.files.delete(f);
      for (const d of [...this.folders.keys()]) if (d.startsWith(p)) this.folders.delete(d);
    }
  }

  async remove(path: string): Promise<void> {
    if (!this.files.delete(path)) throw fsError("ENOENT", path);
  }

  /** Test helper: snapshot of every file path currently present. */
  paths(): string[] {
    return [...this.files.keys()].sort();
  }
}

// Compile-time guard: the methods we implement must match the real interface.
// Not a full DataAdapter -- we deliberately omit the members no test needs.
//
// Two proven blind spots, so nobody over-trusts this: it does not catch a *dropped
// optional parameter* (a shorter signature stays assignable) nor a *narrowed return
// type*. Both are covered by the runtime tests instead -- which is why, for example,
// DataWriteOptions and the stat/list return shapes have explicit test cases.
const _conforms: Pick<
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
> = new MemoryAdapter();
void _conforms;
