import { ItemView, WorkspaceLeaf } from "obsidian";
import type GitHubSyncPlugin from "../main";

export const SYNC_VIEW_TYPE = "github-sync-mobile-view";

export class SyncView extends ItemView {
  private statusEl!: HTMLElement;

  constructor(leaf: WorkspaceLeaf, private readonly plugin: GitHubSyncPlugin) {
    super(leaf);
  }

  override getViewType(): string {
    return SYNC_VIEW_TYPE;
  }

  override getDisplayText(): string {
    return "GitHub Sync";
  }

  override getIcon(): string {
    return "refresh-cw";
  }

  override async onOpen(): Promise<void> {
    const root = this.contentEl;
    root.empty();
    root.style.padding = "12px";

    root.createEl("h3", { text: "GitHub Sync" });
    this.statusEl = root.createDiv({ cls: "gsm-status" });
    this.statusEl.style.marginBottom = "12px";
    this.statusEl.style.fontSize = "13px";

    const syncBtn = root.createEl("button", { text: "Sync now" });
    syncBtn.style.width = "100%";
    syncBtn.style.padding = "12px";
    syncBtn.style.fontWeight = "600";
    syncBtn.onclick = async () => {
      syncBtn.disabled = true;
      syncBtn.setText("Syncing…");
      try {
        await this.plugin.runSync();
      } finally {
        syncBtn.disabled = false;
        syncBtn.setText("Sync now");
        await this.refresh();
      }
    };

    const detail = root.createEl("details");
    detail.style.marginTop = "16px";
    detail.createEl("summary", { text: "Advanced" });

    const verbs = detail.createDiv();
    verbs.style.display = "flex";
    verbs.style.flexDirection = "column";
    verbs.style.gap = "6px";
    verbs.style.marginTop = "8px";

    this.verb(verbs, "Fetch", () => this.plugin.runFetch());
    this.verb(verbs, "Pull (fetch + safe merge)", () => this.plugin.runPull());
    this.verb(verbs, "Commit local changes", () => this.plugin.runCommit());
    this.verb(verbs, "Push", () => this.plugin.runPush());
    this.verb(verbs, "Show last log", () => {
      this.plugin.showLastLog();
      return Promise.resolve();
    });

    await this.refresh();
  }

  private verb(parent: HTMLElement, label: string, run: () => Promise<void>): void {
    const b = parent.createEl("button", { text: label });
    b.onclick = async () => {
      b.disabled = true;
      try {
        await run();
      } finally {
        b.disabled = false;
        await this.refresh();
      }
    };
  }

  async refresh(): Promise<void> {
    if (!this.statusEl) return;
    this.statusEl.setText(await this.plugin.statusLine());
  }
}
