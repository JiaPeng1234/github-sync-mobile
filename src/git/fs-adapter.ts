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
    //
    // The leading separators must come off BEFORE the "." test. isomorphic-git's
    // working-tree walker builds the path as `${dir}/${fullpath}` by concatenation, not
    // by its own `join`, so with the mobile base of "" the root arrives as "/." rather
    // than ".". Testing for "." first leaves that as a literal "." path and both
    // statusMatrix and checkout fail with ENOENT on lstat -- verified against real
    // isomorphic-git 1.41.
    while (p.startsWith("/")) p = p.slice(1);
    while (p.startsWith("./")) p = p.slice(2);
    if (p === ".") return "";
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

      // EVERY failure in this method has to be recorded, not just thrown.
      //
      // isomorphic-git's own `readdir` maps `ENOTDIR` to `null` and swallows
      // everything else — `ENOENT` included — as `[]`, an empty directory. So a read
      // that fails here is indistinguishable from an empty folder by the time the
      // walker sees it, and every file beneath is reported as deleted. Throwing the
      // right code is necessary but not sufficient: nothing downstream can see it,
      // which is why `readFailures` exists.
      //
      // Both the stat and the listing are wrapped. An earlier version guarded only
      // the listing, leaving a transient stat failure to be swallowed as `[]` with
      // nothing recorded — silent, which is the one outcome this project never accepts.
      let st: Awaited<ReturnType<VaultAdapter["stat"]>>;
      try {
        st = await adapter.stat(p);
      } catch (err) {
        readFailures.push(p);
        throw err;
      }

      if (p !== "") {
        // Genuine absence is not a read failure, so it is not recorded — but the codes
        // are still kept distinct, because they matter to isomorphic-git's own
        // write-retry path.
        if (!st) throw enoent(path);
        if (st.type !== "folder") throw enotdir(path);
      }

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
