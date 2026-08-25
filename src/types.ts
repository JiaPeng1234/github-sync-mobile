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
  /** Must contain {@link TIMESTAMP_TOKEN}, which is substituted at commit time. */
  commitMessageTemplate: string;
}

/**
 * One side's version of a conflicting file.
 *
 * Deliberately not `string | null`. Vaults contain images and PDFs, and decoding
 * a blob to a string to carry it through the resolution flow is lossy: a
 * non-fatal TextDecoder turns every invalid UTF-8 byte into U+FFFD, so writing
 * the result back would silently corrupt the attachment and commit the damage.
 * Both ends of this pipeline (isomorphic-git's readBlob and the vault adapter)
 * already speak bytes, so bytes are what we carry.
 *
 * `unreadable` is separate from `absent` on purpose. A failed blob read — a torn
 * packfile after iOS killed the app mid-write, or an out-of-memory on a large
 * attachment — must never be mistaken for "the user deleted this file", because
 * the resolution step acts on `absent` by deleting and committing.
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
 * responses: a conflict is resolvable per file in the app, whereas an unmergeable
 * history cannot be resolved here at all and must be reconciled elsewhere. Giving
 * them one shape forced consumers to discriminate on `files.length` instead of on
 * the tag, and required a meaningless empty `files` array.
 */
export type MergeOutcome =
  | { kind: "up-to-date" }
  | { kind: "fast-forward"; oid: string }
  | { kind: "merged"; oid: string }
  | { kind: "conflict"; files: ConflictFile[] }
  | { kind: "unmergeable"; reason: UnmergeableReason };

/**
 * Cases isomorphic-git cannot merge: it implements no recursive merge
 * strategy, so it throws when several merge bases exist (the criss-cross case
 * from two devices diverging), and it cannot join two unrelated roots. It also
 * cannot merge a path that is a file on one side and a directory on the other
 * (`type-change`) — iso-git has no strategy for a type change and throws. We
 * catch all three and stop safely rather than letting them crash or improvise.
 */
export type UnmergeableReason = "unrelated-histories" | "multiple-merge-bases" | "type-change";

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
   * (nothing to commit, nothing to push) does not make a sync unsuccessful.
   */
  readonly success: boolean;
  /** Mutable: the plugin appends its own trace lines after the sync returns. */
  logs: string[];
}
