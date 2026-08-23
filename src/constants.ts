export const DEFAULT_BRANCH = "main";

/**
 * Excluded by default because these are per-device and cause spurious conflicts.
 * `.obsidian/` additionally holds this plugin's settings — including the GitHub
 * token — in plaintext, so excluding it also prevents publishing the token.
 */
export const DEFAULT_EXCLUDES = [".obsidian/", ".git/", ".trash/"];

export const DEFAULT_COMMIT_TEMPLATE = "Vault sync from mobile — {{timestamp}}";

export const COMMIT_AUTHOR = {
  name: "github-sync-mobile",
  email: "github-sync-mobile@users.noreply.github.com",
};

export const GITHUB_API = "https://api.github.com";

export function repoUrl(owner: string, repo: string): string {
  return `https://github.com/${owner}/${repo}.git`;
}
