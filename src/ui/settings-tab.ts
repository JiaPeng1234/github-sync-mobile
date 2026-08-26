import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type GitHubSyncPlugin from "../main";
import { DEFAULT_EXCLUDES, TIMESTAMP_TOKEN } from "../constants";
import { compileExcludes, matchesEverything } from "../git/exclude";
import { GitHubApi } from "../github/api";

/** Every file in the vault, recursively. Folders are walked, not reported. */
async function listVaultFiles(
  adapter: { list(path: string): Promise<{ files: string[]; folders: string[] }> },
  path: string,
): Promise<string[]> {
  const out: string[] = [];
  const { files, folders } = await adapter.list(path);
  out.push(...files);
  for (const folder of folders) out.push(...(await listVaultFiles(adapter, folder)));
  return out;
}

export class SettingsTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: GitHubSyncPlugin) {
    super(app, plugin);
  }

  override display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "GitHub Sync Mobile" });

    new Setting(containerEl)
      .setName("Personal access token")
      .setDesc(
        "Fine-grained token with Contents: read and write on just this repository. " +
          "Stored in this vault's plugin settings, which is why .obsidian must stay excluded.",
      )
      .addText((t) => {
        t.inputEl.type = "password";
        t.setPlaceholder("github_pat_...")
          .setValue(this.plugin.settings.token)
          .onChange(async (v) => {
            this.plugin.settings.token = v.trim();
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Repository owner")
      .setDesc("Your GitHub username or the organisation that owns the repo.")
      .addText((t) =>
        t
          .setPlaceholder("JiaPeng1234")
          .setValue(this.plugin.settings.owner)
          .onChange(async (v) => {
            this.plugin.settings.owner = v.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Repository name")
      .setDesc("Named explicitly so the wrong repo can never be connected by accident.")
      .addText((t) =>
        t
          .setPlaceholder("my-vault")
          .setValue(this.plugin.settings.repo)
          .onChange(async (v) => {
            this.plugin.settings.repo = v.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Branch")
      .addText((t) =>
        t.setValue(this.plugin.settings.branch).onChange(async (v) => {
          this.plugin.settings.branch = v.trim() || "main";
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl).setName("Connection").addButton((b) =>
      b.setButtonText("Test connection").onClick(async () => {
        const s = this.plugin.settings;
        if (!s.token || !s.owner || !s.repo) {
          new Notice("Fill in token, owner, and repository first");
          return;
        }
        // verifyToken/inspectRepo are thin and let a network failure (requestUrl reject)
        // propagate. On a phone that would be a silent unhandled rejection, so catch it
        // here and tell the user, rather than fattening the client. (Task 16 plan header.)
        try {
          const api = new GitHubApi(s.token);
          const who = await api.verifyToken();
          if (!who.ok) {
            new Notice(`Token rejected: ${who.error}`);
            return;
          }
          const info = await api.inspectRepo(s.owner, s.repo);
          new Notice(
            info.exists
              ? `OK as ${who.login} — repo found${info.hasContent ? " with content" : " (empty)"}`
              : `Signed in as ${who.login}, but ${s.owner}/${s.repo} was not found`,
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          new Notice(`Could not reach GitHub — check your connection. (${msg})`);
        }
      }),
    );

    containerEl.createEl("h3", { text: "What syncs" });

    new Setting(containerEl)
      .setName("Sync Obsidian config (.obsidian)")
      .setDesc(
        "Off by default. Turning this on publishes your access token to GitHub, " +
          "because plugin settings are stored in .obsidian in plain text.",
      )
      .addToggle((t) =>
        t.setValue(!this.hasExclude(".obsidian")).onChange(async (on) => {
          if (on) {
            const ok = window.confirm(
              "Syncing .obsidian will upload this plugin's settings — including your " +
                "GitHub token — to the repository. Continue?",
            );
            if (!ok) {
              this.display();
              return;
            }
            this.plugin.settings.excludePatterns =
              this.plugin.settings.excludePatterns.filter(
                (p) => !p.startsWith(".obsidian"),
              );
          } else if (!this.hasExclude(".obsidian")) {
            this.plugin.settings.excludePatterns.push(".obsidian/");
          }
          await this.plugin.saveSettings();
          this.display();
        }),
      );

    // A pattern that matches everything silences the entire sync: nothing is staged,
    // nothing is pushed, and the sync still reports success over an empty change set.
    // `*` does this, because every pattern also matches what lies beneath what it
    // matched. On iOS the user cannot inspect anything, so it has to be caught here.
    const universal = this.plugin.settings.excludePatterns.filter(matchesEverything);
    if (universal.length > 0) {
      const warning = containerEl.createEl("p", {
        text:
          `Warning: ${universal.map((p) => `"${p}"`).join(", ")} matches every possible ` +
          `file, so nothing will be synced at all. Remove it or make it more specific.`,
      });
      warning.style.color = "var(--text-error)";
      warning.style.fontWeight = "600";
    }

    // `matchesEverything` only catches patterns that are universal in the abstract. A
    // pattern can still exclude this particular user's entire vault while sparing some
    // hypothetical file — `**` plus `/*.md` in a Markdown-only vault, which is the common
    // Obsidian case. The vault-relative count is the only way to see that, and it also
    // surfaces a typo'd pattern that matches nothing and a case-mismatched one such as
    // `.Obsidian/`.
    //
    // Filled in asynchronously: `display()` is synchronous in Obsidian's API, and
    // widening it to return a promise would be a signature nobody awaits.
    const coverage = containerEl.createEl("p", { text: "Counting excluded files…" });
    void this.renderCoverage(coverage);

    new Setting(containerEl)
      .setName("Excluded paths (advanced)")
      .setDesc(
        "One pattern per line. A trailing / , /* or /** all mean the whole directory. " +
          "Excluded paths are never cloned, staged, merged, or pushed.",
      )
      .addTextArea((t) => {
        t.inputEl.rows = 6;
        t.setValue(this.plugin.settings.excludePatterns.join("\n")).onChange(async (v) => {
          this.plugin.settings.excludePatterns = v
            .split("\n")
            .map((s) => s.trim())
            .filter((s) => s.length > 0);
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl).setName("Reset excludes to defaults").addButton((b) =>
      b.setButtonText("Reset").onClick(async () => {
        this.plugin.settings.excludePatterns = [...DEFAULT_EXCLUDES];
        await this.plugin.saveSettings();
        this.display();
      }),
    );

    containerEl.createEl("h3", { text: "Diagnostics" });

    new Setting(containerEl)
      .setName("Verbose logging")
      .setDesc("Show the step-by-step trace after every sync. Off for normal use.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.verboseLog).onChange(async (v) => {
          this.plugin.settings.verboseLog = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Commit message")
      .setDesc(`${TIMESTAMP_TOKEN} is replaced with the current date and time.`)
      .addText((t) =>
        t
          .setValue(this.plugin.settings.commitMessageTemplate)
          .onChange(async (v) => {
            this.plugin.settings.commitMessageTemplate = v;
            await this.plugin.saveSettings();
          }),
      );
  }

  /** Reports how much of the actual vault the current patterns exclude. */
  private async renderCoverage(el: HTMLElement): Promise<void> {
    const matcher = compileExcludes(this.plugin.settings.excludePatterns);
    const files = await listVaultFiles(this.app.vault.adapter, "");
    const kept = matcher.withoutExcluded(files).length;

    if (files.length > 0 && kept === 0) {
      el.setText(
        `Every one of the ${files.length} files in this vault is excluded, so a sync ` +
          `would do nothing and still report success. Check the patterns above.`,
      );
      el.style.color = "var(--text-error)";
      el.style.fontWeight = "600";
      return;
    }
    el.setText(`${files.length - kept} of ${files.length} files in this vault are excluded.`);
    el.style.color = "var(--text-muted)";
  }

  private hasExclude(prefix: string): boolean {
    return this.plugin.settings.excludePatterns.some((p) => p.startsWith(prefix));
  }
}
