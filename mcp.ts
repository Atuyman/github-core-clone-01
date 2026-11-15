// MCP JSON-RPC 2.0 (Streamable HTTP) at /mcp: modern-era discovery
// (2026-07-28), tools/list, tools/call for the six canonical GitHub tools.

import { Store, type Repo } from './store.ts';
import { jsonResult, errorJson, type RouteResult } from './util.ts';

const SERVER_NAME = 'forge-mcp';
const SERVER_VERSION = '1.0.0';

interface JsonRpcRequest {
  readonly jsonrpc?: unknown;
  readonly id?: unknown;
  readonly method?: unknown;
  readonly params?: unknown;
}

function serverInfoMeta(): Record<string, unknown> {
  return {
    _meta: {
      'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION },
    },
  };
}

function rpcResult(id: unknown, result: Record<string, unknown>): RouteResult {
  return jsonResult(200, { jsonrpc: '2.0', id: id ?? null, result });
}

function rpcError(id: unknown, code: number, message: string): RouteResult {
  return jsonResult(200, { jsonrpc: '2.0', id: id ?? null, error: { code, message } });
}

interface ToolDef {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: {
    readonly type: 'object';
    readonly properties: Record<string, { readonly type: string; readonly description?: string }>;
    readonly required: string[];
  };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The name of the repository.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The title of the issue.' },
        body: { type: 'string', description: 'The body of the issue.' },
        labels: { type: 'string', description: 'Comma-separated label names.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed, or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The title of the pull request.' },
        body: { type: 'string', description: 'The body of the pull request.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request in a repository using a squash merge.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'string', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

function repoObject(store: Store, repo: Repo): Record<string, unknown> {
  return {
    id: repo.databaseId,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: store.user(repo.owner).id },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    html_url: `/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
  };
}

function issueObject(store: Store, repo: Repo, issue: { number: number; title: string; body: string; state: string; labels: string[]; createdAt: string; updatedAt: string }): Record<string, unknown> {
  return {
    id: repo.databaseId * 1000000 + issue.number,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name })),
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    html_url: `/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function callTool(store: Store, name: string, args: Record<string, unknown>): { result: Record<string, unknown>; isError: boolean } {
  const viewer = store.viewerLogin;
  const need = (fields: string[]): string | null => {
    for (const f of fields) {
      if (args[f] === undefined || args[f] === null || args[f] === '') return f;
    }
    return null;
  };
  switch (name) {
    case 'create_repo': {
      const missing = need(['name']);
      if (missing !== null) return { result: { error: `missing required argument: ${missing}` }, isError: true };
      const repoName = String(args.name);
      const owner = viewer ?? '';
      if (owner === '') return { result: { error: 'viewer login not learned yet' }, isError: true };
      if (store.getRepo(owner, repoName) !== undefined) {
        return { result: { error: 'repository already exists', name: repoName }, isError: true };
      }
      const repo = store.createRepo(repoName, {
        description: typeof args.description === 'string' ? args.description : '',
        isPrivate: args.private === true,
      });
      return { result: repoObject(store, repo), isError: false };
    }
    case 'get_repo': {
      const missing = need(['owner', 'repo']);
      if (missing !== null) return { result: { error: `missing required argument: ${missing}` }, isError: true };
      const repo = store.getRepo(String(args.owner), String(args.repo));
      if (repo === undefined) return { result: { error: 'Not Found' }, isError: true };
      return { result: repoObject(store, repo), isError: false };
    }
    case 'create_issue': {
      const missing = need(['owner', 'repo', 'title']);
      if (missing !== null) return { result: { error: `missing required argument: ${missing}` }, isError: true };
      const repo = store.getRepo(String(args.owner), String(args.repo));
      if (repo === undefined) return { result: { error: 'Not Found' }, isError: true };
      const labels = typeof args.labels === 'string' ? args.labels.split(',').map((s) => s.trim()).filter((s) => s !== '') : [];
      const issue = store.createIssue(repo, String(args.title), typeof args.body === 'string' ? args.body : '', labels);
      return { result: issueObject(store, repo, issue), isError: false };
    }
    case 'list_issues': {
      const missing = need(['owner', 'repo']);
      if (missing !== null) return { result: { error: `missing required argument: ${missing}` }, isError: true };
      const repo = store.getRepo(String(args.owner), String(args.repo));
      if (repo === undefined) return { result: { error: 'Not Found' }, isError: true };
      const state = typeof args.state === 'string' ? args.state : 'open';
      const issues = [...repo.issues.values()]
        .filter((i) => state === 'all' || i.state === state)
        .map((i) => issueObject(store, repo, i));
      return { result: { issues, total_count: issues.length }, isError: false };
    }
    case 'create_pull_request': {
      const missing = need(['owner', 'repo', 'title', 'head', 'base']);
      if (missing !== null) return { result: { error: `missing required argument: ${missing}` }, isError: true };
      const repo = store.getRepo(String(args.owner), String(args.repo));
      if (repo === undefined) return { result: { error: 'Not Found' }, isError: true };
      const pr = store.createPullRequest(
        repo,
        String(args.title),
        typeof args.body === 'string' ? args.body : '',
        String(args.head),
        String(args.base),
      );
      return {
        result: {
          id: repo.databaseId * 1000000 + pr.number,
          number: pr.number,
          title: pr.title,
          body: pr.body,
          state: pr.state,
          head: { ref: pr.head, sha: pr.headSha },
          base: { ref: pr.base, sha: pr.baseSha },
          html_url: `/${repo.owner}/${repo.name}/pull/${pr.number}`,
        },
        isError: false,
      };
    }
    case 'merge_pull_request': {
      const missing = need(['owner', 'repo', 'pull_number']);
      if (missing !== null) return { result: { error: `missing required argument: ${missing}` }, isError: true };
      const repo = store.getRepo(String(args.owner), String(args.repo));
      if (repo === undefined) return { result: { error: 'Not Found' }, isError: true };
      const number = typeof args.pull_number === 'number' ? args.pull_number : parseInt(String(args.pull_number), 10);
      const pr = repo.prs.get(number);
      if (pr === undefined) return { result: { error: 'Not Found' }, isError: true };
      const merged = store.squashMerge(repo, pr);
      if (merged === null) return { result: { error: 'Merge conflict' }, isError: true };
      pr.state = 'closed';
      pr.merged = true;
      pr.mergeCommitSha = merged.commitOid;
      pr.mergedAt = store.nowIso();
      pr.updatedAt = pr.mergedAt;
      return {
        result: { merged: true, sha: merged.commitOid, message: `Squash merged pull request #${pr.number}`, number: pr.number },
        isError: false,
      };
    }
    default:
      return { result: { error: `unknown tool: ${name}` }, isError: true };
  }
}

export function handleMcp(store: Store, authorized: boolean, method: string, body: Buffer): RouteResult {
  if (!authorized) return errorJson(401, 'Requires authentication');
  if (method === 'DELETE') {
    // Session termination is tolerated.
    return jsonResult(200, {});
  }
  if (method === 'GET') return errorJson(405, 'Method Not Allowed');
  if (method !== 'POST') return errorJson(405, 'Method Not Allowed');
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8')) as unknown;
  } catch {
    return jsonResult(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return jsonResult(400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
  }
  const req = parsed as JsonRpcRequest;
  const id = req.id ?? null;
  const rpcMethod = typeof req.method === 'string' ? req.method : '';
  // Notifications (no id) are accepted silently.
  if (req.id === undefined) return jsonResult(202, {});

  if (rpcMethod === 'discover' || rpcMethod === 'server/discover') {
    return rpcResult(id, {
      supportedVersions: ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'],
      protocolVersion: '2026-07-28',
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      ...serverInfoMeta(),
    });
  }
  if (rpcMethod === 'initialize') {
    const params = (req.params ?? {}) as { protocolVersion?: unknown };
    return rpcResult(id, {
      protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : '2026-07-28',
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      ...serverInfoMeta(),
    });
  }
  if (rpcMethod === 'tools/list') {
    return rpcResult(id, { tools: TOOLS, ...serverInfoMeta() });
  }
  if (rpcMethod === 'tools/call') {
    const params = (req.params ?? {}) as { name?: unknown; arguments?: unknown };
    const toolName = typeof params.name === 'string' ? params.name : '';
    const tool = TOOLS.find((t) => t.name === toolName);
    if (tool === undefined) return rpcError(id, -32601, `unknown tool: ${toolName}`);
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    if (args === null || typeof args !== 'object' || Array.isArray(args)) {
      return rpcError(id, -32602, 'invalid arguments');
    }
    const missing = tool.inputSchema.required.filter((f) => args[f] === undefined || args[f] === null || args[f] === '');
    if (missing.length > 0) {
      return rpcError(id, -32602, `missing required argument: ${missing[0] as string}`);
    }
    const { result, isError } = callTool(store, toolName, args);
    return rpcResult(id, {
      content: [{ type: 'text', text: JSON.stringify(result) }],
      structuredContent: result,
      isError,
      ...serverInfoMeta(),
    });
  }
  if (rpcMethod === 'ping') {
    return rpcResult(id, { ...serverInfoMeta() });
  }
  return rpcError(id, -32601, `method not found: ${rpcMethod}`);
}
