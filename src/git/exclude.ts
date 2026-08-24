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

  // Collapse redundant asterisk runs before translating them.
  //
  // Both collapses exist to stop the compiled regex backtracking exponentially in the
  // length of the path being tested. There is no timeout anywhere in the sync path, so
  // a slow pattern is not a stutter — it is a wedged app on a device where the user
  // can inspect nothing.
  //
  // Measured before these collapses, one `isExcluded` call:
  //   `**/` x12 against a depth-30 path      10.3 s
  //   `*` x13 + ".png" against an ordinary
  //   84-character vault path                27.1 s
  //   `*` x18 + "z.md"                       did not return in four minutes
  //
  // The `*` case is the one that matters in practice. `**/` x12 is not something a
  // person types; a held-down asterisk key, or a pasted `****************` separator,
  // is. `*` is also the wildcard users reach for, because the predecessor plugin
  // supported only `*`.
  //
  // Both rewrites are semantically free. Three or more asterisks in a row are exactly
  // `**`, because `.*` already subsumes the `[^/]*` that an odd trailing star would
  // add; and consecutive "any number of directories" groups say nothing more than one
  // of them does.
  p = p.replace(/\*{3,}/g, "**").replace(/(?:\*\*\/)+/g, "**/");

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

/**
 * True when a single pattern would exclude the whole vault.
 *
 * `*` excludes everything, because it matches a directory segment and every pattern
 * also matches what lies beneath whatever it matched. That is the same rule .gitignore
 * uses, and it is what makes a bare `.obsidian` protect the token file — but it means
 * one stray character in the exclude box silences the entire sync: nothing is staged,
 * nothing is pushed, and the sync still reports success over an empty change set.
 * Silent backup loss, on the platform where the user can inspect nothing.
 *
 * Decided empirically rather than by inspecting the pattern, so no amount of creative
 * asterisk arrangement can slip past a structural check.
 */
export function matchesEverything(pattern: string): boolean {
  const probes = [
    "a.md",
    "sub/a.md",
    "sub/deep/a.md",
    ".obsidian/app.json",
    "Attachments/img.png",
  ];
  const m = compileExcludes([pattern]);
  return probes.every((probe) => m.isExcluded(probe));
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
