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

  it("writes into a folder created by mkdir, including intermediates", async () => {
    const a = new MemoryAdapter();
    await a.mkdir("a/b");
    await a.write("a/b/f.md", "deep");
    expect(await a.read("a/b/f.md")).toBe("deep");
    expect((await a.stat("a"))?.type).toBe("folder");
  });
});
