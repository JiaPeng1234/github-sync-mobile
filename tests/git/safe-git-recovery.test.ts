import { describe, it, expect } from "vitest";
import git from "isomorphic-git";
import { isInterruptedCheckoutRefusal } from "../../src/git/safe-git";
import { makeHarness, initRepo, divergeRemote } from "../helpers/repo";

/**
 * Tests for SafeGit.listInterruptedCheckouts — the read-only query that enumerates
 * every ambiguous [head=1, workdir=0, stage=0] path so the recovery UI can offer the
 * user restoreFromHead vs confirmDeletion.
 *
 * These reproduce the SAME real interrupted fast-forward the commitLocal interrupted-
 * checkout tests use (drive mergeSafe's fast-forward, then kill the incoming write),
 * so the [1,0,0] rows are genuine, not fabricated.
 */
describe("SafeGit.listInterruptedCheckouts", () => {
  /**
   * Helper: reproduce an interrupted fast-forward that leaves the given remote-added
   * files as [head=1, workdir=0, stage=0]. Mirrors the commitLocal interrupted-ff test.
   */
  async function interruptedFastForward(fileName: string, content: string) {
    const h = await makeHarness();
    const first = await initRepo(h);
    const remoteOid = await divergeRemote(h, first, { [fileName]: content }, `remote adds ${fileName}`);

    // Local is behind at `first`, so mergeSafe will fast-forward.
    await git.writeRef({ fs: h.fs, dir: h.dir, ref: "refs/heads/main", value: first, force: true });
    await git.checkout({ fs: h.fs, dir: h.dir, ref: "main", force: true });
    if (h.adapter.paths().includes(fileName)) await h.adapter.remove(fileName);

    // Simulate the iOS kill: the fast-forward advances the ref, then the checkout fails
    // while writing the incoming file.
    const realWrite = h.adapter.write.bind(h.adapter);
    const realWriteBinary = h.adapter.writeBinary.bind(h.adapter);
    const base = fileName.slice(fileName.lastIndexOf("/") + 1);
    h.adapter.write = async (p, ...rest) => {
      if (p.endsWith(base)) throw new Error("SIMULATED app kill mid-checkout");
      return realWrite(p, ...(rest as [string]));
    };
    h.adapter.writeBinary = async (p, ...rest) => {
      if (p.endsWith(base)) throw new Error("SIMULATED app kill mid-checkout");
      return realWriteBinary(p, ...(rest as [ArrayBuffer]));
    };
    await expect(h.safeGit.mergeSafe()).rejects.toBeTruthy();
    h.adapter.write = realWrite;
    h.adapter.writeBinary = realWriteBinary;

    // Confirm the interrupted state before returning.
    expect(await git.resolveRef({ fs: h.fs, dir: h.dir, ref: "HEAD" })).toBe(remoteOid);
    expect(h.adapter.paths()).not.toContain(fileName);
    return h;
  }

  it("returns the ambiguous path from a real interrupted fast-forward", async () => {
    const h = await interruptedFastForward("notes/c.md", "remote c\n");
    // Sanity: commitLocal would refuse this exact row.
    await expect(h.safeGit.commitLocal("sync")).rejects.toThrow(/ambiguous, resolvable/i);

    expect(await h.safeGit.listInterruptedCheckouts()).toEqual(["notes/c.md"]);
  });

  it("isInterruptedCheckoutRefusal matches commitLocal's REAL throw", async () => {
    // Pin the shared predicate against the actual error object commitLocal throws — not a
    // hand-written copy of the message. If the throw text ever drifts out of the regex, the
    // sync service would stop re-throwing it and the RecoveryModal would silently never open.
    const h = await interruptedFastForward("notes/c.md", "remote c\n");
    let caught: unknown;
    try {
      await h.safeGit.commitLocal("sync");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(isInterruptedCheckoutRefusal(caught)).toBe(true);
    // And it must NOT match unrelated errors.
    expect(isInterruptedCheckoutRefusal(new Error("network offline"))).toBe(false);
    expect(isInterruptedCheckoutRefusal("not an error")).toBe(false);
  });

  it("returns every ambiguous path when several were left unmaterialised", async () => {
    // Two remote-added files, both interrupted by the same killed checkout.
    const h = await makeHarness();
    const first = await initRepo(h);
    const remoteOid = await divergeRemote(
      h,
      first,
      { "notes/c.md": "remote c\n", "notes/d.md": "remote d\n" },
      "remote adds c and d",
    );

    await git.writeRef({ fs: h.fs, dir: h.dir, ref: "refs/heads/main", value: first, force: true });
    await git.checkout({ fs: h.fs, dir: h.dir, ref: "main", force: true });
    for (const p of ["notes/c.md", "notes/d.md"]) {
      if (h.adapter.paths().includes(p)) await h.adapter.remove(p);
    }

    const realWrite = h.adapter.write.bind(h.adapter);
    const realWriteBinary = h.adapter.writeBinary.bind(h.adapter);
    h.adapter.write = async (p, ...rest) => {
      if (p.endsWith("c.md") || p.endsWith("d.md")) throw new Error("SIMULATED app kill mid-checkout");
      return realWrite(p, ...(rest as [string]));
    };
    h.adapter.writeBinary = async (p, ...rest) => {
      if (p.endsWith("c.md") || p.endsWith("d.md")) throw new Error("SIMULATED app kill mid-checkout");
      return realWriteBinary(p, ...(rest as [ArrayBuffer]));
    };
    await expect(h.safeGit.mergeSafe()).rejects.toBeTruthy();
    h.adapter.write = realWrite;
    h.adapter.writeBinary = realWriteBinary;

    expect(await git.resolveRef({ fs: h.fs, dir: h.dir, ref: "HEAD" })).toBe(remoteOid);

    expect((await h.safeGit.listInterruptedCheckouts()).sort()).toEqual(["notes/c.md", "notes/d.md"]);
  });

  it("does NOT return a genuine deletion [1,0,1] — that is a normal deletion commitLocal handles", async () => {
    const h = await makeHarness();
    await initRepo(h); // commits notes/a.md, materialised on disk

    // A genuine deletion of a materialised file: remove from disk AND from the index
    // (git.remove takes stage to 0 but the file WAS previously in the index at [1,1,1],
    // so this reproduces the [1,0,1]... actually to get [1,0,1] the index must still
    // hold it). Reproduce [1,0,1] by deleting from disk only, leaving the index intact.
    await h.adapter.remove("notes/a.md");

    // Row is now [head=1, workdir=0, stage=1]: index still holds it -> normal deletion.
    const matrix = (await git.statusMatrix({ fs: h.fs, dir: h.dir })) as Array<
      [string, number, number, number]
    >;
    const row = matrix.find(([p]) => p === "notes/a.md");
    expect(row).toEqual(["notes/a.md", 1, 0, 1]);

    expect(await h.safeGit.listInterruptedCheckouts()).toEqual([]);
  });

  it("does NOT return normal unchanged or modified files", async () => {
    const h = await makeHarness();
    await initRepo(h); // notes/a.md at [1,1,1]
    await h.write("notes/b.md", "modified but on disk\n"); // untracked [0,2,0]
    await h.write("notes/a.md", "changed\n"); // modified [1,2,1]

    expect(await h.safeGit.listInterruptedCheckouts()).toEqual([]);
  });

  it("excludes excluded paths even when they are in the [1,0,0] state", async () => {
    // Same interrupted fast-forward, but the incoming file lands under an excluded folder.
    const h = await makeHarness();
    const first = await initRepo(h);
    const remoteOid = await divergeRemote(
      h,
      first,
      { ".obsidian/workspace.json": "{}\n" },
      "remote adds obsidian config",
    );

    await git.writeRef({ fs: h.fs, dir: h.dir, ref: "refs/heads/main", value: first, force: true });
    await git.checkout({ fs: h.fs, dir: h.dir, ref: "main", force: true });
    if (h.adapter.paths().includes(".obsidian/workspace.json")) {
      await h.adapter.remove(".obsidian/workspace.json");
    }

    const realWrite = h.adapter.write.bind(h.adapter);
    const realWriteBinary = h.adapter.writeBinary.bind(h.adapter);
    h.adapter.write = async (p, ...rest) => {
      if (p.endsWith("workspace.json")) throw new Error("SIMULATED app kill mid-checkout");
      return realWrite(p, ...(rest as [string]));
    };
    h.adapter.writeBinary = async (p, ...rest) => {
      if (p.endsWith("workspace.json")) throw new Error("SIMULATED app kill mid-checkout");
      return realWriteBinary(p, ...(rest as [ArrayBuffer]));
    };
    // mergeSafe may or may not reject depending on whether the excluded file is the only
    // checkout target; either way we assert the query result, not the merge outcome.
    await h.safeGit.mergeSafe().catch(() => {});
    h.adapter.write = realWrite;
    h.adapter.writeBinary = realWriteBinary;
    // Point HEAD at the remote so the excluded path is [head=1] regardless of merge outcome.
    await git.writeRef({ fs: h.fs, dir: h.dir, ref: "refs/heads/main", value: remoteOid, force: true });

    // The excluded [1,0,0] path must not surface — it is inert in both directions.
    expect(await h.safeGit.listInterruptedCheckouts()).toEqual([]);
  });

  /**
   * The critical safety test: a read failure during the scan must THROW, never
   * under-report. An under-report here would hide a file the user needs to recover,
   * silently dropping it from the recovery UI. listInterruptedCheckouts reuses
   * scanWorkingTree, so it inherits scanWorkingTree's read-failure refusal.
   */
  it("THROWS (does not return []) when a read failure is injected during the scan", async () => {
    const h = await interruptedFastForward("notes/c.md", "remote c\n");

    // Inject a transient read failure on the vault root: the whole scan is untrustworthy.
    h.adapter.failReadsAt("", "EIO");
    await expect(h.safeGit.listInterruptedCheckouts()).rejects.toThrow(/refusing to continue/i);
  });
});
