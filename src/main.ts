import { Notice, Plugin, WorkspaceLeaf } from "obsidian";
import {
  DEFAULT_BRANCH,
  DEFAULT_COMMIT_TEMPLATE,
  DEFAULT_EXCLUDES,
  TIMESTAMP_TOKEN,
  repoUrl,
} from "./constants";
import { compileExcludes } from "./git/exclude";
import { createFs } from "./git/fs-adapter";
import { httpClient } from "./git/http-client";
import {
  isInterruptedCheckoutRefusal,
  SafeGit,
  type ConflictResolution,
} from "./git/safe-git";
import { GitHubApi } from "./github/api";
import { SyncService } from "./sync/sync-service";
import { ConflictModal } from "./ui/conflict-modal";
import { LogModal } from "./ui/log-modal";
import { RecoveryModal } from "./ui/recovery-modal";
import { SettingsTab } from "./ui/settings-tab";
import { SYNC_VIEW_TYPE, SyncView } from "./ui/sync-view";
import type { PluginSettings, SyncReport } from "./types";

const DEFAULT_SETTINGS: PluginSettings = {
  token: "",
  owner: "",
  repo: "",
  branch: DEFAULT_BRANCH,
  excludePatterns: [...DEFAULT_EXCLUDES],
  verboseLog: false,
  commitMessageTemplate: DEFAULT_COMMIT_TEMPLATE,
};

export default class GitHubSyncPlugin extends Plugin {
  override settings: PluginSettings = { ...DEFAULT_SETTINGS };
  private lastReport: SyncReport | null = null;
  private logLines: string[] = [];
  /** Why the current settings cannot produce a client, if they cannot. */
  private configError: string | null = null;

  override async onload(): Promise<void> {
    await this.loadSettings();
    this.addSettingTab(new SettingsTab(this.app, this));
    this.registerView(SYNC_VIEW_TYPE, (leaf: WorkspaceLeaf) => new SyncView(leaf, this));
    this.addRibbonIcon("refresh-cw", "GitHub Sync", () => this.openView());
    this.addCommand({ id: "open-github-sync", name: "Open GitHub Sync panel", callback: () => this.openView() });
    this.addCommand({ id: "sync-now", name: "Sync now", callback: () => void this.runSync() });
    this.addCommand({ id: "connect-repo", name: "Connect this vault to GitHub", callback: () => void this.connect() });
  }

  override async onunload(): Promise<void> {
    // Nothing to flush: sync only ever runs on explicit user action.
  }

  async loadSettings(): Promise<void> {
    this.settings = { ...DEFAULT_SETTINGS, ...(await this.loadData()) };
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  private async openView(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(SYNC_VIEW_TYPE);
    if (existing.length > 0) { await this.app.workspace.revealLeaf(existing[0]); return; }
    const leaf = this.app.workspace.getRightLeaf(false);
    if (!leaf) return;
    await leaf.setViewState({ type: SYNC_VIEW_TYPE, active: true });
    await this.app.workspace.revealLeaf(leaf);
  }

  /**
   * Builds a SafeGit bound to current settings, or null when the settings cannot
   * produce one. Returns null rather than throwing: `repoUrl` rejects a malformed
   * owner or repo, and an unhandled throw here would leave every button inert with
   * no explanation — the exact unexaminable failure this plugin exists to avoid.
   */
  private makeGit(): SafeGit | null {
    const s = this.settings;
    if (!s.token || !s.owner || !s.repo) return null;
    let url: string;
    try { url = repoUrl(s.owner, s.repo); }
    catch (err) { this.configError = err instanceof Error ? err.message : String(err); return null; }
    this.configError = null;
    const adapter = this.app.vault.adapter;
    const base = (adapter as { basePath?: string }).basePath ?? "";
    this.logLines = [];
    return new SafeGit({
      fs: createFs(adapter, base),
      http: httpClient,
      dir: base,
      url,
      token: s.token,
      branch: s.branch,
      exclude: compileExcludes(s.excludePatterns),
      onLog: (line) => this.logLines.push(line),
    });
  }

  private requireGit(): SafeGit | null {
    const git = this.makeGit();
    if (!git) new Notice(this.configError ?? "Set your token, owner, and repository in settings first");
    return git;
  }

  private commitMessage(): string {
    return this.settings.commitMessageTemplate.replace(TIMESTAMP_TOKEN, new Date().toLocaleString());
  }

  async connect(): Promise<void> {
    const git = this.requireGit();
    if (!git) return;
    const s = this.settings;
    const api = new GitHubApi(s.token);
    const who = await api.verifyToken();
    if (!who.ok) { new Notice(`Token rejected: ${who.error}`); return; }
    const info = await api.inspectRepo(s.owner, s.repo);
    if (!info.exists) { new Notice(`Repository ${s.owner}/${s.repo} not found. Create it on GitHub first.`); return; }
    const decision = await git.decideConnect({ remoteHasContent: info.hasContent });
    if (decision.kind === "refuse") {
      new Notice(decision.reason, 15000);
      new LogModal(this.app, "Cannot connect", [decision.reason]).open();
      return;
    }
    try {
      if (decision.kind === "clone-safe") {
        new Notice("Cloning from GitHub…");
        await git.cloneSafe();
        new Notice("Connected. Your notes have been downloaded.");
      } else if (decision.kind === "init-push") {
        new Notice("Remote is empty — pushing this vault…");
        await git.initAndPush(this.commitMessage());
        new Notice("Connected. Your vault is now on GitHub.");
      } else {
        new Notice("Already connected to this repository.");
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      new Notice(`Connect failed: ${msg}`, 10000);
      new LogModal(this.app, "Connect failed", [...this.logLines, "", msg]).open();
    }
  }

  async runSync(): Promise<void> {
    const git = this.requireGit();
    if (!git) return;
    if (!(await git.isRepo())) { new Notice("Not connected yet — run 'Connect this vault to GitHub' first"); return; }
    const service = new SyncService(git, () => this.commitMessage());
    let report: SyncReport;
    try { report = await service.sync(); }
    catch (err) {
      if (isInterruptedCheckoutRefusal(err)) { void this.openRecovery(git, () => this.runSync()); return; }
      new Notice(err instanceof Error ? err.message : String(err)); return;
    }
    for (const line of this.logLines) report.logs.push(line);
    this.lastReport = report;
    if (report.conflicts.length > 0) {
      new ConflictModal(this.app, report.conflicts,
        (resolutions) => void this.applyResolutions(git, resolutions),
        () => { git.abandonConflict(); new Notice("Conflict left unresolved. Nothing was changed."); },
      ).open();
      return;
    }
    if (!report.success) { new Notice("Sync stopped — see the log"); LogModal.fromReport(this.app, report).open(); return; }
    new Notice("Sync complete");
    if (this.settings.verboseLog) LogModal.fromReport(this.app, report).open();
  }

  private async applyResolutions(git: SafeGit, resolutions: ConflictResolution[]): Promise<void> {
    try {
      await git.resolveConflicts(resolutions);
      const pushed = await git.push();
      new Notice(pushed ? "Conflicts resolved and pushed" : "Conflicts resolved");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      new Notice(`Could not finish resolving: ${msg}`, 10000);
      new LogModal(this.app, "Resolution failed", [...this.logLines, "", msg]).open();
    }
  }

  async runFetch(): Promise<void> {
    const git = this.requireGit();
    if (!git) return;
    try { const oid = await git.fetch(); new Notice(oid ? `Fetched ${oid.slice(0, 7)}` : "Remote has no commits"); }
    catch (err) { new Notice(`Fetch failed: ${err instanceof Error ? err.message : String(err)}`); }
  }

  async runPull(): Promise<void> {
    const git = this.requireGit();
    if (!git) return;
    try {
      await git.fetch();
      const outcome = await git.mergeSafe();
      if (outcome.kind === "conflict") {
        new ConflictModal(this.app, outcome.files,
          (r) => void this.applyResolutions(git, r),
          () => { git.abandonConflict(); new Notice("Conflict left unresolved. Nothing was changed."); },
        ).open();
        return;
      }
      if (outcome.kind === "unmergeable") {
        const detail = outcome.reason === "unrelated-histories"
          ? "This vault and the remote share no history, so they cannot be merged here."
          : "The history diverged in a way the git engine cannot merge.";
        new Notice(`${detail} Nothing was changed.`, 15000);
        new LogModal(this.app, "Cannot merge", [...this.logLines, "", detail]).open();
        return;
      }
      new Notice(`Pull: ${outcome.kind}`);
    } catch (err) { new Notice(`Pull failed: ${err instanceof Error ? err.message : String(err)}`); }
  }

  async runCommit(): Promise<void> {
    const git = this.requireGit();
    if (!git) return;
    try { const oid = await git.commitLocal(this.commitMessage()); new Notice(oid ? `Committed ${oid.slice(0, 7)}` : "Nothing to commit"); }
    catch (err) {
      if (isInterruptedCheckoutRefusal(err)) { void this.openRecovery(git, () => this.runCommit()); return; }
      new Notice(`Commit failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async runPush(): Promise<void> {
    const git = this.requireGit();
    if (!git) return;
    try { const pushed = await git.push(); new Notice(pushed ? "Pushed" : "Nothing to push"); }
    catch (err) { new Notice(`Push failed: ${err instanceof Error ? err.message : String(err)}`); }
  }

  /**
   * Opens the stop-and-ask for the ambiguous interrupted-checkout state, then re-runs
   * the caller's action once the user has chosen. Restore re-materialises from HEAD (the
   * interrupted-download answer); Delete commits the removal after a confirming tap (the
   * "I deleted it" answer). The path list comes from the read-only listInterruptedCheckouts.
   */
  private async openRecovery(git: SafeGit, retry: () => Promise<void>): Promise<void> {
    let paths: string[];
    try {
      paths = await git.listInterruptedCheckouts();
    } catch (err) {
      // A read failure while listing must not be swallowed — surface it, do not guess.
      new Notice(`Could not check for interrupted downloads: ${err instanceof Error ? err.message : String(err)}`, 10000);
      return;
    }
    if (paths.length === 0) {
      // The ambiguity cleared between the throw and now (e.g. a concurrent restore). Nothing to ask.
      new Notice("Nothing left to recover — try again.");
      return;
    }
    new RecoveryModal(
      this.app,
      paths,
      () => void this.recover(git, retry, () => git.restoreFromHead(paths), "Restored from history."),
      () => void this.recover(git, retry, () => git.confirmDeletion(paths, this.commitMessage()).then(() => {}), "Deletion committed."),
    ).open();
  }

  /** Runs one recovery action, reports it, then retries the interrupted operation. */
  private async recover(
    git: SafeGit,
    retry: () => Promise<void>,
    action: () => Promise<void>,
    okMessage: string,
  ): Promise<void> {
    try {
      await action();
      new Notice(okMessage);
      await retry();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      new Notice(`Recovery failed: ${msg}`, 10000);
      new LogModal(this.app, "Recovery failed", [...this.logLines, "", msg]).open();
    }
  }

  showLastLog(): void {
    if (!this.lastReport) { new Notice("No sync has run yet"); return; }
    LogModal.fromReport(this.app, this.lastReport).open();
  }

  async statusLine(): Promise<string> {
    const git = this.makeGit();
    if (!git) return this.configError ?? "Not configured — open settings";
    if (!(await git.isRepo())) return "Not connected";
    try { const s = await git.status(); return `${s.changed.length} changed · ${s.ahead} ahead · ${s.behind} behind`; }
    catch { return "Connected"; }
  }
}
