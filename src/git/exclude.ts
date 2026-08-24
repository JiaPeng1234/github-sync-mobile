export interface ExcludeMatcher {
  isExcluded(path: string): boolean;
  /** Keeps only non-excluded paths, preserving order. */
  filter(paths: string[]): string[];
}

/** Vault-relative, forward slashes, no leading ./ or /. */
function normalise(p: string): string {
  let out = p.replace(/\\/g, "/").trim();
  while (out.startsWith("./")) out = out.slice(2);
  while (out.startsWith("/")) out = out.slice(1);
  return out.replace(/\/{2,}/g, "/");
}

/**
 * Sentinels standing in for `**\/` and `**` while `*` is being translated, so the
 * three do not interfere.
 *
 * NUL and SOH are safe because neither can appear in a vault path — a printable
 * placeholder such as a space could, and would then be rewritten into `.*`,
 * silently over-matching every path containing that character. In an exclude
 * engine over-matching means files are never pushed, which is a silent backup
 * loss. Written as escapes so this file stays textual to `grep` and survives
 * copy-paste.
 */
const DOUBLE_STAR_SLASH = "\u0000";
const DOUBLE_STAR = "\u0001";

function toRegExp(rawPattern: string): RegExp {
  let p = normalise(rawPattern);

  // `dir/`, `dir/*` and `dir/**` all mean "dir and everything under it". Users of
  // the prior plugin wrote `dir/*` expecting recursion, so honour that intent
  // rather than silently under-matching. The trailing-directory match is applied
  // to every pattern below, so all three collapse to the bare name here.
  if (p.endsWith("/**")) p = p.slice(0, -3);
  else if (p.endsWith("/*")) p = p.slice(0, -2);
  else if (p.endsWith("/")) p = p.slice(0, -1);

  // Collapse runs of `**/` into one.
  //
  // Each becomes an independent `(?:.*/)?`, and several in a row make the regex
  // backtrack exponentially in the depth of the path being tested. Measured before
  // this collapse: a pattern with twelve `**/` groups took 4.1 seconds for a single
  // path at depth 30, and filtering 2000 paths took 18 seconds — an unresponsive
  // phone, with no timeout anywhere and no way for the user to see why. Collapsing
  // is also semantically harmless, since consecutive "any number of directories"
  // groups say nothing more than one of them.
  p = p.replace(/(?:\*\*\/)+/g, "**/");

  const body = p
    .replace(/[.+^${}()|[\]\\?]/g, "\\$&")
    .replace(/\*\*\//g, DOUBLE_STAR_SLASH)
    .replace(/\*\*/g, DOUBLE_STAR)
    .replace(/\*/g, "[^/]*")
    .split(DOUBLE_STAR_SLASH)
    .join("(?:.*/)?")
    .split(DOUBLE_STAR)
    .join(".*");

  // Every pattern also matches everything beneath whatever it matched.
  //
  // This is what makes a bare `.obsidian` behave like `.obsidian/`. Without it, a
  // user who edits the exclude list and drops the trailing slash still excludes the
  // directory entry but silently syncs its contents — which for `.obsidian` means
  // publishing the plugin's own settings file, and with it the GitHub token. It also
  // matches how .gitignore treats a pattern that names a directory.
  return new RegExp(`^${body}(?:/.*)?$`);
}

export function compileExcludes(patterns: readonly string[]): ExcludeMatcher {
  const regexes = patterns
    .map((p) => p.trim())
    .filter((p) => p.length > 0 && !p.startsWith("#"))
    .map(toRegExp);

  const isExcluded = (path: string): boolean => {
    const n = normalise(path);
    if (n === "") return false;
    return regexes.some((re) => re.test(n));
  };

  return {
    isExcluded,
    filter: (paths) => paths.filter((p) => !isExcluded(p)),
  };
}
