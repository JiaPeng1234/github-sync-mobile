import { describe, it, expect } from "vitest";
import git from "isomorphic-git";
import { makeHarness, initRepo, setOriginRef, divergeRemote, type Harness } from "../helpers/repo";
import { isPathAbsent } from "../../src/git/safe-git";
import { COMMIT_AUTHOR } from "../../src/constants";

const FULL_OID = "0123456789abcdef0123456789abcdef01234567";
const OTHER_OID = "89abcdef0123456789abcdef0123456789abcdef";

function notFound(what: string) {
  return { code: "NotFoundError", data: { what } };
}

async function conflicted(h: Harness) {
  const first = await initRepo(h);
  await h.write("notes/a.md", "local version\n");
  await h.commit(["notes/a.md"], "local edit");

  await git.writeRef({ fs: h.fs, dir: h.dir, ref: "refs/heads/tmp", value: first, force: true });
  const localHead = await git.resolveRef({ fs: h.fs, dir: h.dir, ref: "refs/heads/main" });
  await git.writeRef({ fs: h.fs, dir: h.dir, ref: "refs/heads/main", value: first, force: true });
  await git.checkout({ fs: h.fs, dir: h.dir, ref: "main", force: true });
  await h.write("notes/a.md", "remote version\n");
  await git.add({ fs: h.fs, dir: h.dir, filepath: "notes/a.md" });
  const remoteOid = await git.commit({ fs: h.fs, dir: h.dir, message: "remote edit", author: COMMIT_AUTHOR });
  await git.writeRef({ fs: h.fs, dir: h.dir, ref: "refs/heads/main", value: localHead, force: true });
  await git.checkout({ fs: h.fs, dir: h.dir, ref: "main", force: true });
  await setOriginRef(h, remoteOid);

  const out = await h.safeGit.mergeSafe();
  if (out.kind !== "conflict") throw new Error("expected a conflict");
  return { localHead, remoteOid };
}

describe("SafeGit.resolveConflicts", () => {
  it("keeps the local version and records a merge commit with both parents", async () => {
    const h = await makeHarness();
    const { localHead, remoteOid } = await conflicted(h);

    const oid = await h.safeGit.resolveConflicts([{ path: "notes/a.md", choice: "mine" }]);

    expect(await h.adapter.read("notes/a.md")).toBe("local version\n");
    const commit = await git.readCommit({ fs: h.fs, dir: h.dir, oid });
    expect(commit.commit.parent).toEqual([localHead, remoteOid]);
  });

  it("keeps the remote version when asked", async () => {
    const h = await makeHarness();
    await conflicted(h);
    await h.safeGit.resolveConflicts([{ path: "notes/a.md", choice: "theirs" }]);
    expect(await h.adapter.read("notes/a.md")).toBe("remote version\n");
  });

  it("preserves the losing version in history", async () => {
    const h = await makeHarness();
    const { localHead } = await conflicted(h);
    await h.safeGit.resolveConflicts([{ path: "notes/a.md", choice: "theirs" }]);

    const { blob } = await git.readBlob({
      fs: h.fs,
      dir: h.dir,
      oid: localHead,
      filepath: "notes/a.md",
    });
    expect(new TextDecoder().decode(blob)).toBe("local version\n");
  });

  it("writes no conflict markers into the file", async () => {
    const h = await makeHarness();
    await conflicted(h);
    await h.safeGit.resolveConflicts([{ path: "notes/a.md", choice: "mine" }]);
    const text = await h.adapter.read("notes/a.md");
    expect(text).not.toContain("<<<<<<<");
    expect(text).not.toContain(">>>>>>>");
  });

  it("deletes the file when the chosen side had deleted it", async () => {
    const h = await makeHarness();
    const first = await initRepo(h);
    await h.adapter.remove("notes/a.md");
    await h.safeGit.commitLocal("local delete");
    const localHead = await git.resolveRef({ fs: h.fs, dir: h.dir, ref: "refs/heads/main" });

    await git.writeRef({ fs: h.fs, dir: h.dir, ref: "refs/heads/main", value: first, force: true });
    await git.checkout({ fs: h.fs, dir: h.dir, ref: "main", force: true });
    await h.write("notes/a.md", "remote edit\n");
    await git.add({ fs: h.fs, dir: h.dir, filepath: "notes/a.md" });
    const remoteOid = await git.commit({ fs: h.fs, dir: h.dir, message: "remote edit", author: COMMIT_AUTHOR });
    await git.writeRef({ fs: h.fs, dir: h.dir, ref: "refs/heads/main", value: localHead, force: true });
    await setOriginRef(h, remoteOid);

    // mergeSafe records the delete/modify conflict as `pending`; resolving "mine"
    // then keeps the local deletion. Without the merge there is no pending set.
    const out = await h.safeGit.mergeSafe();
    if (out.kind !== "conflict") throw new Error("expected a conflict");

    await h.safeGit.resolveConflicts([{ path: "notes/a.md", choice: "mine" }]);
    expect(h.adapter.paths()).not.toContain("notes/a.md");
  });

  // The reason ConflictSide carries bytes at all. If someone reintroduced a
  // decode/encode round trip inside materialise, this is what would catch it.
  it("writes a chosen binary version back byte-for-byte", async () => {
    const h = await makeHarness();
    const ourPng = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe, 0x00, 0x01]);
    const theirPng = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xfe, 0xff, 0x02, 0x03]);

    const first = await initRepo(h);
    await h.adapter.writeBinary("img.png", ourPng.slice().buffer);
    await h.commit(["img.png"], "local binary");
    const localHead = await git.resolveRef({ fs: h.fs, dir: h.dir, ref: "refs/heads/main" });

    await git.writeRef({ fs: h.fs, dir: h.dir, ref: "refs/heads/main", value: first, force: true });
    await git.checkout({ fs: h.fs, dir: h.dir, ref: "main", force: true });
    await h.adapter.writeBinary("img.png", theirPng.slice().buffer);
    await git.add({ fs: h.fs, dir: h.dir, filepath: "img.png" });
    const remoteOid = await git.commit({
      fs: h.fs,
      dir: h.dir,
      message: "remote binary",
      author: COMMIT_AUTHOR,
    });
    await git.writeRef({ fs: h.fs, dir: h.dir, ref: "refs/heads/main", value: localHead, force: true });
    await git.checkout({ fs: h.fs, dir: h.dir, ref: "main", force: true });
    await setOriginRef(h, remoteOid);

    const out = await h.safeGit.mergeSafe();
    expect(out.kind).toBe("conflict");

    await h.safeGit.resolveConflicts([{ path: "img.png", choice: "theirs" }]);

    const onDisk = new Uint8Array(await h.adapter.readBinary("img.png"));
    expect(Array.from(onDisk)).toEqual(Array.from(theirPng));
    expect(Array.from(onDisk)).not.toContain(0xef); // no U+FFFD bytes
  });

  /**
   * Two conflicting files, the second unreadable. With writes decided up front the
   * first file is untouched; screening as we went would already have written and
   * staged it before refusing, making the "Nothing was changed" message a lie.
   */
  it("refuses without writing anything when a later chosen side is unreadable", async () => {
    const h = await makeHarness();
    const first = await initRepo(h);
    await h.write("notes/a.md", "local a\n");
    await h.write("notes/b.md", "local b\n");
    const localOid = await h.commit(["notes/a.md", "notes/b.md"], "local edits both");
    await divergeRemote(
      h,
      first,
      { "notes/a.md": "remote a\n", "notes/b.md": "remote b\n" },
      "remote edits both",
    );

    const out = await h.safeGit.mergeSafe();
    if (out.kind !== "conflict") throw new Error("expected a conflict");
    expect(out.files.length).toBe(2);

    // Damage whichever file the resolver would reach second.
    const pending = (h.safeGit as unknown as {
      pending: { files: Array<{ path: string; theirs: unknown }> };
    }).pending;
    const damaged = pending.files[1].path;
    pending.files[1].theirs = { state: "unreadable", error: "simulated damage" };
    const intact = pending.files[0].path;
    const before = await h.adapter.read(intact);

    await expect(
      h.safeGit.resolveConflicts(
        pending.files.map((f) => ({ path: f.path, choice: "theirs" as const })),
      ),
    ).rejects.toThrow(/could not be read/i);

    expect(damaged).not.toBe(intact);
    expect(await h.adapter.read(intact)).toBe(before);
    expect(await git.resolveRef({ fs: h.fs, dir: h.dir, ref: "HEAD" })).toBe(localOid);
  });

  it("throws when there is no pending conflict", async () => {
    const h = await makeHarness();
    await initRepo(h);
    await expect(
      h.safeGit.resolveConflicts([{ path: "notes/a.md", choice: "mine" }]),
    ).rejects.toThrow(/no pending conflict/i);
  });

  /**
   * FINDING 2, layer (b). A conflict is recorded, then the user commits a precious v2
   * on top and a later mergeSafe fast-forwards past it. If resolveConflicts trusted the
   * now-stale `pending` it would overwrite v2 on disk with R1's old content and commit
   * with stale parents [L1,R1] -- so v2 is not even reachable in history. Destroyed.
   *
   * resolveConflicts must VALIDATE pending against current reality before acting: if
   * pending.ourHead !== current local OR pending.theirHead !== current remote, it refuses
   * and writes nothing.
   *
   * Mutation-verification: with layer (b) removed, this test FAILS -- v2 is overwritten
   * on disk with "remote v1\n" and HEAD moves to a bogus merge commit.
   */
  it("refuses to apply a stale conflict after an intervening fast-forward", async () => {
    const h = await makeHarness();
    const base = await initRepo(h);

    // Step 1: produce a real conflict on notes/a.md. local L1 vs remote R1.
    await h.write("notes/a.md", "local v1\n");
    const L1 = await h.commit(["notes/a.md"], "local v1");
    const R1 = await divergeRemote(h, base, { "notes/a.md": "remote v1\n" }, "remote v1");

    const out = await h.safeGit.mergeSafe();
    if (out.kind !== "conflict") throw new Error("expected a conflict");

    // Step 2: user edits a.md to precious v2 and commits on top of L1 -> L2.
    await h.write("notes/a.md", "PRECIOUS V2\n");
    const L2 = await h.commit(["notes/a.md"], "local v2 (precious)");

    // A later fetch fast-forwards: the remote now points at a descendant of L2.
    await h.write("notes/a.md", "remote v3\n");
    const R2 = await h.commit(["notes/a.md"], "remote v3 on top of L2");
    // Restore local HEAD to L2; origin now points at R2 (a descendant of L2).
    await git.writeRef({ fs: h.fs, dir: h.dir, ref: "refs/heads/main", value: L2, force: true });
    await git.checkout({ fs: h.fs, dir: h.dir, ref: "main", force: true });
    await setOriginRef(h, R2);
    // Put v2 back on disk (the checkout above moved the working tree to L2's a.md).
    await h.adapter.write("notes/a.md", "PRECIOUS V2\n");

    // The stale pending still says {ourHead:L1, theirHead:R1}. Resolution must refuse
    // because neither matches current reality (local L2, remote R2).
    await expect(
      h.safeGit.resolveConflicts([{ path: "notes/a.md", choice: "theirs" }]),
    ).rejects.toThrow(/nothing was changed/i);

    // v2 is still on disk and HEAD is still L2 -- nothing was destroyed.
    expect(await h.adapter.read("notes/a.md")).toBe("PRECIOUS V2\n");
    expect(await git.resolveRef({ fs: h.fs, dir: h.dir, ref: "HEAD" })).toBe(L2);
    void R1;
  });

  /**
   * FINDING 2, layer (a). mergeSafe must clear `pending` on its non-conflict exits. A
   * conflict is recorded, then the situation resolves to a fast-forward/up-to-date on a
   * second mergeSafe. A subsequent resolveConflicts must report there is no pending
   * conflict (proving mergeSafe cleared it), rather than acting on the stale record.
   */
  it("clears pending on a fast-forward so a later resolve reports no pending conflict", async () => {
    const h = await makeHarness();
    const base = await initRepo(h);

    // Produce a conflict: local edit vs remote edit of the same file.
    await h.write("notes/a.md", "local v1\n");
    const L1 = await h.commit(["notes/a.md"], "local v1");
    await divergeRemote(h, base, { "notes/a.md": "remote v1\n" }, "remote v1");

    const out = await h.safeGit.mergeSafe();
    if (out.kind !== "conflict") throw new Error("expected a conflict");

    // Now force the second mergeSafe to be a pure fast-forward: rewind local to `base`
    // (an ancestor of a remote lineage) so mergeSafe fast-forwards instead of conflicting.
    const ffRemote = await divergeRemote(h, base, { "notes/ff.md": "ff\n" }, "remote ff work");
    await git.writeRef({ fs: h.fs, dir: h.dir, ref: "refs/heads/main", value: base, force: true });
    await git.checkout({ fs: h.fs, dir: h.dir, ref: "main", force: true });
    await setOriginRef(h, ffRemote);

    const second = await h.safeGit.mergeSafe();
    expect(second.kind).toBe("fast-forward");

    // pending was cleared by the fast-forward, so resolution has nothing to act on.
    await expect(
      h.safeGit.resolveConflicts([{ path: "notes/a.md", choice: "theirs" }]),
    ).rejects.toThrow(/no pending conflict/i);
    void L1;
  });

  it("throws when a resolution is missing for a conflicting path", async () => {
    const h = await makeHarness();
    await conflicted(h);
    await expect(h.safeGit.resolveConflicts([])).rejects.toThrow(/unresolved/i);
  });

  it("leaves the repo unchanged after abandoning a conflict", async () => {
    const h = await makeHarness();
    const { localHead } = await conflicted(h);
    h.safeGit.abandonConflict();

    expect(await git.resolveRef({ fs: h.fs, dir: h.dir, ref: "HEAD" })).toBe(localHead);
    expect(await h.adapter.read("notes/a.md")).toBe("local version\n");
  });

  /**
   * A remote deletion of a NON-conflicting file must reach both disk and the merge
   * commit. This is the three-way branch that iterating only the remote's file list
   * would skip: `notes/y.md` is not in `pending.files` (only the remote changed it), so
   * unless the merge-base walk plans it as `{state:"absent"}` the local copy survives
   * while the merge commit falsely claims the remote lineage was merged -- and the
   * deletion is never offered again. Distinct from "deletes the file when the chosen
   * side had deleted it", which is a CONFLICTING delete/modify resolved via `mine`.
   */
  it("applies a remote deletion of a non-conflicting file to disk and the merge commit", async () => {
    const h = await makeHarness();
    const first = await initRepo(h);
    // Put both x and y into the base alongside notes/a.md.
    await h.write("notes/x.md", "base x\n");
    await h.write("notes/y.md", "base y\n");
    const base = await h.commit(["notes/x.md", "notes/y.md"], "add x and y");

    // Local edits x (the conflicting file).
    await h.write("notes/x.md", "local x\n");
    const localOid = await h.commit(["notes/x.md"], "local edits x");

    // Remote edits x differently (forces the conflict) AND deletes y.
    const remoteOid = await divergeRemote(
      h,
      base,
      { "notes/x.md": "remote x\n" },
      "remote edits x, deletes y",
      async () => {
        await git.remove({ fs: h.fs, dir: h.dir, filepath: "notes/y.md" });
        await h.adapter.remove("notes/y.md");
      },
    );

    // y really is absent from the remote commit's tree.
    const remoteFiles = await git.listFiles({ fs: h.fs, dir: h.dir, ref: remoteOid });
    expect(remoteFiles).not.toContain("notes/y.md");

    const out = await h.safeGit.mergeSafe();
    if (out.kind !== "conflict") throw new Error("expected a conflict");
    expect(out.files.map((f) => f.path)).toEqual(["notes/x.md"]);

    const oid = await h.safeGit.resolveConflicts([{ path: "notes/x.md", choice: "mine" }]);

    // y is gone from disk...
    expect(h.adapter.paths()).not.toContain("notes/y.md");
    await expect(h.adapter.read("notes/y.md")).rejects.toThrow();
    // ...and gone from the merge commit tree...
    const merged = await git.listFiles({ fs: h.fs, dir: h.dir, ref: "HEAD" });
    expect(merged).not.toContain("notes/y.md");
    // ...while x kept the local version and the commit has both parents.
    expect(await h.adapter.read("notes/x.md")).toBe("local x\n");
    const commit = await git.readCommit({ fs: h.fs, dir: h.dir, oid });
    expect(commit.commit.parent).toEqual([localOid, remoteOid]);
  });
});

/**
 * `isPathAbsent` decides whether a git NotFoundError means the file was deleted on
 * that side (absent -> the resolver unlinks and commits) or the object could not be
 * read (unreadable -> the resolver refuses). This is the task where `absent` first
 * becomes destructive, so a missing OBJECT that were wrongly classified as `absent`
 * would delete a file that exists. These pin the exact discriminator.
 */
describe("isPathAbsent", () => {
  // A bare oid in data.what is how isomorphic-git reports a missing OBJECT (a torn
  // packfile whose blob oid it echoes back), which must route to unreadable/refuse —
  // NOT to a deletion. This is the exact misclassification that would turn corruption
  // into a durable deletion of a file that exists.
  it("treats a bare-oid data.what as unreadable, not absent (missing object)", () => {
    expect(isPathAbsent(notFound(OTHER_OID), FULL_OID)).toBe(false);
  });

  // A path-shaped data.what is how it reports a path genuinely missing from the tree —
  // the chosen side really deleted the file, so this is a true deletion.
  it("treats a path-shaped data.what as absent (path missing from the tree)", () => {
    expect(isPathAbsent(notFound(`${FULL_OID}:notes/a.md`), FULL_OID)).toBe(true);
  });

  it("treats an abbreviated oid input as unreadable, not absent", () => {
    expect(isPathAbsent(notFound("0123456"), "0123456")).toBe(false);
  });

  it("treats a ref-name input such as \"main\" as unreadable, not absent", () => {
    expect(isPathAbsent(notFound("main"), "main")).toBe(false);
  });

  it("is false for any error that is not a NotFoundError", () => {
    expect(isPathAbsent({ code: "SomethingElse", data: { what: OTHER_OID } }, FULL_OID)).toBe(false);
  });
});
