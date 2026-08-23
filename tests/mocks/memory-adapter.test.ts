import { describe, it, expect } from "vitest";
import { MemoryAdapter } from "./memory-adapter";

describe("MemoryAdapter", () => {
  it("writes and reads text", async () => {
    const a = new MemoryAdapter();
    await a.write("notes/a.md", "hello");
    expect(await a.read("notes/a.md")).toBe("hello");
  });

  it("lists files and folders at a path", async () => {
    const a = new MemoryAdapter();
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
});
