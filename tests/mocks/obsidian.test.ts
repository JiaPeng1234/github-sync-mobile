import { describe, it, expect, afterEach } from "vitest";
import type { RequestUrlResponse } from "obsidian";
// `requestUrl` comes through the bare "obsidian" specifier on purpose: that is how
// src/ will import it, so this is the one place the vitest alias itself is exercised.
// It also typechecks against the real package, since the stub matches that signature.
import { requestUrl } from "obsidian";
// The harness-only helpers must come by path. `tsc` resolves "obsidian" to the real
// package, which does not export them. Both specifiers resolve to the same module at
// runtime, so the handler these install is the one `requestUrl` above reads.
import { setRequestUrlHandler, resetRequestUrlHandler } from "./obsidian";

// The stub deliberately installs no global hook, so each suite resets for itself.
afterEach(() => {
  resetRequestUrlHandler();
});

function response(over: Partial<RequestUrlResponse> = {}): RequestUrlResponse {
  return {
    status: 200,
    headers: {},
    arrayBuffer: new ArrayBuffer(0),
    json: null,
    text: "",
    ...over,
  };
}

describe("obsidian stub requestUrl", () => {
  it("resolves the bare 'obsidian' specifier to this stub", async () => {
    // Guards the vitest alias itself. Without it, src/ importing "obsidian" would
    // reach the real package (which ships no runtime implementation) and every later
    // suite would fail in a far more confusing way.
    setRequestUrlHandler(async () => response({ text: "from the stub" }));
    expect((await requestUrl({ url: "u" })).text).toBe("from the stub");
  });

  it("throws when no handler is installed", async () => {
    await expect(requestUrl({ url: "https://example.test" })).rejects.toThrow(
      /no handler installed/,
    );
  });

  it("routes the whole param through to the installed handler", async () => {
    let seen: unknown;
    setRequestUrlHandler(async (p) => {
      seen = p;
      return response({ text: "ok" });
    });

    await requestUrl({
      url: "https://example.test/x",
      method: "POST",
      contentType: "application/json",
      headers: { Authorization: "token abc" },
      body: "{}",
    });

    expect(seen).toMatchObject({
      url: "https://example.test/x",
      method: "POST",
      contentType: "application/json",
      headers: { Authorization: "token abc" },
    });
  });

  it("restores the throwing default on reset", async () => {
    setRequestUrlHandler(async () => response({ text: "installed" }));
    expect((await requestUrl({ url: "u" })).text).toBe("installed");

    resetRequestUrlHandler();
    await expect(requestUrl({ url: "u" })).rejects.toThrow(/no handler installed/);
  });

  it("throws on a 400+ status by default, naming the status in the message", async () => {
    // The statuses GitHub returns exactly where this plugin's safety decisions live.
    // Asserted on the message, not on an `err.status` property: the real typings
    // promise no such property, and a stub that provided one would let production code
    // key on it, pass here, and read undefined on a device.
    for (const status of [401, 403, 409, 500]) {
      setRequestUrlHandler(async () => response({ status }));
      await expect(requestUrl({ url: "u" })).rejects.toThrow(
        new RegExp(`status ${status}`),
      );
    }
  });

  it("suppresses the throw when throw:false, so the status can be inspected", async () => {
    setRequestUrlHandler(async () => response({ status: 409, text: "conflict" }));
    const res = await requestUrl({ url: "u", throw: false });
    expect(res.status).toBe(409);
    expect(res.text).toBe("conflict");
  });

  it("passes success statuses through untouched", async () => {
    for (const status of [200, 201, 304]) {
      setRequestUrlHandler(async () => response({ status }));
      expect((await requestUrl({ url: "u" })).status).toBe(status);
    }
  });
});
