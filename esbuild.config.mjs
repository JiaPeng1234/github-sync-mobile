import esbuild from "esbuild";
import process from "process";
import { builtinModules } from "module";

const prod = process.argv[2] === "production";

// Node builtins stay external (Electron provides them on desktop) EXCEPT `buffer`,
// which must be bundled because mobile has no Node runtime. See buffer-shim.mjs.
const externalBuiltins = builtinModules.filter((m) => m !== "buffer");

await esbuild.build({
  banner: { js: "/* github-sync-mobile */" },
  entryPoints: ["src/main.ts"],
  bundle: true,
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
    ...externalBuiltins,
  ],
  inject: ["buffer-shim.mjs"],
  format: "cjs",
  target: "es2018",
  logLevel: "info",
  sourcemap: prod ? false : "inline",
  treeShaking: true,
  outfile: "main.js",
  minify: prod,
});
