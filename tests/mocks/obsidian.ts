import type {
  RequestUrlParam as RealParam,
  RequestUrlResponse as RealResponse,
} from "obsidian";

export interface RequestUrlParam {
  url: string;
  method?: string;
  contentType?: string;
  headers?: Record<string, string>;
  body?: ArrayBuffer | string;
  /** Whether to throw when the status is 400+. Defaults to true, as in the real API. */
  throw?: boolean;
}

export interface RequestUrlResponse {
  status: number;
  headers: Record<string, string>;
  arrayBuffer: ArrayBuffer;
  json: any;
  text: string;
}

// Compile-time guard: these shapes must stay interchangeable with the real ones, in
// both directions, so a field we quietly omit, invent, or mistype fails the typecheck
// instead of misleading a test. `import type` is erased before the vitest alias
// applies, so this cannot become a self-import cycle.
//
// Required<> is what gives this teeth. Plain mutual assignability cannot see a *missing
// optional* property -- omitting `contentType` stayed assignable both ways, which is
// exactly how that field went missing in the first place. Requiring every property
// makes an omission on either side a hard error.
const _paramToReal: Required<RealParam> = {} as Required<RequestUrlParam>;
const _paramFromReal: Required<RequestUrlParam> = {} as Required<RealParam>;
const _responseToReal: Required<RealResponse> = {} as Required<RequestUrlResponse>;
const _responseFromReal: Required<RequestUrlResponse> = {} as Required<RealResponse>;
void _paramToReal;
void _paramFromReal;
void _responseToReal;
void _responseFromReal;

type RequestUrlHandler = (p: RequestUrlParam) => Promise<RequestUrlResponse>;

const noHandler: RequestUrlHandler = async () => {
  throw new Error("requestUrl called but no handler installed in test");
};

/** Tests overwrite this via setRequestUrlHandler(). */
let handler: RequestUrlHandler = noHandler;

export function setRequestUrlHandler(h: RequestUrlHandler): void {
  handler = h;
}

/**
 * Restores the throwing default. `handler` is module-global, so a handler installed by
 * one test would otherwise leak into every later test sharing this module registry.
 * Deliberately opt-in rather than a global hook -- call it from your own afterEach.
 */
export function resetRequestUrlHandler(): void {
  handler = noHandler;
}

/**
 * Narrowed on purpose: the real signature also accepts a bare url string and returns a
 * RequestUrlResponsePromise whose arrayBuffer/json/text are individually awaitable. We
 * model only the object-param, await-the-whole-response form, which is all this plugin
 * uses.
 *
 * The 400+ throw is not cosmetic. GitHub answers 401/403/409 exactly where this
 * plugin's safety decisions live, and the real requestUrl throws before the caller can
 * read `res.status`. A stub that resolved instead would let a test "prove" graceful
 * handling of an auth failure that on a device never reaches that code at all.
 */
export async function requestUrl(p: RequestUrlParam): Promise<RequestUrlResponse> {
  const res = await handler(p);
  if (p.throw !== false && res.status >= 400) {
    // A bare Error, deliberately. The real typings promise no `status` property on
    // this error, so attaching one would let a test key on `err.status`, pass, and
    // ship behaviour the device does not provide. The stub must never be more
    // generous than the API it stands in for. Pass `throw: false` and read
    // `res.status` instead -- which is what both clients do.
    throw new Error(`Request failed, status ${res.status}`);
  }
  return res;
}

// Stubs so `import { Plugin } from "obsidian"` type-checks in tests.
export class Plugin {}
export class PluginSettingTab {}
export class Modal {}
export class Setting {}
export class ItemView {}
export class Notice {
  constructor(public message: string) {}
}
