import { App, Modal, Notice } from "obsidian";
import type { SyncReport } from "../types";

export class LogModal extends Modal {
  constructor(
    app: App,
    private readonly title: string,
    private readonly lines: string[],
  ) {
    super(app);
  }

  static fromReport(app: App, report: SyncReport): LogModal {
    const lines = report.steps.map((s) => `[${s.result}] ${s.name}: ${s.detail}`);
    if (report.logs.length > 0) lines.push("", ...report.logs);
    return new LogModal(app, report.success ? "Sync complete" : "Sync stopped", lines);
  }

  override onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h3", { text: this.title });

    const pre = contentEl.createEl("pre", {
      cls: "gsm-log",
      text: this.lines.join("\n"),
    });
    pre.style.whiteSpace = "pre-wrap";
    pre.style.userSelect = "text";
    pre.style.maxHeight = "50vh";
    pre.style.overflow = "auto";

    const copy = contentEl.createEl("button", { text: "Copy" });
    copy.onclick = async () => {
      // On an iOS WebView `navigator.clipboard` can be undefined or reject outside a
      // secure/user-gesture context. Without this guard the async handler's rejection is
      // a silent no-op — the one thing this modal exists to do (get the log off the phone)
      // would fail with no console to explain why. The <pre> is user-selectable, so fall
      // back to telling the user to select it by hand. Note we must not `?.` past a missing
      // clipboard and still claim success: an absent clipboard is a failure, not a copy.
      try {
        if (!navigator.clipboard) throw new Error("clipboard unavailable");
        await navigator.clipboard.writeText(this.lines.join("\n"));
        new Notice("Log copied");
      } catch {
        new Notice("Copy not supported — select the text and copy manually");
      }
    };
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}
