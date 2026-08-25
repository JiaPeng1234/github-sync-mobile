import { describe, it, expect } from "vitest";
import { setRequestUrlHandler, type RequestUrlParam } from "../mocks/obsidian";
import { httpClient } from "../../src/git/http-client";

function capture(status = 200, responseBody = "ok") {
  const calls: RequestUrlParam[] = [];
  setRequestUrlHandler(async (p) => {
    calls.push(p);
    return {
      status,
      headers: { "content-type": "application/x-git-upload-pack-result" },
      arrayBuffer: new TextEncoder().encode(responseBody).buffer as ArrayBuffer,
      text: responseBody,
      json: undefined,
    };
  });
  return calls;
}

async function drain(body: AsyncIterableIterator<Uint8Array> | Uint8Array[]) {
  const chunks: number[] = [];
  for await (const c of body as AsyncIterable<Uint8Array>) chunks.push(...c);
  return new Uint8Array(chunks);
}

describe("httpClient", () => {
  it("passes url, method and headers through to requestUrl", async () => {
    const calls = capture();
    await httpClient.request({
      url: "https://github.com/o/r.git/info/refs",
      method: "GET",
      headers: { Authorization: "Basic abc" },
    });
    expect(calls[0].url).toBe("https://github.com/o/r.git/info/refs");
    expect(calls[0].method).toBe("GET");
    expect(calls[0].headers?.Authorization).toBe("Basic abc");
  });

  it("never lets requestUrl throw on non-2xx, so git sees the status", async () => {
    const calls = capture(401, "bad creds");
    const res = await httpClient.request({ url: "https://x", method: "GET" });
    expect(calls[0].throw).toBe(false);
    expect(res.statusCode).toBe(401);
  });

  it("concatenates an async-iterable request body before sending", async () => {
    const calls = capture();
    async function* body() {
      yield new Uint8Array([1, 2]);
      yield new Uint8Array([3]);
    }
    await httpClient.request({
      url: "https://x",
      method: "POST",
      body: body() as never,
    });
    expect(Array.from(new Uint8Array(calls[0].body as ArrayBuffer))).toEqual([1, 2, 3]);
  });

  it("accepts an array of Uint8Array as the body", async () => {
    const calls = capture();
    await httpClient.request({
      url: "https://x",
      method: "POST",
      body: [new Uint8Array([7, 8])] as never,
    });
    expect(Array.from(new Uint8Array(calls[0].body as ArrayBuffer))).toEqual([7, 8]);
  });

  it("sends exactly the logical bytes of a subarray-backed body, not its backing buffer", async () => {
    // A subarray shares its parent's backing store (Node pools small buffers),
    // so `.buffer` can be far larger than the logical bytes. concatBody must
    // copy into an exact-size buffer; a naive single-chunk fast path would leak
    // the oversized pool buffer. Pin that here.
    const calls = capture();
    const backing = new Uint8Array([9, 9, 1, 2, 3, 9, 9, 9, 9]);
    const view = backing.subarray(2, 5); // 3 logical bytes, 9-byte backing
    await httpClient.request({
      url: "https://x",
      method: "POST",
      body: [view] as never,
    });
    expect((calls[0].body as ArrayBuffer).byteLength).toBe(3);
    expect(Array.from(new Uint8Array(calls[0].body as ArrayBuffer))).toEqual([1, 2, 3]);
  });

  it("returns the response body as an iterable of Uint8Array", async () => {
    capture(200, "hello");
    const res = await httpClient.request({ url: "https://x", method: "GET" });
    expect(new TextDecoder().decode(await drain(res.body))).toBe("hello");
  });

  it("returns response headers and echoes url and method", async () => {
    capture();
    const res = await httpClient.request({ url: "https://x", method: "GET" });
    expect(res.url).toBe("https://x");
    expect(res.method).toBe("GET");
    expect(res.headers["content-type"]).toContain("git-upload-pack-result");
  });

  it("lowercases response header keys so iso-git's case-sensitive lookup works", async () => {
    setRequestUrlHandler(async () => ({
      status: 200,
      headers: { "Content-Type": "application/x-git-upload-pack-result" },
      arrayBuffer: new TextEncoder().encode("ok").buffer as ArrayBuffer,
      text: "ok",
      json: undefined,
    }));
    const res = await httpClient.request({ url: "https://x", method: "GET" });
    expect(res.headers["content-type"]).toContain("git-upload-pack-result");
    expect(res.headers["Content-Type"]).toBeUndefined();
  });
});
