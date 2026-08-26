import { describe, it, expect } from "vitest";
import git from "isomorphic-git";
import { makeHarness, initRepo } from "../helpers/repo";

describe("SafeGit.decideConnect", () => {
  it("chooses clone-safe for a remote with content and no local notes", async () => {
    const h = await makeHarness();
    await h.write(".obsidian/app.json", "{}");
    const d = await h.safeGit.decideConnect({ remoteHasContent: true });
    expect(d.kind).toBe("clone-safe");
  });

  it("refuses when the remote has content and the vault already holds notes", async () => {
    const h = await makeHarness();
    await h.write("notes/mine.md", "existing\n");
    const d = await h.safeGit.decideConnect({ remoteHasContent: true });
    expect(d.kind).toBe("refuse");
    if (d.kind === "refuse") expect(d.reason).toMatch(/already contains notes/i);
  });

  it("chooses init-push for an empty remote", async () => {
    const h = await makeHarness();
    await h.write("notes/mine.md", "existing\n");
    const d = await h.safeGit.decideConnect({ remoteHasContent: false });
    expect(d.kind).toBe("init-push");
  });

  it("refuses to re-point a vault already connected to a different repo", async () => {
    const h = await makeHarness();
    await initRepo(h);
    await git.addRemote({
      fs: h.fs,
      dir: h.dir,
      remote: "origin",
      url: "https://github.com/other/other.git",
    });
    const d = await h.safeGit.decideConnect({ remoteHasContent: true });
    expect(d.kind).toBe("refuse");
    if (d.kind === "refuse") expect(d.reason).toMatch(/already connected/i);
  });

  it("allows reconnecting to the same repo", async () => {
    const h = await makeHarness();
    await initRepo(h);
    await git.addRemote({
      fs: h.fs,
      dir: h.dir,
      remote: "origin",
      url: "https://github.com/o/r.git",
    });
    const d = await h.safeGit.decideConnect({ remoteHasContent: true });
    expect(d.kind).toBe("reconnect");
  });

  it("reconnects when the stored remote omits the trailing .git", async () => {
    const h = await makeHarness();
    await initRepo(h);
    await git.addRemote({
      fs: h.fs,
      dir: h.dir,
      remote: "origin",
      url: "https://github.com/o/r",
    });
    const d = await h.safeGit.decideConnect({ remoteHasContent: true });
    expect(d.kind).toBe("reconnect");
  });
});

describe("SafeGit.push", () => {
  it("skips pushing when local is not ahead", async () => {
    const h = await makeHarness();
    const first = await initRepo(h);
    await git.writeRef({
      fs: h.fs,
      dir: h.dir,
      ref: "refs/remotes/origin/main",
      value: first,
      force: true,
    });
    // http throws if called, so a skip is proven by this not rejecting.
    await expect(h.safeGit.push()).resolves.toBe(false);
  });
});
