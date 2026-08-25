import git, { TREE } from "isomorphic-git";
import type { ExcludeMatcher } from "./exclude";
import type { VaultFs } from "./fs-adapter";
import type { ConflictFile, ConflictSide, MergeOutcome, RepoStatus } from "../types";
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

export interface ConflictResolution {
  path: string;
  choice: "mine" | "theirs";
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
    for (const [filepath, head, workdir, stage] of matrix) {
      if (this.exclude.isExcluded(filepath)) continue;
      if (head === 1 && workdir === 1) continue;

      if (workdir === 0) {
        // A `head === 1, workdir === 0, stage === 0` row is NOT a user deletion — it is an
        // interrupted checkout. If the app was killed after a fast-forward/merge advanced the
        // branch ref but before the working tree was materialised, HEAD tracks the file, the
        // index never received it (stage === 0), and it is absent from disk. Committing this as
        // a removal would push away a file that still exists on the remote — the very thing this
        // plugin must never do. A genuine deletion of a checked-out file is `[1,0,1]`: the index
        // still holds it. Only stage === 1 confirms the file was materialised and then removed.
        // Verified against real isomorphic-git 1.41: interrupted ff → [1,0,0]; real delete → [1,0,1].
        if (head === 1 && stage === 0) {
          throw new Error(
            `${filepath} is in the committed history but was never written to this device ` +
              `(an earlier sync was interrupted before it finished). Refusing to commit its ` +
              `removal, which would delete it from the remote. Nothing was changed — re-run sync.`,
          );
        }

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
      // Any successful or no-op merge supersedes an outstanding conflict: the state it
      // was recorded against no longer exists.
      this.pending = null;
      this.log("merge: no remote ref yet, nothing to merge");
      return { kind: "up-to-date" };
    }
    if (local === remote) {
      // Any successful or no-op merge supersedes an outstanding conflict.
      this.pending = null;
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
      // Any successful or no-op merge supersedes an outstanding conflict.
      this.pending = null;
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
      // A path that is a file on one side and a directory on the other is a type
      // change. isomorphic-git has no strategy for it and throws
      // MergeNotSupportedError at the dry-run, so nothing has been written. Surface
      // it as a structured unmergeable outcome rather than an uncaught throw, the
      // same stance as the other unmergeable cases. It cannot be surfaced as a
      // whole-file conflict here because the conflict UI would have to render a path
      // that is a directory on one side; that is deferred.
      const code = (err as { code?: string; name?: string }).code ?? (err as Error)?.name;
      if (code === "MergeNotSupportedError") {
        this.log("merge: type change (file vs directory) — unsupported by the engine, stopping safely");
        return { kind: "unmergeable", reason: "type-change" };
      }
      const conflicts = await this.describeConflicts(err, local, remote, bases[0]);
      if (conflicts.length === 0) throw err;
      this.log(`merge: conflict in ${conflicts.length} file(s) — nothing written`);
      this.pending = { ourHead: local, theirHead: remote, files: conflicts };
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
    // Any successful or no-op merge supersedes an outstanding conflict.
    this.pending = null;
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

  /**
   * Checks out the non-excluded files of a commit. Never forces.
   *
   * Measured caveat: a non-force checkout to a ref that is already checked out is a
   * no-op. It does not restore a file deleted from the working tree, and it does not
   * revert a locally modified one. That is the safe direction — it cannot clobber — but
   * it means this is not a repair mechanism, and no caller should treat it as one.
   */
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

    // Belt-and-braces on top of mergeSafe clearing pending on its non-conflict exits:
    // validate the pending conflict against current reality before acting on it. If the
    // local or remote head has moved since the conflict was recorded (e.g. the user
    // committed on top and a later fetch fast-forwarded past it), the pending record is
    // stale. Trusting it would overwrite the newer content on disk and commit with stale
    // parents, so the newer content would not even be reachable in history. Refuse and
    // write nothing rather than apply a resolution against a state that no longer exists.
    const currentLocal = await this.tryResolve(`refs/heads/${this.branch}`);
    const currentRemote = await this.tryResolve(`refs/remotes/origin/${this.branch}`);
    if (pending.ourHead !== currentLocal || pending.theirHead !== currentRemote) {
      throw new Error(
        `The repository moved since this conflict was recorded, so the pending ` +
          `resolution no longer applies. Nothing was changed — re-run sync to get a ` +
          `fresh conflict.`,
      );
    }

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

}

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

// Exported for testing. This function is the switch that decides whether a git read
// failure means "the file was deleted on that side" (absent -> materialise unlinks
// and commits) or "the object could not be read" (unreadable -> refuse). Since a
// misclassification here would turn a torn object into a durable deletion, its exact
// branches are pinned directly rather than only through the harder-to-construct
// behavioural path.
export function isPathAbsent(err: unknown, oid: string): boolean {
  const e = err as { code?: string; data?: { what?: string } };
  if (e?.code !== "NotFoundError") return false;
  // Only trustworthy for a full oid. An abbreviated oid or a ref name such as
  // "main" is not expanded before the object read, so it reports itself in
  // `data.what` and would look like a missing path. Answering false in that case
  // routes to `unreadable`, which refuses rather than deletes.
  if (!OID.test(oid)) return false;
  return !OID.test(e.data?.what ?? "");
}
