import { describe, it, expect } from "vitest";
import git from "isomorphic-git";
import { makeHarness, initRepo, setOriginRef } from "../helpers/repo";

describe("SafeGit.isRepo / hasLocalContent", () => {
  it("reports not-a-repo before init", async () => {
    const h = await makeHarness();
    expect(await h.safeGit.isRepo()).toBe(false);
  });

  it("reports a repo after init", async () => {
    const h = await makeHarness();
    await initRepo(h);
    expect(await h.safeGit.isRepo()).toBe(true);
  });

  it("treats a vault holding only excluded files as having no content", async () => {
    const h = await makeHarness();
    await h.write(".obsidian/app.json", "{}");
    await h.write(".obsidian/plugins/github-sync-mobile/data.json", "{}");
    expect(await h.safeGit.hasLocalContent()).toBe(false);
  });

  it("treats a vault holding a real note as having content", async () => {
    const h = await makeHarness();
    await h.write(".obsidian/app.json", "{}");
    await h.write("notes/a.md", "hello");
    expect(await h.safeGit.hasLocalContent()).toBe(true);
  });

  /**
   * The data-loss hazard hasLocalContent gates. If a transient read failure over a vault
   * that HAS notes made this return `false`, the connect flow would treat the vault as
   * empty and clone remote files over it. An unreadable folder is indistinguishable from
   * an empty one, so it must refuse — never answer `false` — when the fs bridge recorded a
   * read failure during the walk. One case per failing surface: root, subdir, file.
   */
  it("refuses (rather than reporting empty) when the vault root read fails", async () => {
    const h = await makeHarness();
    await h.write("notes/a.md", "a");
    await h.write("notes/b.md", "b");
    h.adapter.failReadsAt("", "EIO");
    await expect(h.safeGit.hasLocalContent()).rejects.toThrow(/refusing to continue/i);
  });

  it("refuses (rather than reporting empty) when a subdirectory read fails", async () => {
    const h = await makeHarness();
    await h.write("notes/a.md", "a");
    await h.write("notes/b.md", "b");
    h.adapter.failReadsAt("notes", "EIO");
    await expect(h.safeGit.hasLocalContent()).rejects.toThrow(/refusing to continue/i);
  });

  it("refuses (rather than reporting empty) when a top-level file read fails", async () => {
    const h = await makeHarness();
    await h.write("top.md", "x");
    h.adapter.failReadsAt("top.md", "EIO");
    await expect(h.safeGit.hasLocalContent()).rejects.toThrow(/refusing to continue/i);
  });
});

describe("SafeGit.status", () => {
  it("lists a modified non-excluded file as changed", async () => {
    const h = await makeHarness();
    await initRepo(h);
    await h.write("notes/a.md", "changed\n");
    const s = await h.safeGit.status();
    expect(s.changed).toEqual(["notes/a.md"]);
  });

  it("lists a new non-excluded file as changed", async () => {
    const h = await makeHarness();
    await initRepo(h);
    await h.write("notes/new.md", "new\n");
    const s = await h.safeGit.status();
    expect(s.changed).toContain("notes/new.md");
  });

  it("ignores changes inside excluded paths", async () => {
    const h = await makeHarness();
    await initRepo(h);
    await h.write(".obsidian/app.json", "{}");
    const s = await h.safeGit.status();
    expect(s.changed).toEqual([]);
  });

  // The phantom-deletion trap: the remote already tracks .obsidian/*, we never
  // check those files out, so a naive status would call them deletions and push
  // the removal — wiping them from the cloud.
  it("does not report an excluded file tracked in HEAD but absent on disk as a deletion", async () => {
    const h = await makeHarness();
    await git.init({ fs: h.fs, dir: h.dir, defaultBranch: "main" });
    await h.write("notes/a.md", "a\n");
    await h.write(".obsidian/app.json", "{}");
    await h.commit(["notes/a.md", ".obsidian/app.json"], "tracks obsidian config");
    // Simulate clone-safe: the excluded file is in HEAD but never written to disk.
    await h.adapter.remove(".obsidian/app.json");

    const s = await h.safeGit.status();
    expect(s.changed).toEqual([]);
  });

  /**
   * The guard for a hazard the git layer cannot see. isomorphic-git's readdir reports any
   * read failure other than ENOTDIR as an EMPTY directory, so a transient failure makes
   * every file beneath look deleted while the files are still on disk. Committing that
   * would push a deletion of files that exist.
   */
  it("refuses to report a status when a directory read failed", async () => {
    const h = await makeHarness();
    await initRepo(h);
    h.adapter.failReadsAt("notes", "EIO");

    await expect(h.safeGit.status()).rejects.toThrow(/refusing to continue/i);

    h.adapter.clearReadFailures();
    expect((await h.safeGit.status()).changed).toEqual([]);
  });

  /**
   * The subtler half of the read-failure guard, and the half the subdir test above does
   * NOT exercise. A subdir read failure makes isomorphic-git's statusMatrix THROW, which
   * is caught by scanWorkingTree's try/catch — a different guard. A read failure at the
   * vault ROOT is different: statusMatrix RETURNS (verified: it yields a phantom
   * `["notes/a.md", 1, 0, 1]` workdir===0 deletion row for a file still on disk) while the
   * fs bridge records the root read in `readFailures`. Only the `readFailures.length > 0`
   * check catches this; the try/catch never fires because nothing threw. Without this test
   * the readFailures guard survives mutation, since the subdir test is satisfied by the
   * try/catch path alone.
   */
  it("refuses a status when the vault ROOT read fails (statusMatrix returns a phantom deletion)", async () => {
    const h = await makeHarness();
    await initRepo(h);
    h.adapter.failReadsAt("", "EIO");

    await expect(h.safeGit.status()).rejects.toThrow(/refusing to continue/i);

    h.adapter.clearReadFailures();
    expect((await h.safeGit.status()).changed).toEqual([]);
  });

  it("refuses to commit a deletion for a file that is still on disk", async () => {
    const h = await makeHarness();
    await initRepo(h);
    // The file is present, but the scan will claim it is gone.
    h.adapter.failReadsAt("notes", "EIO");
    await expect(h.safeGit.commitLocal("sync")).rejects.toThrow(/nothing was changed/i);
    h.adapter.clearReadFailures();
    expect(await h.adapter.read("notes/a.md")).toBe("first\n");
  });

  it("reports a genuine deletion of a non-excluded file", async () => {
    const h = await makeHarness();
    await initRepo(h);
    await h.adapter.remove("notes/a.md");
    const s = await h.safeGit.status();
    expect(s.changed).toEqual(["notes/a.md"]);
  });

  it("computes ahead and behind against the remote-tracking ref", async () => {
    const h = await makeHarness();
    const first = await initRepo(h);
    await setOriginRef(h, first);
    await h.write("notes/b.md", "b\n");
    await h.commit(["notes/b.md"], "second");

    const s = await h.safeGit.status();
    expect(s.ahead).toBe(1);
    expect(s.behind).toBe(0);
  });

  it("reports zero ahead and behind when in sync", async () => {
    const h = await makeHarness();
    const first = await initRepo(h);
    await setOriginRef(h, first);
    const s = await h.safeGit.status();
    expect(s.ahead).toBe(0);
    expect(s.behind).toBe(0);
  });
});
