import { requestUrl } from "obsidian";
import { GITHUB_API, DEFAULT_BRANCH } from "../constants";

export type VerifyResult =
  | { ok: true; login: string }
  | { ok: false; error: string };

export interface RepoInfo {
  exists: boolean;
  /** True when the repo has at least one commit worth of content. */
  hasContent: boolean;
  defaultBranch: string;
}

/** Minimal GitHub REST client. All traffic goes through requestUrl. */
export class GitHubApi {
  constructor(private readonly token: string) {}

  private async get(path: string): Promise<{ status: number; json: unknown }> {
    const res = await requestUrl({
      url: `${GITHUB_API}${path}`,
      method: "GET",
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      throw: false,
    });
    let json: unknown = {};
    try {
      json = JSON.parse(res.text);
    } catch {
      json = {};
    }
    return { status: res.status, json };
  }

  async verifyToken(): Promise<VerifyResult> {
    const { status, json } = await this.get("/user");
    if (status === 200) {
      return { ok: true, login: (json as { login: string }).login };
    }
    const msg = (json as { message?: string }).message ?? `HTTP ${status}`;
    return { ok: false, error: msg };
  }

  async inspectRepo(owner: string, repo: string): Promise<RepoInfo> {
    const { status, json } = await this.get(`/repos/${owner}/${repo}`);
    if (status !== 200) {
      return { exists: false, hasContent: false, defaultBranch: DEFAULT_BRANCH };
    }
    const body = json as { size?: number; default_branch?: string };
    return {
      exists: true,
      hasContent: (body.size ?? 0) > 0,
      defaultBranch: body.default_branch ?? DEFAULT_BRANCH,
    };
  }
}
