import { describe, it, expect } from "vitest";
import git from "isomorphic-git";
import { makeHarness, initRepo } from "../helpers/repo";

describe("SafeGit.commitLocal", () => {
  it("commits a modified file and returns the new oid", async () => {
    const h = await makeHarness();
    const first = await initRepo(h);
    await h.write("notes/a.md", "changed\n");

    const oid = await h.safeGit.commitLocal("sync");
    expect(oid).not.toBeNull();
    expect(oid).not.toBe(first);

    const head = await git.resolveRef({ fs: h.fs, dir: h.dir, ref: "HEAD" });
    expect(head).toBe(oid);
  });

  it("commits a newly added file", async () => {
    const h = await makeHarness();
    await initRepo(h);
    await h.write("notes/new.md", "new\n");
    await h.safeGit.commitLocal("sync");

    const files = await git.listFiles({ fs: h.fs, dir: h.dir, ref: "HEAD" });
    expect(files).toContain("notes/new.md");
  });

  it("commits a deletion of a tracked file", async () => {
    const h = await makeHarness();
    await initRepo(h);
    await h.adapter.remove("notes/a.md");
    await h.safeGit.commitLocal("sync");

    const files = await git.listFiles({ fs: h.fs, dir: h.dir, ref: "HEAD" });
    expect(files).not.toContain("notes/a.md");
  });

  it("returns null and creates no commit when nothing changed", async () => {
    const h = await makeHarness();
    const first = await initRepo(h);

    expect(await h.safeGit.commitLocal("sync")).toBeNull();
    const head = await git.resolveRef({ fs: h.fs, dir: h.dir, ref: "HEAD" });
    expect(head).toBe(first);
  });

  it("never stages an excluded file", async () => {
    const h = await makeHarness();
    await initRepo(h);
    await h.write(".obsidian/app.json", "{}");
    await h.write("notes/a.md", "changed\n");
    await h.safeGit.commitLocal("sync");

    const files = await git.listFiles({ fs: h.fs, dir: h.dir, ref: "HEAD" });
    expect(files).not.toContain(".obsidian/app.json");
    expect(files).toContain("notes/a.md");
  });

  it("does not create a commit when only excluded files changed", async () => {
    const h = await makeHarness();
    const first = await initRepo(h);
    await h.write(".obsidian/app.json", "{}");

    expect(await h.safeGit.commitLocal("sync")).toBeNull();
    const head = await git.resolveRef({ fs: h.fs, dir: h.dir, ref: "HEAD" });
    expect(head).toBe(first);
  });

  /**
   * Pins `commitLocal`'s belt-and-braces `stillOnDisk` guard in ISOLATION from
   * scanWorkingTree's readFailures guard.
   *
   * The guard defends the case its comment names: a `workdir === 0` row for a file that is
   * actually present, arising from a directory-read failure that was *swallowed* — one
   * that left NO entry in `readFailures`. Every `failReadsAt` injection records into
   * `readFailures` (proven by probing: a root injection makes statusMatrix RETURN a
   * phantom `["notes/a.md",1,0,1]` row but always records `""`, and a subdir injection
   * makes statusMatrix THROW), so scanWorkingTree's readFailures/try-catch guards always
   * fire first and the phantom row never reaches the commit loop. That means no
   * `failReadsAt` case can pin `stillOnDisk` — the phantom row cannot reach the loop while
   * readFailures is populated.
   *
   * So we reproduce the true swallowed-failure shape directly: a `list` that omits a file
   * `stat` still finds, with nothing recorded in readFailures. statusMatrix then returns
   * workdir===0 for a present file, readFailures stays empty, scanWorkingTree's guard
   * passes, and the phantom row reaches the loop where `stillOnDisk` is the ONLY guard
   * standing between it and a staged deletion of a file that exists.
   */
  it("refuses to commit a phantom deletion (present file) that scanWorkingTree's channel did not catch", async () => {
    const h = await makeHarness();
    await initRepo(h); // commits notes/a.md; the file stays on disk

    // A silently-lossy listing: notes/a.md is dropped from the directory listing while
    // stat still reports it present. No throw, so nothing is recorded in readFailures --
    // exactly the swallowed failure stillOnDisk exists for.
    const realList = h.adapter.list.bind(h.adapter);
    (h.adapter as unknown as { list: typeof h.adapter.list }).list = async (p: string) => {
      const r = await realList(p);
      return { files: r.files.filter((f) => f !== "notes/a.md"), folders: r.folders };
    };

    await expect(h.safeGit.commitLocal("sync")).rejects.toThrow(/still present/i);

    // The tree is untouched: the file is still committed in HEAD, no deletion was staged.
    (h.adapter as unknown as { list: typeof h.adapter.list }).list = realList;
    const files = await git.listFiles({ fs: h.fs, dir: h.dir, ref: "HEAD" });
    expect(files).toContain("notes/a.md");
  });

  it("keeps an excluded file tracked in HEAD rather than committing its removal", async () => {
    const h = await makeHarness();
    await git.init({ fs: h.fs, dir: h.dir, defaultBranch: "main" });
    await h.write("notes/a.md", "a\n");
    await h.write(".obsidian/app.json", "{}");
    await h.commit(["notes/a.md", ".obsidian/app.json"], "tracks config");
    await h.adapter.remove(".obsidian/app.json");
    await h.write("notes/a.md", "changed\n");

    await h.safeGit.commitLocal("sync");

    const files = await git.listFiles({ fs: h.fs, dir: h.dir, ref: "HEAD" });
    expect(files).toContain(".obsidian/app.json");
  });
});
