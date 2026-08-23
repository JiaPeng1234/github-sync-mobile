// Mobile (iOS/Android) has no Node `buffer` builtin and no `Buffer` global.
// isomorphic-git's deps require both. esbuild injects this into every module.
import { Buffer } from "buffer";

if (typeof globalThis.Buffer === "undefined") {
  globalThis.Buffer = Buffer;
}

export { Buffer };
