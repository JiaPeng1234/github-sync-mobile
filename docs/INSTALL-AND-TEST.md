# Installing and testing on a phone

How to get a dev build of this plugin onto an iPhone and exercise it. The automated suite covers the
data-loss paths; **the phone is the final gate** — a green suite is not shipping confidence.

> **Always test against a throwaway vault and a private *test* repo first, never your real vault.**
> On iOS there is no git CLI to repair a wrong guess.

## Build the artifacts

```bash
npm ci
npm run build     # runs `tsc --noEmit` then esbuild; writes main.js in the repo root
```

The plugin ships as three files: **`main.js`** (built, gitignored) and **`manifest.json`** (committed),
plus **`styles.css`** *if it ever exists* (it does not today — the UI uses inline styles). `main.js` is
gitignored on purpose; it is a build artifact, produced locally or by the Task 19 release workflow.

## Path A — manual sideload (works immediately, best for the first smoke test)

1. In the test vault, create `<vault>/.obsidian/plugins/github-sync-mobile/`.
2. Copy `main.js` and `manifest.json` into that folder (Files app / iCloud / AirDrop — whatever moves
   files onto the phone).
3. Obsidian → **Settings → Community plugins** → disable Restricted mode if on → enable
   **GitHub Sync Mobile**.

## Path B — BRAT

BRAT installs from a **GitHub release** whose assets include `main.js` + `manifest.json`. There is no
release until one is cut. `gh` is not installed in the dev environment, so cut it from your own machine
(this publishes to your GitHub — run it yourself):

```bash
# main.js already built; tag must match manifest.json's "version" and versions.json
git tag 0.1.0 && git push origin 0.1.0
gh release create 0.1.0 main.js manifest.json --title "0.1.0" --notes "First test build"
```

Then on the phone: **BRAT → "Add beta plugin"** → `JiaPeng1234/github-sync-mobile` → **Add Plugin** →
enable in Community plugins. (Task 19's `release.yml` automates this build+attach on every tag push, so
once it lands you only push a tag.)

## What to test

1. **Config** — create a private repo and a **fine-grained PAT** (`Contents: read and write`, scoped to
   that one repo). Fill token / owner / repo in settings, tap **Test connection** (expect `OK as <login>`).
2. **Connect** — command palette → **Connect this vault to GitHub**:
   - empty remote → init-push;
   - empty vault + remote-with-content → clone-safe;
   - vault-with-notes + remote-with-content → **refuses and explains** (this refusal is the point).
3. **Round-trip** — edit a note → ribbon panel → **Sync now** → confirm it lands on GitHub. Edit on
   GitHub, sync again → confirm the pull lands.
4. **Safety checks worth eyeballing:**
   - **`.obsidian/` and the PAT must NOT appear in the repo** (security invariant — the token lives in
     `.obsidian/plugins/<id>/data.json` in plaintext).
   - Conflicting edit on both sides → sync → expect the **conflict modal** (keep mine / keep theirs),
     never a lost edit.
   - Turn on **Verbose logging** to see the step trace in the log modal when a sync stops.
5. **Grab logs on failure** — the panel's *Show last log* → Copy, or a modal's Copy button, then paste
   the log back into the working session before making code changes.
