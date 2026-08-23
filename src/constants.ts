export const DEFAULT_BRANCH = "main";

/**
 * Never synced, in either direction.
 *
 * `.obsidian/` and `.trash/` are per-device and would conflict constantly.
 * `.obsidian/` also holds this plugin's settings — including the GitHub token —
 * in plaintext, so excluding it is what keeps the token out of the repository.
 * `.git/` is git's own metadata; isomorphic-git already skips it, so listing it
 * is defence in depth rather than a fix for an observed problem.
 *
 * `readonly` is deliberate: this array is the token-leak guard, and every
 * consumer must copy it (`[...DEFAULT_EXCLUDES]`) before editing. Without the
 * modifier, one aliasing assignment plus a later `push` would corrupt the
 * defaults that "reset to defaults" restores.
 */
export const DEFAULT_EXCLUDES: readonly string[] = [
  ".obsidian/",
  ".git/",
  ".trash/",
];

/** Substituted with the current local date and time when a commit is made. */
export const TIMESTAMP_TOKEN = "{{timestamp}}";

export const DEFAULT_COMMIT_TEMPLATE = `Vault sync from mobile — ${TIMESTAMP_TOKEN}`;

/**
 * Fallback commit identity, used only when the authenticated login is unknown.
 *
 * The address is under `invalid.` — a reserved TLD that can never be registered
 * or delivered to (RFC 2606). A plausible-looking `@users.noreply.github.com`
 * address would be worse: GitHub would fail to attribute the commits, and if
 * anyone ever registered the matching account, every commit this plugin had made
 * would be attributed to them.
 */
export const COMMIT_AUTHOR: { readonly name: string; readonly email: string } = {
  name: "github-sync-mobile",
  email: "github-sync-mobile@localhost.invalid",
};

export const GITHUB_API = "https://api.github.com";

/**
 * Owner and repository names the plugin is willing to interpolate into a URL.
 * Deliberately strict: these come straight from text fields, and on iOS a
 * malformed value produces a confusing failure the user has no way to inspect.
 *
 * Not applicable to branch names — a branch may legitimately contain `/`, as in
 * `feature/x`, so applying this to a branch would reject valid input.
 *
 * Callers must catch the errors `repoUrl` throws and name the offending field;
 * an unhandled throw here would leave the UI silently inert.
 */
const SEGMENT = /^[A-Za-z0-9._-]+$/;

export function isValidSegment(value: string): boolean {
  return SEGMENT.test(value) && value !== "." && value !== "..";
}

export function repoUrl(owner: string, repo: string): string {
  if (!isValidSegment(owner)) {
    throw new Error(`Invalid repository owner: ${JSON.stringify(owner)}`);
  }
  if (!isValidSegment(repo)) {
    throw new Error(`Invalid repository name: ${JSON.stringify(repo)}`);
  }
  return `https://github.com/${owner}/${repo}.git`;
}
