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
 * Sentinel standing in for `**` while `*` is being translated, so the two do
 * not interfere. NUL is safe because it cannot appear in a vault path — a
 * printable placeholder such as a space could, and would then be rewritten
 * into `.*`, silently over-matching every path containing that character.
 * Written as an escape so the file stays textual to `grep` and survives
 * copy-paste.
 */
const DOUBLE_STAR = "\u0000";

function toRegExp(rawPattern: string): RegExp {
  let p = normalise(rawPattern);

  // A directory pattern. `dir/`, `dir/*` and `dir/**` all mean "dir and
  // everything under it" — users of the prior plugin wrote `dir/*` expecting
  // recursion, so honour that intent rather than silently under-matching.
  let isDir = false;
  if (p.endsWith("/**")) {
    p = p.slice(0, -3);
    isDir = true;
  } else if (p.endsWith("/*")) {
    p = p.slice(0, -2);
    isDir = true;
  } else if (p.endsWith("/")) {
    p = p.slice(0, -1);
    isDir = true;
  }

  const body = p
    .replace(/[.+^${}()|[\]\\?]/g, "\\$&")
    .replace(/\*\*/g, DOUBLE_STAR)
    .replace(/\*/g, "[^/]*")
    .split(DOUBLE_STAR)
    .join(".*");

  return new RegExp(isDir ? `^${body}(?:/.*)?$` : `^${body}$`);
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
