import esbuild from "esbuild";
import process from "process";

const prod = process.argv[2] === "production";

const options = {
  banner: { js: "/* github-sync-mobile */" },
  entryPoints: ["src/main.ts"],
  bundle: true,
  // Only the modules Obsidian itself provides at runtime are external.
  // Node builtins are deliberately NOT listed: mobile has no Node runtime, so a
  // `require("crypto")` in the bundle would work on desktop Electron and crash on
  // iOS. Leaving builtins un-external makes such an import fail the build here
  // instead of failing on someone's phone.
  external: [
    "obsidian",
    "electron",
    "@codemirror/autocomplete",
    "@codemirror/collab",
    "@codemirror/commands",
    "@codemirror/language",
    "@codemirror/lint",
    "@codemirror/search",
    "@codemirror/state",
    "@codemirror/view",
    "@lezer/common",
    "@lezer/highlight",
    "@lezer/lr",
  ],
  // Load-bearing for iOS: `browser` makes isomorphic-git's `exports` map resolve
  // its browser entry (index.js) rather than the `node` condition (index.cjs,
  // which requires `crypto` and `path`). Switching this to "node" breaks mobile.
  platform: "browser",
  inject: ["buffer-shim.mjs"],
  format: "cjs",
  target: "es2018",
  logLevel: "info",
  sourcemap: prod ? false : "inline",
  treeShaking: true,
  outfile: "main.js",
  minify: prod,
};

if (prod) {
  await esbuild.build(options);
} else {
  const ctx = await esbuild.context(options);
  await ctx.watch();
}
