// Shared HTTP plumbing for the forge's handlers: response shapes, body reads,
// bearer auth, deterministic request ids. Stdlib only.

import type { IncomingMessage } from 'node:http';

export interface RouteResult {
  readonly status: number;
  readonly contentType: string;
  readonly body: Buffer;
  readonly headers?: Readonly<Record<string, string>>;
}

export function jsonResult(status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): RouteResult {
  const text = `${JSON.stringify(body)}\n`;
  return { status, contentType: 'application/json; charset=utf-8', body: Buffer.from(text, 'utf8'), headers };
}

export function textResult(status: number, body: string, contentType = 'text/plain; charset=utf-8'): RouteResult {
  return { status, contentType, body: Buffer.from(body, 'utf8') };
}

export function emptyResult(status: number, headers: Readonly<Record<string, string>> = {}): RouteResult {
  return { status, contentType: 'application/json; charset=utf-8', body: Buffer.alloc(0), headers };
}

export function errorJson(status: number, message: string): RouteResult {
  return jsonResult(status, { message });
}

/** Read a request body fully (up to 64 MiB; the suite's largest is a ~100-file pack). */
export function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > 64 * 1024 * 1024) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Parse a JSON body; empty body parses as `{}`. Returns null on malformed JSON. */
export function parseJsonBody(body: Buffer): { ok: true; value: unknown } | { ok: false } {
  const text = body.toString('utf8').trim();
  if (text === '') return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

export function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (header === undefined) return null;
  const match = /^Bearer\s+(.+)$/.exec(header.trim());
  return match === null ? null : (match[1] as string);
}

/** True iff the request carries the expected bearer token ('' expects any non-empty token). */
export function isAuthorized(req: IncomingMessage, expected: string): boolean {
  const token = bearerToken(req);
  if (token === null || token === '') return false;
  if (expected === '') return true;
  return token === expected;
}

/** Deterministic request ids: `forge-1`, `forge-2`, … (no clock, no randomness). */
let requestCounter = 0;
export function nextRequestId(): string {
  requestCounter += 1;
  return `forge-${requestCounter}`;
}

/** Split a URL path into decoded segments. */
export function pathSegments(pathname: string): string[] {
  return pathname
    .split('/')
    .filter((s) => s !== '')
    .map((s) => {
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    });
}

export function base64DecodeLoose(value: string): Buffer {
  return Buffer.from(value.replace(/[\r\n\t ]+/g, ''), 'base64');
}

export function base64Encode(value: Buffer): string {
  return value.toString('base64');
}
