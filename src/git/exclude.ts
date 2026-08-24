export interface ExcludeMatcher {
  isExcluded(path: string): boolean;
  /**
   * Keeps only the non-excluded paths, preserving order.
   *
   * Named for what it returns rather than what it removes: read as `filter`, a call
   * site could plausibly be understood as keeping the excluded ones, and inverted at
   * clone-checkout that would write the remote's `.obsidian` over this device's config
   * and skip every note.
   */
  withoutExcluded(paths: string[]): string[];
}

/** Vault-relative, forward slashes, no leading ./ or /. */
function normalise(p: string): string {
  let out = p.replace(/\\/g, "/").trim();
  while (out.startsWith("./")) out = out.slice(2);
  while (out.startsWith("/")) out = out.slice(1);
  return out.replace(/\/{2,}/g, "/");
}

function toRegExp(rawPattern: string): RegExp {
  let p = normalise(rawPattern);

  // `dir/`, `dir/*` and `dir/**` all mean "dir and everything under it". Users of the
  // prior plugin wrote `dir/*` expecting recursion, so honour that intent rather than
  // silently under-matching. All three collapse to the bare name, because the
  // trailing-subtree match below applies to every pattern.
  //
  // Not redundant: stripping them is what makes `isExcluded(".obsidian")` true for
  // every spelling, which is how a caller prunes a whole subtree instead of walking
  // into it.
  if (p.endsWith("/**")) p = p.slice(0, -3);
  else if (p.endsWith("/*")) p = p.slice(0, -2);
  else if (p.endsWith("/")) p = p.slice(0, -1);

  // Collapse asterisk runs before translating them. Adjacent `.*` groups backtrack
  // exponentially in the length of the path being tested, and there is no timeout
  // anywhere in the sync path — so a pasted `****` is a wedged app, not a stutter.
  // Neither rewrite can ever broaden a pattern, and the star-run rewrite additionally
  // repairs a pre-existing over-match in `*{3,}/` shapes.
  //
  // Measurements, and why the plain-`*` case is the one that actually reaches a
  // settings box, are in docs/decisions-and-learnings.md under "A user-editable regex
  // is an attack surface on your own phone".
  p = p.replace(/\*{3,}/g, "**").replace(/(?:\*\*\/)+/g, "**/");

  // One ordered pass: longest wildcard first, everything else escaped.
  //
  // Single-pass is deliberate. A multi-step pipeline needs a placeholder to stop the
  // `*` rule eating the asterisks inside `**`, and a printable placeholder would itself
  // be rewritten — so `My Notes` would compile to `^My.*Notes$` and match
  // `My/Notes/a.md`. Over-matching an exclude means the file is never pushed, which is
  // silent backup loss. Here there is no placeholder to get wrong, and escaping cannot
  // accidentally run before translation.
  const body = p.replace(/\*\*\/|\*\*|\*|[.+^${}()|[\]\\?]/g, (token) => {
    if (token === "**/") return "(?:.*/)?";
    if (token === "**") return ".*";
    if (token === "*") return "[^/]*";
    return `\\${token}`;
  });

  // Every pattern also matches everything beneath whatever it matched.
  //
  // This is what makes a bare `.obsidian` behave like `.obsidian/`. Without it, a user
  // who drops the trailing slash still excludes the directory entry but silently syncs
  // its contents — which for `.obsidian` means publishing the plugin's settings file,
  // and with it the GitHub token. Same rule .gitignore uses for a pattern naming a
  // directory.
  return new RegExp(`^${body}(?:/.*)?$`);
}

/**
 * True when a single pattern would exclude every file in any vault.
 *
 * Decided by probing rather than by inspecting the pattern, so no arrangement of
 * asterisks slips past a structural check.
 *
 * Detects *universality* only, and that limit is real: a pattern covering every
 * extension a given vault happens to use — `**` followed by `/*.md` in a Markdown-only
 * vault, the common Obsidian case — excludes everything the user has while sparing a
 * hypothetical `.png`, so it is not flagged here. The vault-relative question ("how many
 * of this user's files would this exclude?") can only be answered where the file list
 * is, so the settings tab reports that separately. Both matter, because silencing the
 * sync yields a successful-looking sync over an empty change set.
 */
export function matchesEverything(pattern: string): boolean {
  // Deliberately share no character in common. An earlier probe set all contained "a"
  // and ".", so patterns like `**a*` tripped it while sparing real files.
  const probes = [
    "a.md",
    "sub/a.md",
    "sub/deep/a.png",
    ".obsidian/app.json",
    "z",
    "Q3/log.txt",
    "no-extension",
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
    withoutExcluded: (paths) => paths.filter((p) => !isExcluded(p)),
  };
}
