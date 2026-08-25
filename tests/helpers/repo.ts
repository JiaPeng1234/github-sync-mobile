import git from "isomorphic-git";
import { createFs } from "../../src/git/fs-adapter";
import { compileExcludes } from "../../src/git/exclude";
import { MemoryAdapter } from "../mocks/memory-adapter";
import { SafeGit } from "../../src/git/safe-git";
import { COMMIT_AUTHOR } from "../../src/constants";

export interface Harness {
  adapter: MemoryAdapter;
  fs: ReturnType<typeof createFs>;
  dir: string;
  safeGit: SafeGit;
  /** Write a working-tree file. */
  write(path: string, content: string): Promise<void>;
  /** Stage and commit given paths, returning the new oid. */
  commit(paths: string[], message: string): Promise<string>;
}

export async function makeHarness(
  excludes: string[] = [".obsidian/", ".git/", ".trash/"],
): Promise<Harness> {
  const adapter = new MemoryAdapter();
  const fs = createFs(adapter, "");
  const dir = "";

  const safeGit = new SafeGit({
    fs,
    http: { request: async () => { throw new Error("network not used in this test"); } },
    dir,
    url: "https://github.com/o/r.git",
    token: "t",
    branch: "main",
    exclude: compileExcludes(excludes),
  });

  /**
   * Writes a working-tree file, creating parent folders first.
   *
   * The adapter deliberately refuses to invent parents, matching the real one. Real git
   * copes because isomorphic-git catches the failed write, mkdirs, and retries — but this
   * helper bypasses git, so it has to do that itself. Without this, `initRepo`'s first
   * line fails and with it every test in Tasks 7 through 12.
   */
  const write = async (path: string, content: string) => {
    const i = path.lastIndexOf("/");
    if (i > 0) await adapter.mkdir(path.slice(0, i));
    await adapter.write(path, content);
  };

  const commit = async (paths: string[], message: string) => {
    for (const p of paths) await git.add({ fs, dir, filepath: p });
    return git.commit({ fs, dir, message, author: COMMIT_AUTHOR });
  };

  return { adapter, fs, dir, safeGit, write, commit };
}

/** Initialise a repo on `main` with one commit. */
export async function initRepo(h: Harness): Promise<string> {
  await git.init({ fs: h.fs, dir: h.dir, defaultBranch: "main" });
  await h.write("notes/a.md", "first\n");
  return h.commit(["notes/a.md"], "initial");
}

/**
 * Simulate a fetched remote by pointing refs/remotes/origin/main at an oid,
 * so merge tests need no network.
 */
export async function setOriginRef(h: Harness, oid: string): Promise<void> {
  await git.writeRef({
    fs: h.fs,
    dir: h.dir,
    ref: "refs/remotes/origin/main",
    value: oid,
    force: true,
  });
}

/**
 * Build a second lineage to act as the remote, then restore local HEAD.
 *
 * Test scaffolding only — it uses force checkout to move between lineages,
 * which product code must never do.
 */
export async function divergeRemote(
  h: Harness,
  base: string,
  changes: Record<string, string>,
  message: string,
  /** Extra staging for cases text changes cannot express, e.g. binary writes. */
  extra?: () => Promise<void>,
): Promise<string> {
  const localHead = await git.resolveRef({ fs: h.fs, dir: h.dir, ref: "refs/heads/main" });

  await git.writeRef({ fs: h.fs, dir: h.dir, ref: "refs/heads/main", value: base, force: true });
  await git.checkout({ fs: h.fs, dir: h.dir, ref: "main", force: true });
  for (const [p, c] of Object.entries(changes)) await h.write(p, c);
  for (const p of Object.keys(changes)) await git.add({ fs: h.fs, dir: h.dir, filepath: p });
  if (extra) await extra();
  const remoteOid = await git.commit({ fs: h.fs, dir: h.dir, message, author: COMMIT_AUTHOR });

  await git.writeRef({ fs: h.fs, dir: h.dir, ref: "refs/heads/main", value: localHead, force: true });
  await git.checkout({ fs: h.fs, dir: h.dir, ref: "main", force: true });
  await setOriginRef(h, remoteOid);
  return remoteOid;
}
