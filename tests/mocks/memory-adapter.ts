import type { DataAdapter, DataWriteOptions } from "obsidian";

export interface StatResult {
  type: "file" | "folder";
  ctime: number;
  mtime: number;
  size: number;
}

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
function fsError(code: "ENOENT" | "ENOTDIR", message: string): Error {
  const e = new Error(`${code}: ${message}`) as Error & { code: string };
  e.code = code;
  return e;
}

/** In-memory stand-in for Obsidian's DataAdapter. */
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

  /**
   * The real adapter does not create missing parent folders on write: desktop
   * (fs.writeFile) and mobile (Capacitor) both fail with ENOENT. Mirroring that
   * strictness is deliberate -- a lenient write path here would let a filesystem
   * bridge that forgets to mkdir pass its tests and then fail on a phone, which is
   * the one place this project's users cannot inspect or repair anything.
   */
  private requireParent(path: string): void {
    const parent = this.parentOf(path);
    if (parent !== "" && !this.folders.has(parent)) {
      throw fsError("ENOENT", `no such folder '${parent}' to write '${path}' into`);
    }
  }

  private put(path: string, data: Uint8Array, options?: DataWriteOptions): void {
    this.requireParent(path);
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

  async stat(path: string): Promise<StatResult | null> {
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
   * Non-recursive, returning full vault-relative paths.
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
    const folders = new Set<string>();
    for (const f of this.files.keys()) {
      if (!f.startsWith(prefix)) continue;
      const rest = f.slice(prefix.length);
      if (!rest) continue;
      const slash = rest.indexOf("/");
      if (slash === -1) files.push(f);
      else folders.add(prefix + rest.slice(0, slash));
    }
    for (const d of this.folders.keys()) {
      if (!d.startsWith(prefix)) continue;
      const rest = d.slice(prefix.length);
      if (!rest) continue;
      if (!rest.includes("/")) folders.add(d);
    }
    return { files: files.sort(), folders: [...folders].sort() };
  }

  /** Creates intermediate parents, so callers can set up a tree in one call. */
  async mkdir(path: string): Promise<void> {
    let acc = "";
    let now = 0;
    for (const p of path.split("/")) {
      acc = acc ? `${acc}/${p}` : p;
      if (!acc || this.folders.has(acc)) continue;
      if (now === 0) now = this.tick();
      this.folders.set(acc, { ctime: now, mtime: now });
    }
  }

  async rmdir(path: string, recursive: boolean): Promise<void> {
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
