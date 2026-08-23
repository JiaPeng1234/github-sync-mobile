// Mobile (iOS/Android) has no Node `buffer` builtin and no `Buffer` global.
// isomorphic-git's deps require both. esbuild injects this into every module.
//
// CONSTRAINT for the filesystem adapter: esbuild's `inject` rewrites the bare
// identifier `Buffer` at every bundled call site on every platform, so on desktop
// this polyfill coexists with (and shadows) Node's native Buffer. The polyfill's
// `Buffer.isBuffer(b)` tests `b._isBuffer === true`, which is false for a native
// Node Buffer -- and isomorphic-git's GitIndex calls `Buffer.isBuffer(...)`. So the
// fs adapter MUST always return `Uint8Array` and never a native Node Buffer.
// This is a hard correctness requirement, not a stylistic preference.
import { Buffer } from "buffer";

if (typeof globalThis.Buffer === "undefined") {
  globalThis.Buffer = Buffer;
}

export { Buffer };
