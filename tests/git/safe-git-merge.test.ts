import { describe, it, expect } from "vitest";
import git from "isomorphic-git";
import { makeHarness, initRepo, setOriginRef, divergeRemote, type Harness } from "../helpers/repo";
import { COMMIT_AUTHOR } from "../../src/constants";

describe("SafeGit.mergeSafe", () => {
  it("reports up-to-date when local and remote match", async () => {
    const h = await makeHarness();
    const first = await initRepo(h);
    await setOriginRef(h, first);
    expect((await h.safeGit.mergeSafe()).kind).toBe("up-to-date");
  });

  it("reports up-to-date when there is no remote ref yet", async () => {
    const h = await makeHarness();
    await initRepo(h);
    expect((await h.safeGit.mergeSafe()).kind).toBe("up-to-date");
  });

  it("fast-forwards when local is strictly behind", async () => {
    const h = await makeHarness();
    const first = await initRepo(h);
    const remoteOid = await divergeRemote(h, first, { "notes/remote.md": "r\n" }, "remote work");
    // Local is still at `first`, so this is a pure fast-forward.
    await git.writeRef({ fs: h.fs, dir: h.dir, ref: "refs/heads/main", value: first, force: true });

    const out = await h.safeGit.mergeSafe();
    expect(out.kind).toBe("fast-forward");
    const head = await git.resolveRef({ fs: h.fs, dir: h.dir, ref: "HEAD" });
    expect(head).toBe(remoteOid);
    expect(await h.adapter.read("notes/remote.md")).toBe("r\n");
  });

  it("does not write excluded paths during a fast-forward", async () => {
    const h = await makeHarness();
    const first = await initRepo(h);
    await divergeRemote(h, first, { ".obsidian/app.json": "{\"remote\":true}" }, "remote config");
    await git.writeRef({ fs: h.fs, dir: h.dir, ref: "refs/heads/main", value: first, force: true });

    // The setup wrote this file to disk in order to commit it on the remote
    // lineage. Clear it so the assertion below genuinely proves mergeSafe did
    // not materialise it, rather than passing on a leftover from setup.
    if (h.adapter.paths().includes(".obsidian/app.json")) {
      await h.adapter.remove(".obsidian/app.json");
    }

    const out = await h.safeGit.mergeSafe();
    expect(out.kind).toBe("fast-forward");
    expect(h.adapter.paths()).not.toContain(".obsidian/app.json");
    // The remote still tracks it, so it must remain in history.
    const tracked = await git.listFiles({ fs: h.fs, dir: h.dir, ref: "HEAD" });
    expect(tracked).toContain(".obsidian/app.json");
  });

  it("creates a merge commit when both sides changed different files", async () => {
    const h = await makeHarness();
    const first = await initRepo(h);
    await h.write("notes/local.md", "l\n");
    await h.commit(["notes/local.md"], "local work");
    await divergeRemote(h, first, { "notes/remote.md": "r\n" }, "remote work");

    const out = await h.safeGit.mergeSafe();
    expect(out.kind).toBe("merged");
    expect(await h.adapter.read("notes/local.md")).toBe("l\n");
    expect(await h.adapter.read("notes/remote.md")).toBe("r\n");
  });

  it("reports a conflict and leaves the working tree untouched when both sides changed the same file", async () => {
    const h = await makeHarness();
    const first = await initRepo(h);
    await h.write("notes/a.md", "local version\n");
    const localOid = await h.commit(["notes/a.md"], "local edit");
    await divergeRemote(h, first, { "notes/a.md": "remote version\n" }, "remote edit");

    const before = await h.adapter.read("notes/a.md");
    const out = await h.safeGit.mergeSafe();

    expect(out.kind).toBe("conflict");
    if (out.kind === "conflict") {
      expect(out.files.map((f) => f.path)).toContain("notes/a.md");
    }
    // Nothing written, no conflict markers, HEAD unmoved.
    expect(await h.adapter.read("notes/a.md")).toBe(before);
    expect(await h.adapter.read("notes/a.md")).not.toContain("<<<<<<<");
    expect(await git.resolveRef({ fs: h.fs, dir: h.dir, ref: "HEAD" })).toBe(localOid);
  });

  it("surfaces both sides' content in the conflict report", async () => {
    const h = await makeHarness();
    const first = await initRepo(h);
    await h.write("notes/a.md", "local version\n");
    await h.commit(["notes/a.md"], "local edit");
    await divergeRemote(h, first, { "notes/a.md": "remote version\n" }, "remote edit");

    const out = await h.safeGit.mergeSafe();
    if (out.kind !== "conflict") throw new Error("expected conflict");
    const f = out.files.find((x) => x.path === "notes/a.md")!;
    expect(f.ours).toEqual({ state: "text", content: "local version\n" });
    expect(f.theirs).toEqual({ state: "text", content: "remote version\n" });
  });

  /**
   * The test that pins the binary pre-screen.
   *
   * The attachment exists at the merge base and is edited in two well-separated
   * regions, so isomorphic-git's three-way merge finds them separable and reports a
   * CLEAN merge — corrupting the file silently and never asking. Deleting the
   * pre-screen makes this test fail; the add/add cases below still pass without it,
   * because there the engine raises a conflict on its own.
   */
  it("refuses to let the engine merge a binary changed on both sides", async () => {
    const h = await makeHarness();

    // Newline-separated so diff3 sees distinct regions, with invalid UTF-8 in each.
    const row = (n: number) => [0x89, 0xff, 0xfe, n, 0x0a];
    const baseBytes = new Uint8Array(
      Array.from({ length: 40 }, (_, i) => row(i)).flat(),
    );
    await git.init({ fs: h.fs, dir: h.dir, defaultBranch: "main" });
    await h.write("notes/a.md", "first\n");
    await h.adapter.writeBinary("img.png", baseBytes.slice().buffer);
    const base = await h.commit(["notes/a.md", "img.png"], "base with attachment");

    const ourBytes = baseBytes.slice();
    ourBytes[3] = 0x01; // edit near the start
    await h.adapter.writeBinary("img.png", ourBytes.slice().buffer);
    const localOid = await h.commit(["img.png"], "local edits the attachment");

    const theirBytes = baseBytes.slice();
    theirBytes[baseBytes.length - 2] = 0x02; // edit near the end
    await divergeRemote(h, base, {}, "remote edits the attachment", async () => {
      await h.adapter.writeBinary("img.png", theirBytes.slice().buffer);
      await git.add({ fs: h.fs, dir: h.dir, filepath: "img.png" });
    });

    const out = await h.safeGit.mergeSafe();

    // Without the pre-screen this is `merged`, with a corrupted blob committed.
    expect(out.kind).toBe("conflict");
    expect(await git.resolveRef({ fs: h.fs, dir: h.dir, ref: "HEAD" })).toBe(localOid);
    const onDisk = new Uint8Array(await h.adapter.readBinary("img.png"));
    expect(Array.from(onDisk)).toEqual(Array.from(ourBytes));
  });

  // A conflicting attachment must survive resolution byte-for-byte. Carrying it
  // as a string would replace every invalid UTF-8 byte with U+FFFD and commit the
  // damage, which is the failure this plugin exists to prevent.
  it("reports a conflicting binary file as bytes, not as text", async () => {
    const h = await makeHarness();
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe]);
    const first = await initRepo(h);
    await h.adapter.writeBinary("img.png", png.slice().buffer);
    await h.commit(["img.png"], "local binary");

    const other = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
    await divergeRemote(h, first, {}, "remote binary", async () => {
      await h.adapter.writeBinary("img.png", other.slice().buffer);
      await git.add({ fs: h.fs, dir: h.dir, filepath: "img.png" });
    });

    const out = await h.safeGit.mergeSafe();
    if (out.kind !== "conflict") throw new Error("expected conflict");
    const f = out.files.find((x) => x.path === "img.png")!;
    expect(f.ours.state).toBe("binary");
    expect(f.theirs.state).toBe("binary");
    if (f.ours.state === "binary") expect(Array.from(f.ours.bytes)).toEqual(Array.from(png));
  });

  it("treats unrelated histories as a conflict rather than crashing", async () => {
    const h = await makeHarness();
    await initRepo(h);
    // An orphan commit with no shared ancestry.
    const tree = await git.writeTree({ fs: h.fs, dir: h.dir, tree: [] });
    const orphan = await git.writeCommit({
      fs: h.fs,
      dir: h.dir,
      commit: {
        tree,
        parent: [],
        message: "unrelated root\n",
        author: { ...COMMIT_AUTHOR, timestamp: 1, timezoneOffset: 0 },
        committer: { ...COMMIT_AUTHOR, timestamp: 1, timezoneOffset: 0 },
      },
    });
    await setOriginRef(h, orphan);

    const out = await h.safeGit.mergeSafe();
    expect(out.kind).toBe("unmergeable");
    if (out.kind === "unmergeable") expect(out.reason).toBe("unrelated-histories");
  });

  it("does not report a conflict for changes confined to excluded paths", async () => {
    const h = await makeHarness();
    const first = await initRepo(h);
    await h.write(".obsidian/app.json", "{\"local\":true}");
    await h.commit(["notes/a.md"], "local touch");
    await divergeRemote(h, first, { ".obsidian/app.json": "{\"remote\":true}" }, "remote config");

    const out = await h.safeGit.mergeSafe();
    expect(out.kind).not.toBe("conflict");
  });

  /**
   * Pins invariant 10: an EXCLUDED binary changed on both sides still gates the engine.
   *
   * `anyBinary` deliberately iterates the raw paths, NOT `withoutExcluded(paths)` —
   * "don't sync this" must not become "corrupt this silently". An excluded binary
   * (here `.obsidian/theme.bin`) changed on both sides would otherwise be run through
   * iso-git's lossy UTF-8 decode/re-encode merge, which usually reports a CLEAN merge
   * and pushes a corrupted blob. This is like the "refuses to let the engine merge a
   * binary changed on both sides" test above, except the path is excluded.
   *
   * A mutation making `anyBinary` filter excluded paths returns `merged` here; with the
   * raw-path iteration in place the binary gates the engine and this returns `conflict`.
   */
  it("still gates the engine when an EXCLUDED binary changed on both sides", async () => {
    const h = await makeHarness();

    // Newline-separated so diff3 sees distinct regions, with invalid UTF-8 in each.
    const row = (n: number) => [0x89, 0xff, 0xfe, n, 0x0a];
    const baseBytes = new Uint8Array(
      Array.from({ length: 40 }, (_, i) => row(i)).flat(),
    );
    await git.init({ fs: h.fs, dir: h.dir, defaultBranch: "main" });
    await h.write("notes/a.md", "first\n");
    // writeBinary does not invent parent folders (the adapter mirrors the real one).
    await h.adapter.mkdir(".obsidian");
    await h.adapter.writeBinary(".obsidian/theme.bin", baseBytes.slice().buffer);
    const base = await h.commit(["notes/a.md", ".obsidian/theme.bin"], "base with excluded attachment");

    const ourBytes = baseBytes.slice();
    ourBytes[3] = 0x01; // edit near the start
    await h.adapter.writeBinary(".obsidian/theme.bin", ourBytes.slice().buffer);
    await h.commit([".obsidian/theme.bin"], "local edits the excluded attachment");

    const theirBytes = baseBytes.slice();
    theirBytes[baseBytes.length - 2] = 0x02; // edit near the end
    await divergeRemote(h, base, {}, "remote edits the excluded attachment", async () => {
      await h.adapter.writeBinary(".obsidian/theme.bin", theirBytes.slice().buffer);
      await git.add({ fs: h.fs, dir: h.dir, filepath: ".obsidian/theme.bin" });
    });

    const out = await h.safeGit.mergeSafe();

    // The binary gates the engine even though the path is excluded: not `merged`.
    expect(out.kind).not.toBe("merged");
    expect(out.kind).toBe("conflict");
  });

  /**
   * Pins invariant 3: `checkoutTracked` uses `force: false` — the exact call the
   * predecessor plugin used with force, destroying the author's uncommitted notes.
   *
   * Setup is a pure fast-forward (local strictly behind remote). Before merging we
   * write UNCOMMITTED local content at `notes/remote.md`, the very path the incoming
   * remote commit creates, so `checkout` collides.
   *
   * Observed behavior (empirically): the ref moves first (fastForwardTo writes it),
   * then the non-force checkout throws `CheckoutConflictError` rather than
   * clobbering — so `mergeSafe` THROWS. The load-bearing assertion is that the
   * colliding local content is byte-identical afterwards: `force:false` refused to
   * overwrite it. Flipping to `force:true` clobbers it with the remote version.
   */
  it("preserves uncommitted local content on a fast-forward checkout collision", async () => {
    const h = await makeHarness();
    const first = await initRepo(h);
    await divergeRemote(h, first, { "notes/remote.md": "REMOTE\n" }, "remote work");
    // Local is still at `first`, so this would be a pure fast-forward.
    await git.writeRef({ fs: h.fs, dir: h.dir, ref: "refs/heads/main", value: first, force: true });

    // divergeRemote left the remote version on disk; clear it, then write the
    // uncommitted local version at the same path the incoming commit creates.
    if (h.adapter.paths().includes("notes/remote.md")) {
      await h.adapter.remove("notes/remote.md");
    }
    await h.write("notes/remote.md", "LOCAL UNCOMMITTED\n");

    // The checkout collides on this path; force:false makes it throw rather than clobber.
    await expect(h.safeGit.mergeSafe()).rejects.toThrow();

    // The essential, non-lossy assertion: the local content survived byte-for-byte.
    expect(await h.adapter.read("notes/remote.md")).toBe("LOCAL UNCOMMITTED\n");
  });

  /**
   * Pins F3: a file-vs-directory type change is a structured `unmergeable`, not an
   * uncaught throw. `x` is a file at base+local and a directory (`x/inner.md`) on the
   * remote side. iso-git throws MergeNotSupportedError at the dry-run (nothing
   * written); mergeSafe converts it to `{kind:"unmergeable", reason:"type-change"}`.
   * Removing the type-change catch turns this back into an uncaught throw.
   */
  it("reports a file-vs-directory type change as unmergeable, writing nothing", async () => {
    const h = await makeHarness();
    const first = await initRepo(h);

    // base + local: `x` is a FILE.
    await h.write("x", "file content\n");
    const localOid = await h.commit(["x"], "local: x is a file");

    // remote lineage: `x` is a DIRECTORY (x/inner.md).
    await divergeRemote(h, first, {}, "remote: x becomes a directory", async () => {
      await git.remove({ fs: h.fs, dir: h.dir, filepath: "x" });
      await h.write("x/inner.md", "inner\n");
      await git.add({ fs: h.fs, dir: h.dir, filepath: "x/inner.md" });
    });

    // The `divergeRemote` scaffolding force-checks-out between lineages, and it
    // cannot place a file `x` where the directory `x/` was just created on disk, so
    // the working-tree state of `x` after setup is an artefact of the harness, not of
    // mergeSafe. Snapshot the tree so we assert mergeSafe itself wrote nothing.
    const before = h.adapter.snapshot();
    const out = await h.safeGit.mergeSafe();

    expect(out.kind).toBe("unmergeable");
    if (out.kind === "unmergeable") expect(out.reason).toBe("type-change");
    // Loud, non-lossy: HEAD unmoved and mergeSafe touched nothing on disk. The throw
    // was at the dry-run stage, so the remote's `x/inner.md` was never materialised.
    expect(await git.resolveRef({ fs: h.fs, dir: h.dir, ref: "HEAD" })).toBe(localOid);
    expect(h.adapter.snapshot()).toEqual(before);
    expect(h.adapter.paths()).not.toContain("x/inner.md");
  });
});

// Invariant 8: iOS can suspend or kill the app mid-operation, so re-running
// from any state must be safe. These prove repeatability rather than a one-shot
// happy path.
describe("SafeGit idempotency", () => {
  it("is a no-op when mergeSafe runs twice after a fast-forward", async () => {
    const h = await makeHarness();
    const first = await initRepo(h);
    const remoteOid = await divergeRemote(h, first, { "notes/remote.md": "r\n" }, "remote work");
    await git.writeRef({ fs: h.fs, dir: h.dir, ref: "refs/heads/main", value: first, force: true });

    expect((await h.safeGit.mergeSafe()).kind).toBe("fast-forward");
    expect((await h.safeGit.mergeSafe()).kind).toBe("up-to-date");
    expect(await git.resolveRef({ fs: h.fs, dir: h.dir, ref: "HEAD" })).toBe(remoteOid);
  });

  it("reports the same conflict on a repeated mergeSafe without writing anything", async () => {
    const h = await makeHarness();
    const first = await initRepo(h);
    await h.write("notes/a.md", "local version\n");
    const localOid = await h.commit(["notes/a.md"], "local edit");
    await divergeRemote(h, first, { "notes/a.md": "remote version\n" }, "remote edit");

    const one = await h.safeGit.mergeSafe();
    const two = await h.safeGit.mergeSafe();

    expect(one.kind).toBe("conflict");
    expect(two.kind).toBe("conflict");
    expect(await h.adapter.read("notes/a.md")).toBe("local version\n");
    expect(await git.resolveRef({ fs: h.fs, dir: h.dir, ref: "HEAD" })).toBe(localOid);
  });

  it("creates no second commit when commitLocal runs twice", async () => {
    const h = await makeHarness();
    await initRepo(h);
    await h.write("notes/a.md", "changed\n");

    const firstOid = await h.safeGit.commitLocal("sync");
    expect(firstOid).not.toBeNull();
    expect(await h.safeGit.commitLocal("sync")).toBeNull();

    expect(await git.resolveRef({ fs: h.fs, dir: h.dir, ref: "HEAD" })).toBe(firstOid);
  });

  /**
   * Invariant 8, at the sequence level. If iOS kills the app after a fast-forward advanced
   * the branch ref but before the working tree was materialised, HEAD tracks a remote-added
   * file that was never written to disk. On the next sync, commitLocal must NOT read that as
   * a user deletion and commit its removal — doing so would push the file's deletion and
   * destroy it on the remote. The state is `[head=1, workdir=0, stage=0]`; a genuine deletion
   * is `[1,0,1]` (the index still holds it). Reproduced by driving the real mergeSafe
   * fast-forward and killing the adapter write of the incoming file.
   */
  it("refuses to commit a deletion for a remote-added file left unmaterialised by an interrupted fast-forward", async () => {
    const h = await makeHarness();
    const first = await initRepo(h);
    const remoteOid = await divergeRemote(h, first, { "notes/c.md": "remote c\n" }, "remote adds c");

    // Local is behind at `first`, so mergeSafe will fast-forward.
    await git.writeRef({ fs: h.fs, dir: h.dir, ref: "refs/heads/main", value: first, force: true });
    await git.checkout({ fs: h.fs, dir: h.dir, ref: "main", force: true });
    if (h.adapter.paths().includes("notes/c.md")) await h.adapter.remove("notes/c.md");

    // Simulate the iOS kill: the fast-forward advances the ref (writeRef), then the checkout
    // fails while trying to write the incoming file.
    const realWrite = h.adapter.write.bind(h.adapter);
    const realWriteBinary = h.adapter.writeBinary.bind(h.adapter);
    h.adapter.write = async (p, ...rest) => {
      if (p.endsWith("c.md")) throw new Error("SIMULATED app kill mid-checkout");
      return realWrite(p, ...(rest as [string]));
    };
    h.adapter.writeBinary = async (p, ...rest) => {
      if (p.endsWith("c.md")) throw new Error("SIMULATED app kill mid-checkout");
      return realWriteBinary(p, ...(rest as [ArrayBuffer]));
    };
    await expect(h.safeGit.mergeSafe()).rejects.toBeTruthy();
    h.adapter.write = realWrite;
    h.adapter.writeBinary = realWriteBinary;

    // The interrupted state: ref advanced to remote, c.md not on disk.
    expect(await git.resolveRef({ fs: h.fs, dir: h.dir, ref: "HEAD" })).toBe(remoteOid);
    expect(h.adapter.paths()).not.toContain("notes/c.md");

    // The resync commit must REFUSE rather than delete the still-remote-tracked file.
    await expect(h.safeGit.commitLocal("sync")).rejects.toThrow(/ambiguous, resolvable/i);

    // notes/c.md is still tracked in HEAD — its deletion was not committed.
    const tracked = await git.listFiles({ fs: h.fs, dir: h.dir, ref: "HEAD" });
    expect(tracked).toContain("notes/c.md");
  });

  /**
   * The escape hatch for the interrupted-INCOMING half of the ambiguous [1,0,0] state.
   *
   * Same interrupted fast-forward as the test above leaves notes/c.md as [head=1,
   * workdir=0, stage=0]: HEAD tracks the remote-added file, the working tree never got it.
   * commitLocal refuses (proven above). `restoreFromHead(["notes/c.md"])` repairs the
   * interrupted checkout by materialising the file back onto disk from HEAD, after which a
   * following commitLocal does NOT throw and does NOT delete it — the file is back and
   * still tracked.
   */
  it("restoreFromHead recovers a remote-added file left unmaterialised by an interrupted fast-forward", async () => {
    const h = await makeHarness();
    const first = await initRepo(h);
    const remoteOid = await divergeRemote(h, first, { "notes/c.md": "remote c\n" }, "remote adds c");

    await git.writeRef({ fs: h.fs, dir: h.dir, ref: "refs/heads/main", value: first, force: true });
    await git.checkout({ fs: h.fs, dir: h.dir, ref: "main", force: true });
    if (h.adapter.paths().includes("notes/c.md")) await h.adapter.remove("notes/c.md");

    const realWrite = h.adapter.write.bind(h.adapter);
    const realWriteBinary = h.adapter.writeBinary.bind(h.adapter);
    h.adapter.write = async (p, ...rest) => {
      if (p.endsWith("c.md")) throw new Error("SIMULATED app kill mid-checkout");
      return realWrite(p, ...(rest as [string]));
    };
    h.adapter.writeBinary = async (p, ...rest) => {
      if (p.endsWith("c.md")) throw new Error("SIMULATED app kill mid-checkout");
      return realWriteBinary(p, ...(rest as [ArrayBuffer]));
    };
    await expect(h.safeGit.mergeSafe()).rejects.toBeTruthy();
    h.adapter.write = realWrite;
    h.adapter.writeBinary = realWriteBinary;

    // Interrupted-incoming state: ref advanced, file absent, commitLocal refuses.
    expect(await git.resolveRef({ fs: h.fs, dir: h.dir, ref: "HEAD" })).toBe(remoteOid);
    expect(h.adapter.paths()).not.toContain("notes/c.md");
    await expect(h.safeGit.commitLocal("sync")).rejects.toThrow(/ambiguous, resolvable/i);

    // Recover: materialise the interrupted download back onto disk from HEAD.
    await h.safeGit.restoreFromHead(["notes/c.md"]);
    expect(await h.adapter.read("notes/c.md")).toBe("remote c\n");

    // A following commitLocal now sees nothing to delete: no throw, HEAD unmoved,
    // notes/c.md still tracked.
    expect(await h.safeGit.commitLocal("sync")).toBeNull();
    expect(await git.resolveRef({ fs: h.fs, dir: h.dir, ref: "HEAD" })).toBe(remoteOid);
    const tracked = await git.listFiles({ fs: h.fs, dir: h.dir, ref: "HEAD" });
    expect(tracked).toContain("notes/c.md");
  });

  /**
   * The critical regression test: the user is NOT permanently stranded on a genuine
   * interrupted OUTGOING deletion.
   *
   * The user deletes notes/a.md; commitLocal's flow runs `git.remove` (stage -> 0), then
   * the app is killed before `git.commit`. That leaves notes/a.md as [head=1, workdir=0,
   * stage=0] — byte-identical to the interrupted-incoming case, and undecidable by git
   * alone. commitLocal refuses by default (never guess). Then `confirmDeletion` completes
   * the deletion the guard blocked, so the user is no longer stranded: notes/a.md is gone
   * from the new HEAD tree.
   */
  it("confirmDeletion completes a genuine interrupted-outgoing deletion so the user is not stranded", async () => {
    const h = await makeHarness();
    await initRepo(h); // commits notes/a.md

    // The user deletes notes/a.md from disk, the commit flow stages the removal
    // (git.remove -> stage 0), then the app is killed before git.commit. Reproduce the
    // resulting [1,0,0] state directly.
    await h.adapter.remove("notes/a.md");
    await git.remove({ fs: h.fs, dir: h.dir, filepath: "notes/a.md" });

    // commitLocal refuses by default — the [1,0,0] row is ambiguous.
    await expect(h.safeGit.commitLocal("sync")).rejects.toThrow(/ambiguous, resolvable/i);
    // Still tracked: nothing was committed.
    expect(await git.listFiles({ fs: h.fs, dir: h.dir, ref: "HEAD" })).toContain("notes/a.md");

    // The user confirms the deletion; confirmDeletion completes it.
    const oid = await h.safeGit.confirmDeletion(["notes/a.md"], "sync");
    expect(oid).not.toBeNull();
    expect(await git.resolveRef({ fs: h.fs, dir: h.dir, ref: "HEAD" })).toBe(oid);

    // notes/a.md is absent from the new HEAD tree — the deletion is real and durable.
    const tracked = await git.listFiles({ fs: h.fs, dir: h.dir, ref: "HEAD" });
    expect(tracked).not.toContain("notes/a.md");
  });

  /**
   * confirmDeletion must NOT bypass the read-failure safety: a path still present on disk
   * is refused, never deleted, because a "deleted" file that is actually there may be a
   * swallowed read failure. This is the same stance commitLocal's `stillOnDisk` guard takes.
   */
  it("confirmDeletion refuses to delete a path that is still present on disk", async () => {
    const h = await makeHarness();
    await initRepo(h); // notes/a.md is committed and still on disk

    await expect(h.safeGit.confirmDeletion(["notes/a.md"], "sync")).rejects.toThrow(/still present/i);

    // Nothing committed: notes/a.md still tracked.
    const tracked = await git.listFiles({ fs: h.fs, dir: h.dir, ref: "HEAD" });
    expect(tracked).toContain("notes/a.md");
  });
});
