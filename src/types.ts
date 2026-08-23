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

/** A file that differs on both sides and needs a user decision. */
export interface ConflictFile {
  path: string;
  /** Working-tree/local content. Null when the local side deleted it. */
  ours: string | null;
  /** Remote content. Null when the remote side deleted it. */
  theirs: string | null;
}

export type MergeOutcome =
  | { kind: "up-to-date" }
  | { kind: "fast-forward"; oid: string }
  | { kind: "merged"; oid: string }
  | { kind: "conflict"; files: ConflictFile[]; reason: ConflictReason };

/**
 * Why a merge could not proceed. `unrelated-histories` and `multiple-merge-bases`
 * are isomorphic-git limitations we deliberately surface as conflicts instead of
 * letting them crash or improvise.
 */
export type ConflictReason =
  | "file-conflict"
  | "unrelated-histories"
  | "multiple-merge-bases";

export interface RepoStatus {
  /** Non-excluded files differing from HEAD. */
  changed: string[];
  ahead: number;
  behind: number;
}

export type StepResult = "ok" | "skipped" | "failed";

export interface SyncStep {
  name: "commit" | "fetch" | "merge" | "push";
  result: StepResult;
  detail: string;
}

export interface SyncReport {
  steps: SyncStep[];
  conflicts: ConflictFile[];
  /** True when every attempted step succeeded and no conflict was found. */
  success: boolean;
  logs: string[];
}
