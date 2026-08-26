import { describe, it, expect } from "vitest";
import { setRequestUrlHandler, type RequestUrlParam } from "../mocks/obsidian";
import { GitHubApi } from "../../src/github/api";

function respond(map: Record<string, { status: number; body: unknown }>) {
  const calls: RequestUrlParam[] = [];
  setRequestUrlHandler(async (p) => {
    calls.push(p);
    const key = Object.keys(map).find((k) => p.url.includes(k));
    const entry = key ? map[key] : { status: 404, body: {} };
    const text = JSON.stringify(entry.body);
    return {
      status: entry.status,
      headers: {},
      arrayBuffer: new TextEncoder().encode(text).buffer as ArrayBuffer,
      text,
      json: entry.body,
    };
  });
  return calls;
}

describe("GitHubApi", () => {
  it("verifies a token and returns the login", async () => {
    respond({ "/user": { status: 200, body: { login: "octocat" } } });
    const api = new GitHubApi("tok");
    expect(await api.verifyToken()).toEqual({ ok: true, login: "octocat" });
  });

  it("reports an invalid token", async () => {
    respond({ "/user": { status: 401, body: { message: "Bad credentials" } } });
    const api = new GitHubApi("tok");
    const res = await api.verifyToken();
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("Bad credentials");
  });

  it("sends the token as a Bearer header", async () => {
    const calls = respond({ "/user": { status: 200, body: { login: "o" } } });
    await new GitHubApi("tok").verifyToken();
    expect(calls[0].headers?.Authorization).toBe("Bearer tok");
  });

  it("reports a repo that exists and has commits", async () => {
    respond({ "/repos/o/r": { status: 200, body: { size: 12, default_branch: "main" } } });
    const api = new GitHubApi("tok");
    expect(await api.inspectRepo("o", "r")).toEqual({
      exists: true,
      hasContent: true,
      defaultBranch: "main",
    });
  });

  it("reports an existing but empty repo", async () => {
    respond({ "/repos/o/r": { status: 200, body: { size: 0, default_branch: "main" } } });
    const api = new GitHubApi("tok");
    const info = await api.inspectRepo("o", "r");
    expect(info).toEqual({ exists: true, hasContent: false, defaultBranch: "main" });
  });

  it("reports a missing repo", async () => {
    respond({});
    const api = new GitHubApi("tok");
    expect(await api.inspectRepo("o", "r")).toEqual({
      exists: false,
      hasContent: false,
      defaultBranch: "main",
    });
  });
});
