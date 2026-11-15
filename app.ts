// The forge server: one in-memory store, four surfaces (git smart HTTP, REST v3,
// GraphQL v4, MCP) plus the env's /healthz probe. main.ts owns the lifecycle;
// this file owns routing. Stdlib only.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store } from './store.ts';
import { handleInfoRefs, handleUploadPack, handleReceivePack, type GitResult } from './git.ts';
import { handleRest, type RestContext } from './rest.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import {
  readBody, isAuthorized, errorJson, jsonResult, textResult, pathSegments, nextRequestId, type RouteResult,
} from './util.ts';

/** The path of a request URL, or '/' when it does not parse (never a throw from a request). */
function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

/** The parsed query of a request URL. */
function queryOf(req: IncomingMessage): URLSearchParams {
  try {
    return new URL(req.url ?? '/', 'http://entry').searchParams;
  } catch {
    return new URLSearchParams();
  }
}

/** Send a RouteResult: content-type + length + a deterministic request id, plus any extra headers. */
function sendRoute(res: ServerResponse, result: RouteResult): void {
  res.writeHead(result.status, {
    'content-type': result.contentType,
    'content-length': result.body.length,
    'x-github-request-id': nextRequestId(),
    ...(result.headers ?? {}),
  });
  res.end(result.body);
}

/** Send a GitResult (smart HTTP, binary body). */
function sendGit(res: ServerResponse, result: GitResult): void {
  res.writeHead(result.status, {
    'content-type': result.contentType,
    'content-length': result.body.length,
  });
  res.end(result.body);
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  const store = new Store();
  const expectedToken = process.env.MAKEFUN_SHOP_TOKEN ?? '';

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const path = pathOf(req);
      const method = req.method ?? 'GET';
      const query = queryOf(req);
      const origin = `http://${req.headers.host ?? 'localhost'}`;

      // The env's boot check calls this twice: 200 {"ok":true}. No auth.
      if (method === 'GET' && path === '/healthz') {
        sendRoute(res, jsonResult(200, { ok: true }));
        return;
      }

      const authorized = isAuthorized(req, expectedToken);

      // MCP (Streamable HTTP JSON-RPC). Auth handled inside; GET -> 405, DELETE tolerated.
      if (path === '/mcp') {
        const body = await readBody(req);
        sendRoute(res, handleMcp(store, authorized, method, body));
        return;
      }

      // GraphQL v4.
      if (path === '/api/graphql') {
        if (method !== 'POST') {
          sendRoute(res, errorJson(405, 'Method Not Allowed'));
          return;
        }
        const body = await readBody(req);
        sendRoute(res, handleGraphql(store, authorized, body));
        return;
      }

      // REST v3 (includes GET /api/v3 and /api/v3/meta).
      if (path === '/api/v3' || path === '/api/v3/' || path.startsWith('/api/v3/')) {
        const body = await readBody(req);
        const segments = pathSegments(path).slice(2); // drop 'api', 'v3'
        const ctx: RestContext = { store, token: expectedToken, origin, method, segments, query, body, authorized };
        sendRoute(res, handleRest(ctx));
        return;
      }

      // Git smart HTTP: /{owner}/{repo}[.git]/{info/refs,git-upload-pack,git-receive-pack,HEAD}.
      const segments = path.split('/').filter((s) => s !== '');
      if (segments.length >= 3) {
        const owner = segments[0] as string;
        let repoName = segments[1] as string;
        if (repoName.endsWith('.git')) repoName = repoName.slice(0, -4);
        const tail = segments.slice(2);
        const gitPath = tail.join('/');
        if (gitPath === 'info/refs' && method === 'GET') {
          const service = query.get('service') ?? '';
          const gitProtocol = req.headers['git-protocol'];
          sendGit(res, handleInfoRefs(store, owner, repoName, service, typeof gitProtocol === 'string' ? gitProtocol : undefined));
          return;
        }
        if (gitPath === 'git-upload-pack' && method === 'POST') {
          const body = await readBody(req);
          sendGit(res, handleUploadPack(store, owner, repoName, body));
          return;
        }
        if (gitPath === 'git-receive-pack' && method === 'POST') {
          const body = await readBody(req);
          sendGit(res, handleReceivePack(store, owner, repoName, body));
          return;
        }
        if (gitPath === 'HEAD' && method === 'GET') {
          const repo = store.getRepo(owner, repoName);
          if (repo === undefined) {
            sendRoute(res, errorJson(404, 'Not Found'));
            return;
          }
          const tip = repo.refs.get(repo.defaultBranch);
          const body = tip === undefined ? `ref: refs/heads/${repo.defaultBranch}\n` : `${tip}\n`;
          sendRoute(res, textResult(200, body, 'text/plain; charset=utf-8'));
          return;
        }
      }

      // Everything else, every method: GitHub's 404 body.
      sendRoute(res, errorJson(404, 'Not Found'));
    })().catch((err: unknown) => {
      if (!res.headersSent) {
        try {
          sendRoute(res, errorJson(500, err instanceof Error ? err.message : 'Internal Server Error'));
        } catch {
          res.destroy();
        }
      } else {
        res.destroy();
      }
    });
  });
}
