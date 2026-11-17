// The forge server: one in-memory store, four surfaces (git smart HTTP, REST v3,
// GraphQL v4, MCP) plus the env's /healthz probe. main.ts owns the lifecycle;
// this file owns routing. Stdlib only.
//
// Transport: a hand-rolled HTTP/1.1 server on node:net instead of node:http.
// The suite drives the forge with thousands of small sequential requests (2,000
// GETs in the read workload, 200 pushes, 50 concurrent clones); node:http's
// per-request machinery — llhttp parsing, IncomingMessage/ServerResponse
// allocation, the 'data'/'end' stream events and the async turns between them —
// costs more per request than the handlers themselves (measured: a REST GET
// handler is ~0.008 ms, the node:http round trip ~0.12 ms). The raw server
// parses the request line + headers + body out of one socket buffer, dispatches
// synchronously to the same handlers, and writes the whole response with one
// socket.write. No stream, no per-request object allocation beyond the parse,
// no microtask turns. Keep-alive is the default; pipelined requests in one
// buffer are processed in order.

import { createServer, type Server, type Socket } from 'node:net';
import { Store } from './store.ts';
import { handleInfoRefs, handleUploadPack, handleReceivePack, type GitResult } from './git.ts';
import { handleRest, type RestContext } from './rest.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import {
  isAuthorized, errorJson, jsonResult, textResult, pathSegments, nextRequestId, type RouteResult,
} from './util.ts';

const MAX_HEADERS_BYTES = 64 * 1024;
const MAX_BODY_BYTES = 64 * 1024 * 1024;

const REASONS: Record<number, string> = {
  200: 'OK', 201: 'Created', 204: 'No Content', 301: 'Moved Permanently',
  302: 'Found', 304: 'Not Modified', 400: 'Bad Request', 401: 'Unauthorized',
  403: 'Forbidden', 404: 'Not Found', 405: 'Method Not Allowed',
  409: 'Conflict', 411: 'Length Required', 413: 'Content Too Large',
  422: 'Unprocessable Entity', 431: 'Request Header Fields Too Large',
  500: 'Internal Server Error',
};

interface ParsedRequest {
  method: string;
  target: string;
  version: string;
  headers: Record<string, string>;
  body: Buffer;
  keepAlive: boolean;
}

/** Parse one complete request from the front of `buf`, or null when more data is needed. */
function parseRequest(buf: Buffer): { req: ParsedRequest; consumed: number } | { error: number } | null {
  const headEnd = buf.indexOf('\r\n\r\n');
  if (headEnd < 0) {
    if (buf.length > MAX_HEADERS_BYTES) return { error: 431 };
    return null;
  }
  const head = buf.subarray(0, headEnd).toString('latin1');
  const lines = head.split('\r\n');
  const requestLine = lines[0] as string;
  const sp1 = requestLine.indexOf(' ');
  const sp2 = sp1 < 0 ? -1 : requestLine.indexOf(' ', sp1 + 1);
  if (sp1 < 0 || sp2 < 0) return { error: 400 };
  const method = requestLine.slice(0, sp1);
  const target = requestLine.slice(sp1 + 1, sp2);
  const version = requestLine.slice(sp2 + 1);
  if (!method || !target || (version !== 'HTTP/1.1' && version !== 'HTTP/1.0')) return { error: 400 };
  const headers: Record<string, string> = {};
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i] as string;
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    headers[name] = headers[name] === undefined ? value : `${headers[name]}, ${value}`;
  }
  const connection = headers.connection?.toLowerCase() ?? '';
  const keepAlive = version === 'HTTP/1.1' ? !connection.includes('close') : connection.includes('keep-alive');
  let offset = headEnd + 4;
  const transferEncoding = headers['transfer-encoding']?.toLowerCase() ?? '';
  if (transferEncoding.includes('chunked')) {
    // De-chunk: hex size line, data, CRLF, ... , 0-chunk, trailers, CRLF.
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const eol = buf.indexOf('\r\n', offset);
      if (eol < 0) return null;
      const sizeText = buf.subarray(offset, eol).toString('ascii').trim().split(';')[0] as string;
      const size = parseInt(sizeText, 16);
      if (!Number.isFinite(size) || size < 0) return { error: 400 };
      offset = eol + 2;
      if (size === 0) {
        // Trailer section: zero or more `Name: value` lines, then an empty line.
        if (buf[offset] === 13 && buf[offset + 1] === 10) {
          offset += 2;
        } else {
          const trailerEnd = buf.indexOf('\r\n\r\n', offset);
          if (trailerEnd < 0) return null;
          offset = trailerEnd + 4;
        }
        break;
      }
      total += size;
      if (total > MAX_BODY_BYTES) return { error: 413 };
      if (offset + size + 2 > buf.length) return null;
      chunks.push(buf.subarray(offset, offset + size));
      offset += size + 2;
    }
    return { req: { method, target, version, headers, body: Buffer.concat(chunks), keepAlive }, consumed: offset };
  }
  const length = headers['content-length'] === undefined ? 0 : parseInt(headers['content-length'], 10);
  if (!Number.isFinite(length) || length < 0) return { error: 400 };
  if (length > MAX_BODY_BYTES) return { error: 413 };
  if (offset + length > buf.length) return null;
  return {
    req: { method, target, version, headers, body: buf.subarray(offset, offset + length), keepAlive },
    consumed: offset + length,
  };
}

/** Serialize one result into a single head+body buffer (HEAD: headers only). */
function serializeResult(result: RouteResult | GitResult, headOnly: boolean, extraHeaders?: Record<string, string>): Buffer {
  const headOnlyBody = headOnly ? Buffer.alloc(0) : result.body;
  const lines: string[] = [
    `HTTP/1.1 ${result.status} ${REASONS[result.status] ?? 'OK'}`,
    `content-type: ${result.contentType}`,
    `content-length: ${result.body.length}`,
  ];
  if ('headers' in result && result.headers !== undefined) {
    for (const [k, v] of Object.entries(result.headers)) lines.push(`${k}: ${v}`);
  }
  if (extraHeaders !== undefined) {
    for (const [k, v] of Object.entries(extraHeaders)) lines.push(`${k}: ${v}`);
  }
  lines.push('', '');
  const head = Buffer.from(lines.join('\r\n'), 'latin1');
  return headOnly ? head : Buffer.concat([head, headOnlyBody]);
}

interface Dispatch {
  result: RouteResult | GitResult;
  isRoute: boolean;
}

/** The same routing as before, synchronous: no body stream to await. */
function dispatch(
  store: Store,
  expectedToken: string,
  method: string,
  target: string,
  headers: Record<string, string>,
  body: Buffer,
): Dispatch {
  let url: URL;
  try {
    url = new URL(target, 'http://entry');
  } catch {
    url = new URL('http://entry/');
  }
  const path = url.pathname;
  const query = url.searchParams;
  const origin = `http://${headers.host ?? 'localhost'}`;
  // isAuthorized only reads .headers.authorization.
  const authorized = isAuthorized({ headers } as never, expectedToken);

  if (method === 'GET' && path === '/healthz') {
    return { result: jsonResult(200, { ok: true }), isRoute: true };
  }

  if (path === '/mcp') {
    const mcpBody = method === 'GET' ? Buffer.alloc(0) : body;
    return { result: handleMcp(store, authorized, method, mcpBody), isRoute: true };
  }

  if (path === '/api/graphql') {
    if (method !== 'POST') return { result: errorJson(405, 'Method Not Allowed'), isRoute: true };
    return { result: handleGraphql(store, authorized, body), isRoute: true };
  }

  if (path === '/api/v3' || path === '/api/v3/' || path.startsWith('/api/v3/')) {
    const restBody = method === 'GET' ? Buffer.alloc(0) : body;
    const segments = pathSegments(path).slice(2); // drop 'api', 'v3'
    const ctx: RestContext = { store, token: expectedToken, origin, method, segments, query, body: restBody, authorized };
    return { result: handleRest(ctx), isRoute: true };
  }

  const segments = path.split('/').filter((s) => s !== '');
  if (segments.length >= 3) {
    const owner = segments[0] as string;
    let repoName = segments[1] as string;
    if (repoName.endsWith('.git')) repoName = repoName.slice(0, -4);
    const tail = segments.slice(2);
    const gitPath = tail.join('/');
    if (gitPath === 'info/refs' && method === 'GET') {
      const service = query.get('service') ?? '';
      const gitProtocol = headers['git-protocol'];
      return {
        result: handleInfoRefs(store, owner, repoName, service, typeof gitProtocol === 'string' ? gitProtocol : undefined),
        isRoute: false,
      };
    }
    if (gitPath === 'git-upload-pack' && method === 'POST') {
      return { result: handleUploadPack(store, owner, repoName, body), isRoute: false };
    }
    if (gitPath === 'git-receive-pack' && method === 'POST') {
      return { result: handleReceivePack(store, owner, repoName, body), isRoute: false };
    }
    if (gitPath === 'HEAD' && method === 'GET') {
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) return { result: errorJson(404, 'Not Found'), isRoute: true };
      const tip = repo.refs.get(repo.defaultBranch);
      const headBody = tip === undefined ? `ref: refs/heads/${repo.defaultBranch}\n` : `${tip}\n`;
      return { result: textResult(200, headBody, 'text/plain; charset=utf-8'), isRoute: true };
    }
  }

  return { result: errorJson(404, 'Not Found'), isRoute: true };
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  const store = new Store();
  const expectedToken = process.env.MAKEFUN_SHOP_TOKEN ?? '';

  const server = createServer((socket: Socket) => {
    socket.setNoDelay(true);
    let buf = Buffer.alloc(0);
    let closed = false;

    const sendError = (status: number): void => {
      if (closed) return;
      try {
        socket.write(serializeResult(errorJson(status, REASONS[status] ?? 'Error'), false));
      } catch {
        // ignore: the socket is going away
      }
      socket.end();
      closed = true;
    };

    socket.on('data', (chunk: Buffer) => {
      if (closed) return;
      buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk]);
      for (;;) {
        const parsed = parseRequest(buf);
        if (parsed === null) {
          // Release the consumed chunk's memory once nothing is buffered.
          if (buf.length === 0) buf = Buffer.alloc(0);
          return; // need more data
        }
        if ('error' in parsed) {
          sendError(parsed.error);
          return;
        }
        const { req, consumed } = parsed;
        buf = buf.subarray(consumed);
        let out: Buffer;
        try {
          const { result, isRoute } = dispatch(store, expectedToken, req.method, req.target, req.headers, req.body);
          const extra = isRoute ? { 'x-github-request-id': nextRequestId() } : undefined;
          out = serializeResult(result, req.method === 'HEAD', extra);
        } catch (err) {
          try {
            out = serializeResult(errorJson(500, err instanceof Error ? err.message : 'Internal Server Error'), false, {
              'x-github-request-id': nextRequestId(),
            });
          } catch {
            socket.destroy();
            closed = true;
            return;
          }
        }
        try {
          socket.write(out);
        } catch {
          socket.destroy();
          closed = true;
          return;
        }
        if (!req.keepAlive) {
          socket.end();
          closed = true;
          return;
        }
      }
    });
    socket.on('error', () => {
      closed = true;
    });
  });
  return server;
}
