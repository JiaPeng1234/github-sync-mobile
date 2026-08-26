import { App, Modal } from "obsidian";
import type { ConflictFile, ConflictSide } from "../types";
import type { ConflictResolution } from "../git/safe-git";

/**
 * Per-file whole-file choice. Both versions already exist in git history, so
 * neither option destroys anything — the losing side is only postponed.
 */
export class ConflictModal extends Modal {
  private readonly choices = new Map<string, "mine" | "theirs">();

  constructor(
    app: App,
    private readonly files: readonly ConflictFile[],
    private readonly onResolve: (r: ConflictResolution[]) => void,
    private readonly onAbandon: () => void,
  ) {
    super(app);
  }

  private resolved = false;

  override onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h3", { text: `Resolve ${this.files.length} conflict(s)` });
    contentEl.createEl("p", {
      text:
        "Both versions are saved in history, so nothing is lost either way. " +
        "Pick which version should be kept for each file.",
    });

    for (const file of this.files) {
      const box = contentEl.createDiv({ cls: "gsm-conflict" });
      box.style.border = "1px solid var(--background-modifier-border)";
      box.style.borderRadius = "8px";
      box.style.padding = "10px";
      box.style.marginBottom = "10px";

      box.createEl("strong", { text: file.path });

      const row = box.createDiv();
      row.style.display = "flex";
      row.style.gap = "8px";
      row.style.marginTop = "8px";

      // A side that could not be read cannot be chosen. If neither side is
      // readable the file is undecidable, so say so rather than leaving two dead
      // buttons and an Apply that never activates.
      if (file.ours.state === "unreadable" && file.theirs.state === "unreadable") {
        box.createEl("p", {
          text:
            "Neither version could be read, so this file cannot be resolved here. " +
            "Both versions remain in history.",
        });
        continue;
      }

      const mine = row.createEl("button", { text: describe("Keep mine", file.ours) });
      const theirs = row.createEl("button", { text: describe("Keep theirs", file.theirs) });
      if (file.ours.state === "unreadable") mine.disabled = true;
      if (file.theirs.state === "unreadable") theirs.disabled = true;

      // Bold alone is too subtle on a phone for a choice that decides which version
      // wins, so the selected side also gets the accent background/border.
      const paint = () => {
        const c = this.choices.get(file.path);
        for (const [btn, val] of [[mine, "mine"], [theirs, "theirs"]] as const) {
          const on = c === val;
          btn.style.fontWeight = on ? "700" : "400";
          btn.style.border = on ? "2px solid var(--interactive-accent)" : "";
          btn.style.background = on ? "var(--interactive-accent)" : "";
          btn.style.color = on ? "var(--text-on-accent)" : "";
        }
      };
      mine.onclick = () => { this.choices.set(file.path, "mine"); paint(); };
      theirs.onclick = () => { this.choices.set(file.path, "theirs"); paint(); };
      paint();
    }

    const decidable = this.files.filter(
      (f) => !(f.ours.state === "unreadable" && f.theirs.state === "unreadable"),
    );

    // "Apply resolution", not "Apply and push": this modal only hands the choices
    // back to the sync view, which then commits and pushes and reports that outcome.
    // Claiming "…and push" here would lie if the later push fails.
    const apply = contentEl.createEl("button", { text: "Apply resolution" });
    apply.style.marginTop = "6px";
    apply.onclick = () => {
      if (this.choices.size !== decidable.length) return;
      this.resolved = true;
      this.onResolve(
        decidable.map((f) => ({ path: f.path, choice: this.choices.get(f.path)! })),
      );
      this.close();
    };
    if (decidable.length === 0) apply.disabled = true;
  }

  override onClose(): void {
    this.contentEl.empty();
    // Dismissing without deciding must leave the repo untouched.
    if (!this.resolved) this.onAbandon();
  }
}

/**
 * Summarises a side without ever rendering raw bytes. A binary attachment gets a
 * size, which is more useful than a wall of replacement characters would be, and
 * an unreadable side says so plainly rather than looking like an empty file.
 */
function describe(label: string, side: ConflictSide): string {
  switch (side.state) {
    case "absent":
      return `${label} (deleted)`;
    case "text": {
      const lines = side.content.split("\n").length;
      return `${label} (${lines} line${lines === 1 ? "" : "s"})`;
    }
    case "binary":
      return `${label} (binary, ${formatBytes(side.bytes.byteLength)})`;
    case "unreadable":
      return `${label} (unreadable)`;
  }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
