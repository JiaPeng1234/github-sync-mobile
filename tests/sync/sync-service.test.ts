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

  it("stops after a thrown commit without fetching, merging, or pushing", async () => {
    // A thrown commitLocal is the interrupted-checkout refusal: an earlier merge left a
    // remote-tracked file un-materialised, so committing now would record a false deletion.
    // The service must surface it as a failed commit and STOP — never force past it.
    const g = fakeGit({
      commitLocal: vi.fn(async () => {
        throw new Error("a file was never written to this device — re-run sync");
      }),
    });
    const report = await new SyncService(g as never, () => "msg").sync();

    expect(report.steps.find((s) => s.name === "commit")?.result).toBe("failed");
    expect(report.steps.find((s) => s.name === "commit")?.detail).toMatch(/re-run sync/i);
    expect(g.fetch).not.toHaveBeenCalled();
    expect(g.mergeSafe).not.toHaveBeenCalled();
    expect(g.push).not.toHaveBeenCalled();
    expect(report.success).toBe(false);
  });

  it("re-throws the interrupted-checkout refusal instead of burying it in the report", async () => {
    // The [head=1,workdir=0,stage=0] ambiguity is a data-loss decision, not a sync
    // failure. If the service swallowed it into a failed commit step, the plugin's Sync
    // button would show a raw error and the RecoveryModal stop-and-ask would never open.
    // So it must propagate out of sync() for the caller to route to recovery.
    const g = fakeGit({
      commitLocal: vi.fn(async () => {
        throw new Error(
          "notes/a.md is in the committed history but is not on this device right now. " +
            "This is an AMBIGUOUS, RESOLVABLE state that cannot be decided automatically.",
        );
      }),
    });
    await expect(new SyncService(g as never, () => "msg").sync()).rejects.toThrow(
      /ambiguous, resolvable/i,
    );
    // It must not have proceeded past commit.
    expect(g.fetch).not.toHaveBeenCalled();
    expect(g.push).not.toHaveBeenCalled();
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

  it("releases the lock after a sync so the next one can run", async () => {
    // On iOS there is no way to reset a wedged plugin, so a stuck `running` flag would
    // brick sync forever. The lock must release on every exit — including a thrown step.
    const svc = new SyncService(
      fakeGit({ commitLocal: vi.fn(async () => { throw new Error("boom"); }) }) as never,
      () => "msg",
    );
    await svc.sync();
    expect(svc.isRunning()).toBe(false);
    await expect(svc.sync()).resolves.toBeDefined();
    expect(svc.isRunning()).toBe(false);
  });
});
