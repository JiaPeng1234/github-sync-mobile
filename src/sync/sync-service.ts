import { isInterruptedCheckoutRefusal, type SafeGit } from "../git/safe-git";
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
        // The ambiguous interrupted-checkout refusal is NOT a sync failure to bury in a
        // report — it is a data-loss decision the user must make. Re-throw it so the
        // caller (the plugin) can open the RecoveryModal stop-and-ask; if it were only
        // recorded in a step's detail, the primary Sync button would show a raw error and
        // the recovery UI would never appear. Every other commit failure is a normal
        // failed step that stops the sequence.
        if (isInterruptedCheckoutRefusal(err)) throw err;
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
  switch (reason) {
    case "unrelated-histories":
      return "local and remote share no history — stopped without changing anything";
    case "type-change":
      return "a path is a file on one side and a folder on the other — the git engine cannot merge that; reconcile it on a desktop, then sync again";
    default:
      return "history diverged in a way the git engine cannot merge — stopped safely";
  }
}
