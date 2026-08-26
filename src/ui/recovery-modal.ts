import { App, Modal } from "obsidian";

/**
 * The stop-and-ask for the ambiguous interrupted-checkout state.
 *
 * These paths are in committed history but absent from disk and were never staged
 * ([head=1, workdir=0, stage=0]). That is genuinely undecidable by the tool: EITHER a
 * sync was interrupted before the download finished, OR the user deleted the files.
 * Committing them as a removal would push away files that still exist on the remote —
 * the one thing this plugin must never do — so the choice is handed to a person.
 *
 * Restore is the primary, safe action; it only re-materialises from history and cannot
 * lose data. Delete is secondary and requires a second, confirming tap before it fires,
 * because it commits a deletion. Dismissing the modal (X / Esc) does NOTHING: it never
 * auto-restores and never auto-deletes. `acted` is set only when the user explicitly
 * chose an action, mirroring ConflictModal's `resolved` flag.
 *
 * Pure UI: it holds no SafeGit reference and calls only the two callbacks it was given,
 * so the caller (Task 17/18) owns which SafeGit method each one drives.
 */
export class RecoveryModal extends Modal {
  private acted = false;

  constructor(
    app: App,
    private readonly paths: readonly string[],
    private readonly onRestore: () => void,
    private readonly onDelete: () => void,
  ) {
    super(app);
  }

  override onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl("h3", {
      text: `${this.paths.length} file${this.paths.length === 1 ? "" : "s"} missing from this device`,
    });
    contentEl.createEl("p", {
      text:
        "These files are in your history but are not on this device right now. " +
        "A sync may have been interrupted before it finished downloading them, or " +
        "you may have deleted them. This cannot be decided automatically, so please choose.",
    });

    const list = contentEl.createEl("ul");
    list.style.marginTop = "8px";
    list.style.marginBottom = "12px";
    for (const path of this.paths) {
      list.createEl("li", { text: path });
    }

    // Restore — primary and safe. It only re-materialises from history, so it can never
    // lose data; it is the default answer for "the sync was interrupted".
    const restore = contentEl.createEl("button", { text: "Restore from history" });
    restore.style.marginRight = "8px";
    restore.style.fontWeight = "700";
    restore.style.border = "2px solid var(--interactive-accent)";
    restore.style.background = "var(--interactive-accent)";
    restore.style.color = "var(--text-on-accent)";
    restore.onclick = () => {
      this.acted = true;
      this.onRestore();
      this.close();
    };

    // Delete — secondary, and it commits a deletion, so it demands a second confirming
    // tap. The first tap only arms the confirm state; there is no pre-selected default
    // that would commit a deletion.
    const del = contentEl.createEl("button", { text: `Delete ${this.paths.length === 1 ? "this file" : "these files"}` });
    let armed = false;
    del.onclick = () => {
      if (!armed) {
        armed = true;
        del.setText(`Really delete ${this.paths.length} file${this.paths.length === 1 ? "" : "s"} from your GitHub backup too? Tap again to confirm`);
        del.style.fontWeight = "700";
        del.style.border = "2px solid var(--text-error)";
        del.style.color = "var(--text-error)";
        return;
      }
      this.acted = true;
      this.onDelete();
      this.close();
    };
  }

  override onClose(): void {
    this.contentEl.empty();
    // Dismissing without choosing must do nothing destructive: no restore, no delete.
    // The two actions have already fired their callback by the time they close(), and
    // `acted` records that, so there is deliberately nothing to do here.
    void this.acted;
  }
}
