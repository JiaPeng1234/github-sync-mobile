import { describe, it, expect } from "vitest";
import { compileExcludes, matchesEverything } from "../../src/git/exclude";
import { DEFAULT_EXCLUDES } from "../../src/constants";

describe("compileExcludes", () => {
  it("excludes a directory and everything beneath it", () => {
    const m = compileExcludes([".obsidian/"]);
    expect(m.isExcluded(".obsidian")).toBe(true);
    expect(m.isExcluded(".obsidian/app.json")).toBe(true);
    expect(m.isExcluded(".obsidian/plugins/x/data.json")).toBe(true);
  });

  it("does not exclude unrelated paths", () => {
    const m = compileExcludes([".obsidian/"]);
    expect(m.isExcluded("notes/a.md")).toBe(false);
    expect(m.isExcluded("obsidian-notes.md")).toBe(false);
  });

  // The prior plugin only supported `*`, so users wrote `.obsidian/*` and it
  // silently failed to match nested paths. Treat a trailing /* or /** as the
  // directory form so that footgun cannot recur.
  it("treats a trailing /* as the whole directory", () => {
    const m = compileExcludes([".obsidian/*"]);
    expect(m.isExcluded(".obsidian/plugins/x/data.json")).toBe(true);
  });

  it("treats a trailing /** as the whole directory", () => {
    const m = compileExcludes([".obsidian/**"]);
    expect(m.isExcluded(".obsidian/plugins/x/data.json")).toBe(true);
  });

  it("matches * within a single path segment only", () => {
    const m = compileExcludes(["*.png"]);
    expect(m.isExcluded("a.png")).toBe(true);
    expect(m.isExcluded("sub/a.png")).toBe(false);
  });

  it("matches ** across path segments", () => {
    const m = compileExcludes(["**/*.png"]);
    expect(m.isExcluded("sub/deep/a.png")).toBe(true);
  });

  it("normalises leading ./ and / in both pattern and path", () => {
    const m = compileExcludes(["/.obsidian/"]);
    expect(m.isExcluded("./.obsidian/app.json")).toBe(true);
  });

  it("ignores blank lines and # comments", () => {
    const m = compileExcludes(["", "  ", "# a comment", ".git/"]);
    expect(m.isExcluded(".git/config")).toBe(true);
    expect(m.isExcluded("notes/a.md")).toBe(false);
  });

  it("excludes nothing when given no patterns", () => {
    const m = compileExcludes([]);
    expect(m.isExcluded(".obsidian/app.json")).toBe(false);
  });

  it("escapes regex metacharacters in patterns", () => {
    const m = compileExcludes(["a+b.md"]);
    expect(m.isExcluded("a+b.md")).toBe(true);
    expect(m.isExcluded("aab.md")).toBe(false);
  });

  it("applies the shipped defaults to the paths that caused the original bug", () => {
    const m = compileExcludes(DEFAULT_EXCLUDES);
    expect(m.isExcluded(".obsidian/app.json")).toBe(true);
    expect(m.isExcluded(".obsidian/plugins/github-sync-mobile/data.json")).toBe(true);
    expect(m.isExcluded(".git/config")).toBe(true);
    expect(m.isExcluded(".trash/old.md")).toBe(true);
    expect(m.isExcluded("LifeSystem/Skills.md")).toBe(false);
  });

  it("filters a list of paths, keeping order", () => {
    const m = compileExcludes([".obsidian/"]);
    expect(m.filter(["a.md", ".obsidian/app.json", "b.md"])).toEqual(["a.md", "b.md"]);
  });

  // A user editing the exclude list may drop the trailing slash. Without this, the
  // directory entry is excluded but its contents are not -- and for `.obsidian` that
  // means publishing the plugin's settings file, and with it the GitHub token.
  it("treats a bare directory name as the whole directory", () => {
    const m = compileExcludes([".obsidian"]);
    expect(m.isExcluded(".obsidian")).toBe(true);
    expect(m.isExcluded(".obsidian/app.json")).toBe(true);
    expect(m.isExcluded(".obsidian/plugins/github-sync-mobile/data.json")).toBe(true);
  });

  it("still does not match a sibling whose name merely starts the same", () => {
    const m = compileExcludes([".obsidian"]);
    expect(m.isExcluded(".obsidian-backup/app.json")).toBe(false);
    expect(m.isExcluded("my.obsidian")).toBe(false);
  });

  it("matches ** across zero directories as well as many", () => {
    const m = compileExcludes(["**/*.png"]);
    expect(m.isExcluded("a.png")).toBe(true);
    expect(m.isExcluded("sub/a.png")).toBe(true);
    expect(m.isExcluded("sub/deep/a.png")).toBe(true);
    expect(m.isExcluded("a.md")).toBe(false);
  });

  it("matches a mid-pattern ** across zero directories as well as many", () => {
    const m = compileExcludes(["a/**/b.md"]);
    expect(m.isExcluded("a/b.md")).toBe(true);
    expect(m.isExcluded("a/x/b.md")).toBe(true);
    expect(m.isExcluded("a/x/y/b.md")).toBe(true);
    expect(m.isExcluded("b.md")).toBe(false);
  });

  /**
   * Patterns come from a user-editable settings box. Before consecutive `**\/`
   * groups were collapsed, twelve of them took over four seconds for a single deep
   * path and eighteen seconds to filter two thousand -- an unresponsive phone with no
   * timeout and nothing to show the user. Generous budget so this pins the exponent,
   * not the machine.
   */
  it("does not backtrack catastrophically on repeated ** groups", () => {
    const m = compileExcludes(["**/".repeat(12) + "z.md"]);
    const deepPath = Array.from({ length: 30 }, (_, i) => `d${i}`).join("/") + "/a.md";
    const started = performance.now();
    expect(m.isExcluded(deepPath)).toBe(false);
    expect(performance.now() - started).toBeLessThan(250);
  });

  it("filters a large deep vault promptly with the shipped defaults", () => {
    const m = compileExcludes(DEFAULT_EXCLUDES);
    const paths = Array.from(
      { length: 3000 },
      (_, i) => `${Array.from({ length: 12 }, (_, d) => `d${d}`).join("/")}/n${i}.md`,
    );
    const started = performance.now();
    expect(m.filter(paths).length).toBe(3000);
    expect(performance.now() - started).toBeLessThan(500);
  });

  /**
   * The shape that actually reaches a settings box. A held-down asterisk key or a
   * pasted separator line produces this, and before the star-run collapse thirteen
   * asterisks took 27 seconds for one ordinary vault path while eighteen never
   * returned. Budget is generous on purpose: this pins the exponent, not the machine.
   */
  it("does not backtrack catastrophically on a run of plain asterisks", () => {
    const realisticPath =
      "LifeSystem/Projects/2026/Q3/meetings/platform/migration/round2/drafts/notes-final.md";
    for (const stars of [7, 13, 18, 30]) {
      const m = compileExcludes(["*".repeat(stars) + ".png"]);
      const started = performance.now();
      expect(m.isExcluded(realisticPath)).toBe(false);
      expect(performance.now() - started).toBeLessThan(250);
    }
  });

  it("treats three or more asterisks as **, which is what they already meant", () => {
    const two = compileExcludes(["**"]);
    for (const stars of [3, 5, 12]) {
      const many = compileExcludes(["*".repeat(stars)]);
      for (const p of ["a.md", "sub/a.md", "sub/deep/a.png"]) {
        expect(many.isExcluded(p)).toBe(two.isExcluded(p));
      }
    }
  });
});

describe("matchesEverything", () => {
  // One stray character in the exclude box would otherwise silence the whole sync,
  // reporting success over an empty change set.
  it("flags patterns that would exclude the entire vault", () => {
    for (const p of ["*", "**", "*/", "**/", "***", "****************"]) {
      expect(matchesEverything(p)).toBe(true);
    }
  });

  it("does not flag ordinary patterns, including the shipped defaults", () => {
    for (const p of [".obsidian", ".obsidian/", ".git/", ".trash/", "*.png", "**/*.png", "notes"]) {
      expect(matchesEverything(p)).toBe(false);
    }
    for (const p of DEFAULT_EXCLUDES) expect(matchesEverything(p)).toBe(false);
  });
});
