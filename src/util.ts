// util.ts — shared HTTP helpers: JSON answers, body reading, auth, request ids.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { Store, VIEWER_LOGIN } from './store.ts';

export interface ForgeCtx {
  store: Store;
  /** The bearer token the suite presents (MAKEFUN_SHOP_TOKEN); '' means accept any non-empty bearer. */
  shopToken: string;
  nextRequestId(): string;
}

export function createCtx(): ForgeCtx {
  const store = new Store();
  const shopToken = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  let counter = 0;
  return {
    store,
    shopToken,
    nextRequestId: (): string => {
      counter += 1;
      return `req-${counter}`;
    },
  };
}

const JSON_TYPE = 'application/json; charset=utf-8';

/** Answer with a JSON body, always carrying X-GitHub-Request-Id. */
export function sendJson(res: ServerResponse, ctx: ForgeCtx, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': ctx.nextRequestId(),
    ...headers,
  });
  res.end(text);
}

/** Answer with a raw body (git protocol bytes). */
export function sendRaw(res: ServerResponse, ctx: ForgeCtx, status: number, body: Buffer, contentType: string, headers: Readonly<Record<string, string>> = {}): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': ctx.nextRequestId(),
    ...headers,
  });
  res.end(body);
}

/** Answer with no body (204). */
export function sendEmpty(res: ServerResponse, ctx: ForgeCtx, status: number, headers: Readonly<Record<string, string>> = {}): void {
  res.writeHead(status, { 'x-github-request-id': ctx.nextRequestId(), ...headers });
  res.end();
}

/** A JSON error body: {"message": "..."}. */
export function sendError(res: ServerResponse, ctx: ForgeCtx, status: number, message: string): void {
  sendJson(res, ctx, status, { message });
}

/** Read the whole request body. */
export function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Parse a request body as JSON; returns null when it is not a JSON object. */
export function parseJsonBody(buf: Buffer): unknown {
  const text = buf.toString('utf8').trim();
  if (text === '') return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined; // undefined = malformed JSON (distinct from null = empty)
  }
}

/** Whether the request carries the suite's bearer token. */
export function authOk(req: IncomingMessage, ctx: ForgeCtx): boolean {
  const header = req.headers.authorization ?? '';
  const match = /^Bearer\s+(.+)$/.exec(header);
  if (match === null) return false;
  const presented = (match[1] ?? '').trim();
  if (presented === '') return false;
  if (ctx.shopToken === '') return true;
  return presented === ctx.shopToken;
}

/** Send 401 unless the request is authenticated. Returns true when authenticated. */
export function requireAuth(req: IncomingMessage, res: ServerResponse, ctx: ForgeCtx): boolean {
  if (authOk(req, ctx)) return true;
  sendError(res, ctx, 401, 'Requires authentication');
  return false;
}

export function viewerLogin(): string {
  return VIEWER_LOGIN;
}

/** The path of a request URL, or '/' when it does not parse. Parse each request's URL once and reuse it: pathOf/queryOf are called several times per request (routing + handler), and `new URL` is not free. The request object is the cache key, so nothing can leak across requests. */
const urlCache = new WeakMap<IncomingMessage, URL>();
function requestUrl(req: IncomingMessage): URL {
  let url = urlCache.get(req);
  if (url === undefined) {
    try {
      url = new URL(req.url ?? '/', 'http://entry');
    } catch {
      url = new URL('/', 'http://entry');
    }
    urlCache.set(req, url);
  }
  return url;
}

export function pathOf(req: IncomingMessage): string {
  return requestUrl(req).pathname;
}

/** The query parameters of a request URL. */
export function queryOf(req: IncomingMessage): URLSearchParams {
  return requestUrl(req).searchParams;
}

/** Split a path into its '/'-separated segments (no empty segments). */
export function splitPath(path: string): string[] {
  return path.split('/').filter((segment) => segment !== '');
}

/** Decode one URI path segment (percent-decoding), or null when malformed. */
export function decodeSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

/** The request's own origin, for absolute pagination links. */
export function originOf(req: IncomingMessage): string {
  const host = req.headers.host ?? '127.0.0.1';
  return `http://${host}`;
}
