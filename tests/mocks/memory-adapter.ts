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

/**
 * ENOENT carrying a `code` property, like Node's fs errors.
 *
 * The code is load-bearing, not decorative: isomorphic-git's write helper catches a
 * failed write, calls `mkdir` on the parent, and retries, and it keys that recovery on
 * the error code rather than the message.
 */
function enoent(message: string): Error {
  const e = new Error(`ENOENT: ${message}`) as Error & { code: string };
  e.code = "ENOENT";
  return e;
}

/** In-memory stand-in for Obsidian's DataAdapter. */
export class MemoryAdapter {
  private files = new Map<string, StoredFile>();
  private folders = new Set<string>();

  /**
   * Deterministic stand-in for wall-clock time, so mtimes are reproducible across runs.
   * Advanced by writes only -- never by stat, which must be side-effect free.
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
      throw enoent(`no such folder '${parent}' to write '${path}' into`);
    }
  }

  private put(path: string, data: Uint8Array): void {
    this.requireParent(path);
    const now = this.tick();
    const existing = this.files.get(path);
    this.files.set(path, { data, ctime: existing ? existing.ctime : now, mtime: now });
  }

  async write(path: string, data: string): Promise<void> {
    this.put(path, new TextEncoder().encode(data));
  }

  async writeBinary(path: string, data: ArrayBuffer): Promise<void> {
    this.put(path, new Uint8Array(data.slice(0)));
  }

  async read(path: string): Promise<string> {
    const f = this.files.get(path);
    if (!f) throw enoent(path);
    return new TextDecoder().decode(f.data);
  }

  async readBinary(path: string): Promise<ArrayBuffer> {
    const f = this.files.get(path);
    if (!f) throw enoent(path);
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

  /** Creates intermediate parents, so callers can set up a tree in one call. */
  async mkdir(path: string): Promise<void> {
    let acc = "";
    for (const p of path.split("/")) {
      acc = acc ? `${acc}/${p}` : p;
      if (acc) this.folders.add(acc);
    }
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
    if (!this.files.delete(path)) throw enoent(path);
  }

  /** Test helper: snapshot of every file path currently present. */
  paths(): string[] {
    return [...this.files.keys()].sort();
  }
}
