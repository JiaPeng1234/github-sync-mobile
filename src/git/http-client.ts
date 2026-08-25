import { requestUrl } from "obsidian";

export interface GitHttpRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: AsyncIterableIterator<Uint8Array> | Uint8Array[];
}

export interface GitHttpResponse {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Uint8Array[];
  statusCode: number;
  statusMessage: string;
}

async function concatBody(
  body: AsyncIterableIterator<Uint8Array> | Uint8Array[] | undefined,
): Promise<ArrayBuffer | undefined> {
  if (!body) return undefined;
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of body as AsyncIterable<Uint8Array>) {
    chunks.push(chunk);
    total += chunk.byteLength;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out.buffer as ArrayBuffer;
}

/**
 * isomorphic-git http plugin backed by Obsidian's requestUrl.
 *
 * requestUrl is not CORS-bound, so no CORS proxy is needed — nothing outside
 * GitHub ever sees the vault. `throw: false` is essential: git must observe
 * 401/404 status codes itself rather than having them raised as exceptions.
 */
export const httpClient = {
  async request(req: GitHttpRequest): Promise<GitHttpResponse> {
    const method = req.method ?? "GET";
    const body = await concatBody(req.body);

    const res = await requestUrl({
      url: req.url,
      method,
      headers: req.headers,
      body,
      throw: false,
    });

    // iso-git keys smart-http detection on headers['content-type'] (lowercase)
    // and JS property lookup is case-sensitive. Obsidian's requestUrl happens to
    // lowercase response header keys today, but its typings promise nothing about
    // casing — so normalize defensively rather than passing raw headers through.
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(res.headers ?? {})) {
      headers[k.toLowerCase()] = v;
    }

    return {
      url: req.url,
      method,
      headers,
      body: [new Uint8Array(res.arrayBuffer)],
      statusCode: res.status,
      statusMessage: String(res.status),
    };
  },
};
