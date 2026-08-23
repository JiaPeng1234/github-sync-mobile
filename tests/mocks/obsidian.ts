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

/** Tests overwrite this via setRequestUrlHandler(). */
let handler: (p: RequestUrlParam) => Promise<RequestUrlResponse> = async () => {
  throw new Error("requestUrl called but no handler installed in test");
};

export function setRequestUrlHandler(
  h: (p: RequestUrlParam) => Promise<RequestUrlResponse>,
): void {
  handler = h;
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
