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
});
