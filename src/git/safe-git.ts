import git, { TREE } from "isomorphic-git";
import type { ExcludeMatcher } from "./exclude";
import type { VaultFs } from "./fs-adapter";
import type { ConflictFile, RepoStatus } from "../types";
import { COMMIT_AUTHOR } from "../constants";

/** Extracts a human-readable message from an unknown thrown value. */
function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

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

  /**
   * True when at least one non-excluded file exists in the working tree.
   *
   * Refuses — throws — rather than answering when any read failed during the walk.
   * `listWorkingFiles` swallows its own read failures so a recursive walk cannot crash
   * mid-tree, but the fs bridge records every one of them out of band. A swallowed
   * failure over a vault that HAS notes would otherwise make this return `false`, and a
   * caller gating "is this vault empty?" on that `false` would treat a populated,
   * momentarily-unreadable vault as empty and overwrite it. An unreadable folder is
   * indistinguishable from an empty one, so we stop rather than guess — the same stance
   * `scanWorkingTree` takes for `status`/`commit`.
   */
  async hasLocalContent(): Promise<boolean> {
    this.fsChannel.clearReadFailures();
    const files = await this.listWorkingFiles("");
    const failed = this.fsChannel.readFailures;
    if (failed.length > 0) {
      throw new Error(
        `Could not read ${failed.length} path(s) while scanning the vault ` +
          `(${failed.slice(0, 3).join(", ")}). Refusing to continue, because an ` +
          `unreadable folder is indistinguishable from an empty one and would look ` +
          `like the vault had no content. Nothing was changed — try again.`,
      );
    }
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

    // A throw is also a refusal.
    //
    // The read-failure channel catches failures isomorphic-git swallows, but not every
    // failure gets swallowed: the tree walker calls `lstat` before `readdir`, so a
    // failing stat propagates out of `statusMatrix` with nothing recorded. That is the
    // safe direction — loud rather than silent — but it means the channel alone is not
    // the whole guard. Both paths have to end in "do not trust this scan".
    let matrix: Array<[string, number, number, number]>;
    try {
      matrix = (await git.statusMatrix({
        ...this.base(),
        filter: (f) => !this.exclude.isExcluded(f),
      })) as Array<[string, number, number, number]>;
    } catch (err) {
      throw new Error(
        `Could not scan the vault: ${message(err)}. Refusing to continue, because a ` +
          `partial scan would look like deleted files. Nothing was changed — try again.`,
      );
    }

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

  /**
   * Joins a repo-relative path with `dir` to form the path handed to the fs bridge.
   *
   * On mobile `dir` is "" and every path is already vault-root-relative, so the
   * filepath passes through unchanged; the bridge's `rel()` maps "", ".", and "/."
   * to the vault root. On desktop the working directory is prefixed.
   */
  private join(filepath: string): string {
    return this.dir === "" ? filepath : `${this.dir}/${filepath}`;
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
