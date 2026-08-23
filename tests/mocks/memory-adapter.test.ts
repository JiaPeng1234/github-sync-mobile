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
});
