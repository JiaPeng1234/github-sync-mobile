import { describe, it, expect } from "vitest";
import { createFs } from "../../src/git/fs-adapter";
import { MemoryAdapter } from "../mocks/memory-adapter";

function setup(base = "") {
  const adapter = new MemoryAdapter();
  const bridge = createFs(adapter, base);
  // `bridge` is exposed as well as `bridge.promises` because the read-failure channel
  // lives beside `promises`, not inside it — isomorphic-git only ever touches the latter.
  return { adapter, fs: bridge.promises, bridge };
}

describe("fs-adapter", () => {
  it("writes and reads a utf8 file with the options-object form", async () => {
    const { fs } = setup();
    await fs.writeFile("a.md", "hello");
    expect(await fs.readFile("a.md", { encoding: "utf8" })).toBe("hello");
  });

  it("accepts the bare-string encoding form", async () => {
    const { fs } = setup();
    await fs.writeFile("a.md", "hello");
    expect(await fs.readFile("a.md", "utf8")).toBe("hello");
  });

  it("returns a Uint8Array when no encoding is given", async () => {
    const { fs } = setup();
    await fs.writeFile("a.bin", new Uint8Array([1, 2, 3]));
    const out = await fs.readFile("a.bin");
    expect(out instanceof Uint8Array).toBe(true);
    expect(Array.from(out as Uint8Array)).toEqual([1, 2, 3]);
  });

  // isomorphic-git hands "." to the fs for working-tree walks. Left unmapped it
  // reaches Obsidian as a path that does not exist, and statusMatrix/checkout throw.
  it("maps the repo root \".\" to the vault root", async () => {
    const { adapter, fs } = setup();
    await adapter.write("a.md", "x");
    expect(await fs.readdir(".")).toEqual(["a.md"]);
    expect((await fs.stat(".")).isDirectory()).toBe(true);
  });

  // Regression: the walker builds working-tree paths as `${dir}/${fullpath}` by string
  // concatenation rather than with isomorphic-git's own `join`, so with the mobile base
  // of "" the repo root arrives as "/." and not ".". Verified against real
  // isomorphic-git 1.41: if this does not map to the vault root, statusMatrix and
  // checkout both fail with `ENOENT: lstat '.'`.
  it("maps the repo root to the vault root when it arrives as \"/.\"", async () => {
    const { adapter, fs } = setup();
    await adapter.write("a.md", "x");
    expect((await fs.stat("/.")).isDirectory()).toBe(true);
    expect(await fs.readdir("/.")).toEqual(["a.md"]);
  });

  it("maps the repo root \".\" to the vault root with a base configured too", async () => {
    const { adapter, fs } = setup("/vault");
    await adapter.write("a.md", "x");
    expect(await fs.readdir(".")).toEqual(["a.md"]);
  });

  it("maps the vault root to an empty path when a base is configured", async () => {
    const { adapter, fs } = setup("/vault");
    await adapter.write("a.md", "x");
    // Listing the base itself must list the vault root, not a subfolder.
    expect(await fs.readdir("/vault")).toEqual(["a.md"]);
  });

  it("strips the base prefix from nested absolute paths", async () => {
    const { adapter, fs } = setup("/vault");
    await adapter.mkdir("notes");
    await adapter.write("notes/a.md", "x");
    expect(await fs.readFile("/vault/notes/a.md", "utf8")).toBe("x");
  });

  it("throws ENOENT with a code for a missing file", async () => {
    const { fs } = setup();
    await expect(fs.readFile("missing.md", "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("throws ENOENT with a code from stat on a missing path", async () => {
    const { fs } = setup();
    await expect(fs.stat("missing.md")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports files and directories through stat", async () => {
    const { fs } = setup();
    await fs.mkdir("dir");
    await fs.writeFile("dir/a.md", "x");
    const fileStat = await fs.stat("dir/a.md");
    expect(fileStat.isFile()).toBe(true);
    expect(fileStat.isDirectory()).toBe(false);
    const dirStat = await fs.stat("dir");
    expect(dirStat.isDirectory()).toBe(true);
  });

  it("lists only immediate children as bare names", async () => {
    const { fs } = setup();
    await fs.mkdir("dir");
    await fs.writeFile("dir/a.md", "x");
    await fs.mkdir("dir/sub");
    await fs.writeFile("dir/sub/b.md", "y");
    expect((await fs.readdir("dir")).sort()).toEqual(["a.md", "sub"]);
  });

  // The adapter refuses to invent parent folders, exactly like the real one.
  // isomorphic-git recovers from this itself (it catches the failed write, mkdirs
  // the parent, and retries), so the bridge must propagate the error rather than
  // hiding it behind an implicit mkdir -- otherwise a missing mkdir would only
  // ever surface on a phone.
  it("propagates ENOENT when the parent directory does not exist", async () => {
    const { fs } = setup();
    await expect(fs.writeFile("missing/a.md", "x")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("throws ENOENT from readdir for a missing path", async () => {
    const { fs } = setup();
    await expect(fs.readdir("nope")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("throws ENOTDIR from readdir for a file path", async () => {
    const { fs } = setup();
    await fs.writeFile("a.md", "x");
    await expect(fs.readdir("a.md")).rejects.toMatchObject({ code: "ENOTDIR" });
  });

  // The distinction being protected: an existing but empty directory must list
  // as empty, not throw -- that is what separates "empty" from "gone".
  it("returns an empty array for an existing empty directory", async () => {
    const { fs } = setup();
    await fs.mkdir("empty");
    expect(await fs.readdir("empty")).toEqual([]);
  });

  it("deletes a file with unlink", async () => {
    const { fs } = setup();
    await fs.writeFile("a.md", "x");
    await fs.unlink("a.md");
    await expect(fs.stat("a.md")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("creates and removes directories", async () => {
    const { fs } = setup();
    await fs.mkdir("d");
    expect((await fs.stat("d")).isDirectory()).toBe(true);
    await fs.rmdir("d");
    await expect(fs.stat("d")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports no symlinks via lstat", async () => {
    const { fs } = setup();
    await fs.writeFile("a.md", "x");
    expect((await fs.lstat("a.md")).isSymbolicLink()).toBe(false);
  });

  /**
   * Both failure points inside readdir must be recorded, not just thrown.
   *
   * isomorphic-git swallows any readdir failure other than ENOTDIR as an empty
   * directory, so the throw alone is invisible and every file beneath the folder
   * gets reported as deleted. An earlier version guarded only the listing call,
   * leaving a transient stat failure silent.
   */
  it("records a failed directory listing so it cannot pass as an empty directory", async () => {
    const { adapter, fs, bridge } = setup();
    await adapter.mkdir("notes");
    await adapter.write("notes/a.md", "x");
    adapter.failReadsAt("notes", "EIO");

    await expect(fs.readdir("notes")).rejects.toMatchObject({ code: "EIO" });
    expect(bridge.readFailures).toContain("notes");
  });

  it("does not record genuine absence as a read failure", async () => {
    const { fs, bridge } = setup();
    await expect(fs.readdir("nope")).rejects.toMatchObject({ code: "ENOENT" });
    expect(bridge.readFailures).toEqual([]);
  });

  it("clears recorded read failures on request", async () => {
    const { adapter, fs, bridge } = setup();
    await adapter.mkdir("notes");
    adapter.failReadsAt("notes", "EIO");
    await expect(fs.readdir("notes")).rejects.toBeTruthy();
    expect(bridge.readFailures.length).toBe(1);
    bridge.clearReadFailures();
    expect(bridge.readFailures).toEqual([]);
  });

  /**
   * The hole that let `commit` produce an empty tree.
   *
   * isomorphic-git's `read` has a bare `catch { return null }`, so an unreadable
   * `.git/index` makes every file look deleted and a commit built from that status has an
   * empty tree — while the working tree is intact. Nothing about the error code helps;
   * only recording does.
   */
  it("records a failed content read", async () => {
    const { adapter, fs, bridge } = setup();
    await adapter.write("a.md", "x");
    adapter.failReadsAt("a.md", "EIO");
    await expect(fs.readFile("a.md", "utf8")).rejects.toMatchObject({ code: "EIO" });
    expect(bridge.readFailures).toContain("a.md");
  });

  it("records a failed stat", async () => {
    const { adapter, fs, bridge } = setup();
    await adapter.write("a.md", "x");
    adapter.failReadsAt("a.md", "EIO");
    await expect(fs.stat("a.md")).rejects.toMatchObject({ code: "EIO" });
    expect(bridge.readFailures).toContain("a.md");
  });

  it("does not record a missing file as a read failure", async () => {
    const { fs, bridge } = setup();
    await expect(fs.readFile("nope.md", "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat("nope.md")).rejects.toMatchObject({ code: "ENOENT" });
    expect(bridge.readFailures).toEqual([]);
  });

  /**
   * Pins the listing guard specifically. `failReadsAt` fails `stat` as well, and `stat`
   * runs first, so the existing test could not tell the two guards apart — deleting the
   * listing guard left the whole suite green.
   */
  it("records a failed listing even when stat succeeds", async () => {
    const { adapter, fs, bridge } = setup();
    await adapter.mkdir("notes");
    await adapter.write("notes/a.md", "x");
    const failing = new Error("EIO: injected") as Error & { code: string };
    failing.code = "EIO";
    adapter.list = async () => {
      throw failing;
    };

    await expect(fs.readdir("notes")).rejects.toMatchObject({ code: "EIO" });
    expect(bridge.readFailures).toContain("notes");
  });

  /**
   * Pins the text content-read guard specifically. `failReadsAt` fails `stat` first, and
   * `stat` runs before the content read, so no existing test can tell the two guards
   * apart — deleting the `recordRead` wrap around `adapter.read` left the suite green.
   * Verified against real isomorphic-git: a content read of `.git/index` that fails while
   * its stat succeeds does NOT throw in statusMatrix; it silently empties the stage, so
   * only this recording catches it.
   */
  it("records a failed text content read even when stat succeeds", async () => {
    const { adapter, fs, bridge } = setup();
    await adapter.write("a.md", "x");
    const failing = new Error("EIO: injected") as Error & { code: string };
    failing.code = "EIO";
    adapter.read = async () => {
      throw failing;
    };

    await expect(fs.readFile("a.md", "utf8")).rejects.toMatchObject({ code: "EIO" });
    expect(bridge.readFailures).toContain("a.md");
  });

  /** Pins the binary content-read guard specifically, same technique as the text case. */
  it("records a failed binary content read even when stat succeeds", async () => {
    const { adapter, fs, bridge } = setup();
    await adapter.writeBinary("a.bin", new Uint8Array([1, 2, 3]).buffer);
    const failing = new Error("EIO: injected") as Error & { code: string };
    failing.code = "EIO";
    adapter.readBinary = async () => {
      throw failing;
    };

    await expect(fs.readFile("a.bin")).rejects.toMatchObject({ code: "EIO" });
    expect(bridge.readFailures).toContain("a.bin");
  });

  /**
   * Pins the `st.type !== "file"` guard in readFile. The stat succeeds and returns a
   * directory, so the guard must throw ENOENT before any content read runs — and because
   * the stat itself succeeded, nothing is a read failure and nothing is recorded.
   */
  it("throws ENOENT from readFile on a directory and records nothing", async () => {
    const { fs, bridge } = setup();
    await fs.mkdir("dir");
    await expect(fs.readFile("dir", "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(bridge.readFailures).toEqual([]);
  });

  it("does not hand out the live read-failure array", async () => {
    const { adapter, fs, bridge } = setup();
    await adapter.write("a.md", "x");
    adapter.failReadsAt("a.md", "EIO");
    await expect(fs.readFile("a.md", "utf8")).rejects.toBeTruthy();

    const snapshot = bridge.readFailures;
    (snapshot as string[]).push("injected-by-caller");
    expect(bridge.readFailures).not.toContain("injected-by-caller");
  });

  /**
   * Pins the exact-size copy. Node pools small Buffers, so `data.buffer` for a Buffer of
   * a few bytes is an 8192-byte allocation — handing that to writeBinary writes the whole
   * pool, and git then dies reading its own loose object back.
   */
  it("writes exactly the bytes given, not the whole backing buffer", async () => {
    const { adapter, fs } = setup();
    const backing = new Uint8Array([9, 9, 1, 2, 3, 9, 9, 9, 9]);
    const view = backing.subarray(2, 5);
    expect(view.byteLength).toBe(3);
    expect(view.buffer.byteLength).toBe(9);

    await fs.writeFile("v.bin", view);
    const stored = new Uint8Array(await adapter.readBinary("v.bin"));
    expect(Array.from(stored)).toEqual([1, 2, 3]);
  });

  // Backslashes are legal in an iOS/macOS filename, and git never sends them as
  // separators. Rewriting them made such a note silently unsyncable.
  it("treats a backslash as an ordinary filename character", async () => {
    const { adapter, fs } = setup();
    await adapter.write("a\\b.md", "backslash");
    expect(await fs.readFile("a\\b.md", "utf8")).toBe("backslash");
    await expect(fs.readFile("a/b.md", "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});
