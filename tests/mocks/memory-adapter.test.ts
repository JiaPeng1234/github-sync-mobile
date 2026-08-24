import { describe, it, expect } from "vitest";
import { MemoryAdapter } from "./memory-adapter";

describe("MemoryAdapter", () => {
  it("writes and reads text", async () => {
    const a = new MemoryAdapter();
    await a.mkdir("notes");
    await a.write("notes/a.md", "hello");
    expect(await a.read("notes/a.md")).toBe("hello");
  });

  it("lists files and folders at a path", async () => {
    const a = new MemoryAdapter();
    await a.mkdir("notes/sub");
    await a.write("notes/a.md", "x");
    await a.write("notes/sub/b.md", "y");
    const listing = await a.list("notes");
    expect(listing.files).toEqual(["notes/a.md"]);
    expect(listing.folders).toEqual(["notes/sub"]);
  });

  it("lists the vault root with an empty path", async () => {
    const a = new MemoryAdapter();
    await a.write("a.md", "x");
    const listing = await a.list("");
    expect(listing.files).toEqual(["a.md"]);
  });

  it("returns null from stat for a missing path", async () => {
    const a = new MemoryAdapter();
    expect(await a.stat("nope.md")).toBeNull();
  });

  it("round-trips binary data", async () => {
    const a = new MemoryAdapter();
    const bytes = new Uint8Array([1, 2, 3, 250]);
    await a.writeBinary("img.png", bytes.buffer);
    const out = new Uint8Array(await a.readBinary("img.png"));
    expect(Array.from(out)).toEqual([1, 2, 3, 250]);
  });

  it("keeps mtime stable until the file is written again", async () => {
    const a = new MemoryAdapter();
    await a.write("s.md", "one");
    const first = (await a.stat("s.md"))!.mtime;
    expect((await a.stat("s.md"))!.mtime).toBe(first);
    expect((await a.stat("s.md"))!.mtime).toBe(first);

    await a.write("s.md", "two");
    const second = (await a.stat("s.md"))!.mtime;
    expect(second).toBeGreaterThan(first);
    expect((await a.stat("s.md"))!.mtime).toBe(second);
  });

  it("refuses to write into a folder that does not exist", async () => {
    const a = new MemoryAdapter();
    await expect(a.write("missing/f.md", "x")).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      a.writeBinary("missing/f.bin", new Uint8Array([1]).buffer),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(a.paths()).toEqual([]);
  });

  it("recovers a git loose-object write via mkdir-and-retry on the error code", async () => {
    const a = new MemoryAdapter();
    const objectPath = ".git/objects/ab/cdef0123456789abcdef0123456789abcdef01";

    // The sequence isomorphic-git performs: write, and on a coded failure create the
    // parent folder and try once more. Deep loose-object paths are what git actually
    // writes, so this is the shape that matters.
    let recovered = false;
    try {
      await a.write(objectPath, "loose object");
    } catch (err) {
      expect((err as { code?: string }).code).toBe("ENOENT");
      await a.mkdir(".git/objects/ab");
      await a.write(objectPath, "loose object");
      recovered = true;
    }

    expect(recovered).toBe(true);
    expect(await a.read(objectPath)).toBe("loose object");
    expect(a.paths()).toEqual([objectPath]);
    // mkdir created every intermediate level, not just the leaf.
    expect((await a.stat(".git"))?.type).toBe("folder");
    expect((await a.stat(".git/objects"))?.type).toBe("folder");
    expect((await a.stat(".git/objects/ab"))?.type).toBe("folder");
  });

  it("throws ENOENT from list for a path that does not exist", async () => {
    const a = new MemoryAdapter();
    await expect(a.list("nope")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("throws ENOTDIR from list for a path that is a file", async () => {
    const a = new MemoryAdapter();
    await a.write("f.md", "x");
    await expect(a.list("f.md")).rejects.toMatchObject({ code: "ENOTDIR" });
  });

  it("distinguishes an existing empty folder from a missing one", async () => {
    const a = new MemoryAdapter();
    await a.mkdir("empty");
    // This is the distinction isomorphic-git's readdir turns into null-vs-[]. If both
    // cases returned empty arrays, a tree walk would read a vanished subtree as
    // "no entries here" rather than "not there at all".
    await expect(a.list("empty")).resolves.toEqual({ files: [], folders: [] });
    await expect(a.list("gone")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("lists the vault root even when it is empty", async () => {
    const a = new MemoryAdapter();
    await expect(a.list("")).resolves.toEqual({ files: [], folders: [] });
  });

  it("honours explicit ctime/mtime from DataWriteOptions", async () => {
    const a = new MemoryAdapter();
    await a.write("t.md", "x", { ctime: 111, mtime: 222 });
    expect(await a.stat("t.md")).toMatchObject({ ctime: 111, mtime: 222 });

    await a.writeBinary("t.bin", new Uint8Array([1]).buffer, { mtime: 333 });
    expect((await a.stat("t.bin"))!.mtime).toBe(333);
  });

  it("keeps ctime stable across a rewrite while mtime and size follow the content", async () => {
    const a = new MemoryAdapter();
    await a.write("c.md", "one");
    const first = (await a.stat("c.md"))!;
    await a.write("c.md", "two-longer");
    const second = (await a.stat("c.md"))!;
    expect(second.ctime).toBe(first.ctime);
    expect(second.mtime).toBeGreaterThan(first.mtime);
    expect(second.size).toBe(10);
  });

  it("reports missing files with an ENOENT code, not just a message", async () => {
    const a = new MemoryAdapter();
    await expect(a.read("no.md")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(a.readBinary("no.md")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(a.remove("no.md")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("stamps folder times from the clock when mkdir creates them", async () => {
    const a = new MemoryAdapter();
    await a.mkdir("dir");
    const st = (await a.stat("dir"))!;
    expect(st.type).toBe("folder");
    expect(st.mtime).toBe(st.ctime);
    expect(st.mtime).toBeGreaterThan(1000);
  });

  it("reports existence for files, folders, and the vault root", async () => {
    const a = new MemoryAdapter();
    await a.mkdir("d");
    await a.write("d/f.md", "x");
    expect(await a.exists("d/f.md")).toBe(true);
    expect(await a.exists("d")).toBe(true);
    expect(await a.exists("")).toBe(true);
    expect(await a.exists("nope")).toBe(false);
  });

  it("copies binary data in and out so callers cannot mutate stored bytes", async () => {
    const a = new MemoryAdapter();
    const source = new Uint8Array([1, 2, 3]);
    await a.writeBinary("b.bin", source.buffer);

    // Inbound copy: isomorphic-git may reuse a buffer after handing it to us.
    source[0] = 99;
    expect(Array.from(new Uint8Array(await a.readBinary("b.bin")))).toEqual([1, 2, 3]);

    // Outbound copy: a caller mutating what it read must not corrupt the store.
    const out = await a.readBinary("b.bin");
    new Uint8Array(out)[0] = 42;
    expect(Array.from(new Uint8Array(await a.readBinary("b.bin")))).toEqual([1, 2, 3]);
  });

  it("refuses to write over a folder, keeping files and folders disjoint", async () => {
    const a = new MemoryAdapter();
    await a.mkdir("dir");
    await expect(a.write("dir", "clobber")).rejects.toMatchObject({ code: "EISDIR" });
    await expect(
      a.writeBinary("dir", new Uint8Array([1]).buffer),
    ).rejects.toMatchObject({ code: "EISDIR" });

    expect((await a.stat("dir"))?.type).toBe("folder");
    expect(a.paths()).toEqual([]);
  });

  it("refuses to mkdir at or underneath a file, keeping files and folders disjoint", async () => {
    const a = new MemoryAdapter();
    await a.write("f.md", "x");
    await expect(a.mkdir("f.md")).rejects.toMatchObject({ code: "ENOTDIR" });
    await expect(a.mkdir("f.md/sub")).rejects.toMatchObject({ code: "ENOTDIR" });

    // Regression: a failed mkdir must not retract the ENOTDIR that list() owes us,
    // and must not leave a partially created tree behind.
    await expect(a.list("f.md")).rejects.toMatchObject({ code: "ENOTDIR" });
    expect((await a.stat("f.md"))?.type).toBe("file");
    expect(await a.list("")).toEqual({ files: ["f.md"], folders: [] });
  });

  it("removes a subtree recursively and reports an absent folder", async () => {
    const a = new MemoryAdapter();
    await a.mkdir("d/sub");
    await a.write("d/1.md", "a");
    await a.write("d/sub/2.md", "b");

    await a.rmdir("d", true);

    expect(a.paths()).toEqual([]);
    expect(await a.exists("d")).toBe(false);
    expect(await a.exists("d/sub")).toBe(false);
    await expect(a.list("d")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(a.rmdir("gone", true)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("allows a non-recursive rmdir of a non-empty folder (deliberate divergence)", async () => {
    const a = new MemoryAdapter();
    await a.mkdir("d");
    await a.write("d/1.md", "a");

    // The real adapter fails here. Pinned so the leniency stays a visible decision:
    // it strands the child, which is why callers must pass recursive.
    await a.rmdir("d", false);
    expect(await a.exists("d")).toBe(false);
    expect(a.paths()).toEqual(["d/1.md"]);
  });

  it("injects a read failure at a chosen path and clears it again", async () => {
    const a = new MemoryAdapter();
    await a.write("a.md", "x");
    a.failReadsAt("a.md", "EIO");
    await expect(a.read("a.md")).rejects.toMatchObject({ code: "EIO" });
    a.clearReadFailures();
    expect(await a.read("a.md")).toBe("x");
  });

  it("injects a directory read failure, which is the hazard SafeGit must guard", async () => {
    const a = new MemoryAdapter();
    await a.mkdir("notes");
    await a.write("notes/a.md", "x");
    a.failReadsAt("notes", "EIO");
    await expect(a.list("notes")).rejects.toMatchObject({ code: "EIO" });
    // The file is still there -- the failure is transient, not a deletion.
    a.clearReadFailures();
    expect((await a.list("notes")).files).toEqual(["notes/a.md"]);
  });

  it("snapshots content, not just which paths exist", async () => {
    const a = new MemoryAdapter();
    await a.write("a.md", "before");
    const before = a.snapshot();
    await a.write("a.md", "after");
    const after = a.snapshot();
    expect([...before.keys()]).toEqual([...after.keys()]);
    expect(new TextDecoder().decode(before.get("a.md")!)).toBe("before");
    expect(new TextDecoder().decode(after.get("a.md")!)).toBe("after");
  });
});
