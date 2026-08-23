export interface RequestUrlParam {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: ArrayBuffer | string;
  throw?: boolean;
}

export interface RequestUrlResponse {
  status: number;
  headers: Record<string, string>;
  arrayBuffer: ArrayBuffer;
  text: string;
}

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
 */
export function resetRequestUrlHandler(): void {
  handler = noHandler;
}

export function requestUrl(p: RequestUrlParam): Promise<RequestUrlResponse> {
  return handler(p);
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
