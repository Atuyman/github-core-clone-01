// REST v3 API under /api/v3: repositories, branches, commits, contents, labels,
// issues, comments, pull requests. All replies are JSON with a message-bearing
// error shape; every route enforces the bearer token except the API root and meta.

import { Store, globalId, type Repo, type Issue, type PullRequest } from './store.ts';
import { parseCommit, parseTree } from './gitobj.ts';
import {
  jsonResult, errorJson, emptyResult, parseJsonBody, isAuthorized, base64DecodeLoose, base64Encode,
  type RouteResult,
} from './util.ts';

export interface RestContext {
  store: Store;
  token: string; // expected bearer token; '' accepts any non-empty token
  origin: string; // e.g. http://127.0.0.1:4123 — for absolute pagination links
  method: string;
  segments: string[]; // path segments after /api/v3
  query: URLSearchParams;
  body: Buffer;
  authorized: boolean;
}

const SHA40 = /^[0-9a-f]{40}$/i;
export const ZERO_OID = '0'.repeat(40);

// ------------------------------------------------------------ shapes

function repoObject(store: Store, repo: Repo): Record<string, unknown> {
  const owner = store.user(repo.owner === '' ? (store.viewerLogin ?? '') : repo.owner);
  return {
    id: repo.databaseId,
    node_id: globalId('repo', `${repo.owner}/${repo.name}`),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    private: repo.isPrivate,
    owner: { login: repo.owner, id: owner.id, type: 'User' },
    html_url: `/repos/${repo.owner}/${repo.name}`,
    description: repo.description,
    fork: false,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.pushedAt,
    homepage: null,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: false,
    has_downloads: false,
    has_wiki: false,
    has_pages: false,
    forks_count: 0,
    open_issues_count: [...repo.issues.values()].filter((i) => i.state === 'open').length,
    license: null,
    topics: [],
    visibility: repo.isPrivate ? 'private' : 'public',
    default_branch: repo.defaultBranch,
    archived: false,
    disabled: false,
  };
}

function issueRestId(repo: Repo, issue: Issue): number {
  return repo.databaseId * 1_000_000 + issue.number;
}

function issueObject(store: Store, repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issueRestId(repo, issue),
    node_id: globalId('issue', `${repo.owner}/${repo.name}/${issue.number}`),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return { name, color: label?.color ?? 'ededed', description: label?.description ?? '' };
    }),
    user: { login: repo.owner, id: store.user(repo.owner).id, type: 'User' },
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.state === 'closed' ? issue.updatedAt : null,
    comments: (repo.comments.get(issue.number) ?? []).length,
  };
}

function prObject(store: Store, repo: Repo, pr: PullRequest): Record<string, unknown> {
  const headSha = repo.refs.get(pr.head) ?? pr.headSha;
  const baseSha = repo.refs.get(pr.base) ?? pr.baseSha;
  return {
    id: repo.databaseId * 1_000_000 + pr.number,
    node_id: globalId('pr', `${repo.owner}/${repo.name}/${pr.number}`),
    number: pr.number,
    state: pr.state,
    title: pr.title,
    body: pr.body,
    user: { login: repo.owner, id: store.user(repo.owner).id, type: 'User' },
    head: { ref: pr.head, sha: headSha, label: `${repo.owner}:${pr.head}` },
    base: { ref: pr.base, sha: baseSha, label: `${repo.owner}:${pr.base}` },
    merged: pr.merged,
    merged_at: pr.mergedAt,
    merge_commit_sha: pr.mergeCommitSha,
    mergeable: pr.state === 'open' ? !store.prConflicts(repo, pr) : null,
    created_at: pr.createdAt,
    updated_at: pr.updatedAt,
    closed_at: pr.state === 'closed' ? pr.updatedAt : null,
  };
}

function commentObject(store: Store, repo: Repo, comment: { id: number; body: string; createdAt: string; updatedAt: string }): Record<string, unknown> {
  return {
    id: repo.databaseId * 1_000_000 + comment.id,
    node_id: globalId('comment', `${repo.owner}/${repo.name}/${comment.id}`),
    body: comment.body,
    user: { login: repo.owner, id: store.user(repo.owner).id, type: 'User' },
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
  };
}

// ------------------------------------------------------------ helpers

function bodyObject(ctx: RestContext): { ok: true; value: Record<string, unknown> } | { ok: false } {
  const parsed = parseJsonBody(ctx.body);
  if (!parsed.ok) return { ok: false };
  if (parsed.value === null || typeof parsed.value !== 'object' || Array.isArray(parsed.value)) {
    return { ok: true, value: {} };
  }
  return { ok: true, value: parsed.value as Record<string, unknown> };
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asBool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/** Resolve a ref (branch name, tag, or commit oid) to a commit oid. */
function resolveRef(store: Store, repo: Repo, ref: string | null): string | null {
  if (ref === null || ref === '') return repo.refs.get(repo.defaultBranch) ?? null;
  const branch = repo.refs.get(ref);
  if (branch !== undefined) return branch;
  const tag = repo.tags.get(ref);
  if (tag !== undefined) return tag;
  if (SHA40.test(ref) && store.getObject(repo, ref) !== undefined) return ref;
  return null;
}

function commitHistory(store: Store, repo: Repo, tip: string): { sha: string; message: string; author: string; committer: string }[] {
  const out: { sha: string; message: string; author: string; committer: string }[] = [];
  const seen = new Set<string>();
  const stack: string[] = [tip];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = store.getObject(repo, oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    const commit = parseCommit(obj.data);
    // GitHub presents the commit message without the trailing newline the
    // object itself stores; the git wire keeps the raw bytes.
    out.push({ sha: oid, message: commit.message.replace(/\n+$/, ''), author: commit.author, committer: commit.committer });
    // Push parents in reverse so the first parent is visited first (linear history stays ordered).
    for (let i = commit.parents.length - 1; i >= 0; i -= 1) stack.push(commit.parents[i] as string);
  }
  return out;
}

function parseIdent(line: string): { name: string; email: string; date: string } {
  const match = /^(.*) <([^>]*)> (\d+) ([+-]\d{4})$/.exec(line);
  if (match === null) return { name: line, email: '', date: '' };
  const epoch = Number(match[3]);
  return {
    name: match[1] as string,
    email: match[2] as string,
    date: new Date(epoch * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
  };
}

function lineCount(text: string): number {
  if (text === '') return 0;
  return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
}

function paginate<T>(items: T[], ctx: RestContext): { page: T[]; nextPage: number | null; lastPage: number } {
  const perPageRaw = ctx.query.get('per_page');
  const pageRaw = ctx.query.get('page');
  const perPage = perPageRaw === null ? 30 : Math.max(1, parseInt(perPageRaw, 10) || 30);
  const page = pageRaw === null ? 1 : Math.max(1, parseInt(pageRaw, 10) || 1);
  const start = (page - 1) * perPage;
  const pageItems = items.slice(start, start + perPage);
  const lastPage = Math.max(1, Math.ceil(items.length / perPage));
  return { page: pageItems, nextPage: page < lastPage ? page + 1 : null, lastPage };
}

function linkHeader(ctx: RestContext, basePath: string, perPage: number, page: number | null, lastPage: number): string {
  const url = (p: number): string => `${ctx.origin}${basePath}?per_page=${perPage}&page=${p}`;
  const parts: string[] = [];
  if (page !== null) parts.push(`<${url(page)}>; rel="next"`);
  parts.push(`<${url(lastPage)}>; rel="last"`);
  parts.push(`<${url(1)}>; rel="first"`);
  return parts.join(', ');
}

// ------------------------------------------------------------ router

export function handleRest(ctx: RestContext): RouteResult {
  const { store } = ctx;
  const seg = ctx.segments;

  // API root + meta: no auth required (GitHub answers them anonymously).
  if (ctx.method === 'GET' && seg.length === 0) {
    return jsonResult(200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
  }
  if (ctx.method === 'GET' && seg.length === 1 && seg[0] === 'meta') {
    return jsonResult(200, { installed_version: '1.0.0' });
  }
  if (!ctx.authorized) return errorJson(401, 'Requires authentication');

  // GET /user — the token owner. 404 until the viewer login is learned, so the
  // MCP client falls back to the scenario viewer login (which is correct).
  if (ctx.method === 'GET' && seg.length === 1 && seg[0] === 'user') {
    if (store.viewerLogin === null) return errorJson(404, 'Not Found');
    const user = store.user(store.viewerLogin);
    return jsonResult(200, { login: user.login, id: user.id, type: 'User' });
  }

  // POST /user/repos — create (owner = token owner; learned lazily).
  if (ctx.method === 'POST' && seg.length === 2 && seg[0] === 'user' && seg[1] === 'repos') {
    const body = bodyObject(ctx);
    if (!body.ok) return errorJson(400, 'Malformed JSON body');
    const name = asString(body.value.name);
    if (name === '') return errorJson(422, 'Repository name is required');
    if (store.findRepoByName(name) !== undefined) return errorJson(422, 'Repository already exists');
    const repo = store.createRepo(name, {
      description: asString(body.value.description),
      isPrivate: asBool(body.value.private, false),
    });
    return jsonResult(201, repoObject(store, repo));
  }

  // GET /user/repos — list with pagination.
  if (ctx.method === 'GET' && seg.length === 2 && seg[0] === 'user' && seg[1] === 'repos') {
    const all = store.reposOf().map((r) => repoObject(store, r));
    const { page, nextPage, lastPage } = paginate(all, ctx);
    const perPage = Math.max(1, parseInt(ctx.query.get('per_page') ?? '30', 10) || 30);
    const headers: Record<string, string> = {};
    if (nextPage !== null) headers.link = linkHeader(ctx, '/api/v3/user/repos', perPage, nextPage, lastPage);
    return jsonResult(200, page, headers);
  }

  // /repos/{owner}/{repo}/...
  if (seg.length >= 3 && seg[0] === 'repos') {
    const owner = seg[1] as string;
    const repoName = seg[2] as string;
    return handleRepoRoute(ctx, owner, repoName, seg.slice(3));
  }

  return errorJson(404, 'Not Found');
}

function handleRepoRoute(ctx: RestContext, owner: string, repoName: string, rest: string[]): RouteResult {
  const { store } = ctx;
  const repo = store.getRepo(owner, repoName);

  // GET /repos/{o}/{r}
  if (rest.length === 0) {
    if (repo === undefined) return errorJson(404, 'Not Found');
    if (ctx.method === 'GET') return jsonResult(200, repoObject(store, repo));
    if (ctx.method === 'PATCH') {
      const body = bodyObject(ctx);
      if (!body.ok) return errorJson(400, 'Malformed JSON body');
      if (typeof body.value.description === 'string') repo.description = body.value.description;
      repo.updatedAt = store.nowIso();
      return jsonResult(200, repoObject(store, repo));
    }
    if (ctx.method === 'DELETE') {
      repo.deleted = true;
      return emptyResult(204);
    }
    return errorJson(404, 'Not Found');
  }

  // All routes below need the repo to exist.
  if (repo === undefined) return errorJson(404, 'Not Found');

  const [head, ...tail] = rest as [string, ...string[]];

  // POST /git/refs
  if (head === 'git' && tail.length === 1 && tail[0] === 'refs' && ctx.method === 'POST') {
    const body = bodyObject(ctx);
    if (!body.ok) return errorJson(400, 'Malformed JSON body');
    const ref = asString(body.value.ref);
    const sha = asString(body.value.sha);
    const match = /^refs\/(heads|tags)\/(.+)$/.exec(ref);
    if (match === null || !SHA40.test(sha)) return errorJson(422, 'Invalid ref or sha');
    const kind = match[1] as string;
    const name = match[2] as string;
    if (store.getObject(repo, sha) === undefined) return errorJson(422, 'Object not found');
    if (kind === 'heads') {
      if (repo.refs.has(name)) return errorJson(422, 'Reference already exists');
      repo.refs.set(name, sha);
      if (repo.refs.size === 1 && repo.tags.size === 0) repo.defaultBranch = name;
    } else {
      if (repo.tags.has(name)) return errorJson(422, 'Reference already exists');
      repo.tags.set(name, sha);
    }
    repo.pushedAt = store.nowIso();
    return jsonResult(201, { ref, object: { sha } });
  }

  // GET /git/refs/heads/{branch} (MCP setup reads a branch tip this way).
  if (head === 'git' && tail.length === 3 && tail[0] === 'refs' && tail[1] === 'heads' && ctx.method === 'GET') {
    const branch = tail[2] as string;
    const sha = repo.refs.get(branch);
    if (sha === undefined) return errorJson(404, 'Not Found');
    return jsonResult(200, { ref: `refs/heads/${branch}`, object: { sha } });
  }

  // GET /branches and GET /branches/{branch}
  if (head === 'branches' && ctx.method === 'GET') {
    if (tail.length === 0) {
      const list = [...repo.refs.entries()].map(([name, sha]) => ({ name, commit: { sha }, protected: false }));
      return jsonResult(200, list);
    }
    if (tail.length === 1) {
      const sha = repo.refs.get(tail[0] as string);
      if (sha === undefined) return errorJson(404, 'Not Found');
      return jsonResult(200, { name: tail[0], commit: { sha }, protected: false });
    }
    return errorJson(404, 'Not Found');
  }

  // GET /commits[?sha=]
  if (head === 'commits' && ctx.method === 'GET') {
    const ref = ctx.query.get('sha');
    const tip = resolveRef(store, repo, ref);
    if (tip === null) return jsonResult(200, []);
    const history = commitHistory(store, repo, tip).map((c) => {
      const author = parseIdent(c.author);
      const committer = parseIdent(c.committer);
      return {
        sha: c.sha,
        commit: {
          message: c.message,
          author: { name: author.name, email: author.email, date: author.date },
          committer: { name: committer.name, email: committer.email, date: committer.date },
        },
      };
    });
    return jsonResult(200, history);
  }

  // /contents/{path...}
  if (head === 'contents') {
    return handleContents(ctx, repo, tail);
  }

  // POST /labels
  if (head === 'labels' && tail.length === 0 && ctx.method === 'POST') {
    const body = bodyObject(ctx);
    if (!body.ok) return errorJson(400, 'Malformed JSON body');
    const name = asString(body.value.name);
    if (name === '') return errorJson(422, 'Label name is required');
    const existing = repo.labels.get(name);
    if (existing !== undefined) return jsonResult(201, { name, color: existing.color, description: existing.description });
    const label = { name, color: asString(body.value.color) || 'ededed', description: asString(body.value.description) };
    repo.labels.set(name, label);
    return jsonResult(201, { name: label.name, color: label.color, description: label.description });
  }

  // /issues...
  if (head === 'issues') {
    return handleIssues(ctx, repo, tail);
  }

  // /pulls...
  if (head === 'pulls') {
    return handlePulls(ctx, repo, tail);
  }

  return errorJson(404, 'Not Found');
}

// ------------------------------------------------------------ contents

function handleContents(ctx: RestContext, repo: Repo, tail: string[]): RouteResult {
  const { store } = ctx;
  const path = tail.join('/');
  if (ctx.method === 'PUT') {
    const body = bodyObject(ctx);
    if (!body.ok) return errorJson(400, 'Malformed JSON body');
    const message = asString(body.value.message) || 'Update file';
    const contentB64 = asString(body.value.content);
    const sha = asString(body.value.sha);
    const branch = asString(body.value.branch) || repo.defaultBranch;
    const content = base64DecodeLoose(contentB64);
    // Resolve the branch tip (create the branch from the default tip if new).
    let tip = repo.refs.get(branch);
    if (tip === undefined) {
      const baseTip = repo.refs.get(repo.defaultBranch);
      if (baseTip !== undefined) {
        repo.refs.set(branch, baseTip);
        tip = baseTip;
      }
    }
    const baseTree = tip === undefined ? null : parseCommit(store.getObject(repo, tip)?.data ?? Buffer.alloc(0)).tree;
    const files = baseTree === null ? new Map() : store.treeFiles(repo, baseTree);
    const current = files.get(path);
    const isCreate = current === undefined;
    if (!isCreate && sha !== '' && current !== undefined && current.oid.toLowerCase() !== sha.toLowerCase()) {
      return errorJson(409, 'Stale sha: the file has changed');
    }
    const blobOid = store.putObject(repo, 'blob', content);
    const newTree = store.setPathInTree(repo, baseTree, path, blobOid);
    const commitOid = store.commitOnBranch(repo, branch, newTree, `${message}\n`);
    return jsonResult(isCreate ? 201 : 200, {
      content: { name: path.split('/').pop() ?? path, path, sha: blobOid, size: content.length, encoding: 'base64', type: 'file' },
      commit: { sha: commitOid },
    });
  }
  if (ctx.method === 'GET') {
    const ref = ctx.query.get('ref');
    const tip = resolveRef(store, repo, ref);
    if (tip === null) return errorJson(404, 'Not Found');
    const treeOid = parseCommit(store.getObject(repo, tip)?.data ?? Buffer.alloc(0)).tree;
    const files = store.treeFiles(repo, treeOid);
    if (path === '') {
      // Root listing.
      const entries = new Map<string, { type: string; name: string; path: string; sha: string }>();
      for (const [p, f] of files) {
        const first = p.split('/')[0] as string;
        if (!entries.has(first)) {
          const isDir = p.includes('/');
          entries.set(first, { type: isDir ? 'dir' : 'file', name: first, path: first, sha: isDir ? '' : f.oid });
        }
      }
      return jsonResult(200, [...entries.values()]);
    }
    const file = files.get(path);
    if (file !== undefined) {
      const obj = store.getObject(repo, file.oid);
      const content = obj === undefined ? Buffer.alloc(0) : obj.data;
      return jsonResult(200, {
        type: 'file',
        encoding: 'base64',
        size: content.length,
        name: path.split('/').pop() ?? path,
        path,
        sha: file.oid,
        content: base64Encode(content),
      });
    }
    // Directory?
    const prefix = `${path}/`;
    const children = new Map<string, { type: string; name: string; path: string; sha: string }>();
    for (const [p, f] of files) {
      if (!p.startsWith(prefix)) continue;
      const rest = p.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash < 0) children.set(rest, { type: 'file', name: rest, path: p, sha: f.oid });
      else {
        const dir = rest.slice(0, slash);
        if (!children.has(dir)) children.set(dir, { type: 'dir', name: dir, path: `${path}/${dir}`, sha: '' });
      }
    }
    if (children.size === 0) return errorJson(404, 'Not Found');
    // Directory entries need a sha; compute the subtree oid for dirs.
    const out = [...children.values()].map((c) => {
      if (c.type === 'dir') return { ...c, sha: dirTreeSha(store, repo, treeOid, c.path) };
      return c;
    });
    return jsonResult(200, out);
  }
  if (ctx.method === 'DELETE') {
    const body = bodyObject(ctx);
    if (!body.ok) return errorJson(400, 'Malformed JSON body');
    const message = asString(body.value.message) || 'Delete file';
    const branch = asString(body.value.branch) || repo.defaultBranch;
    const tip = repo.refs.get(branch);
    if (tip === undefined) return errorJson(404, 'Not Found');
    const baseTree = parseCommit(store.getObject(repo, tip)?.data ?? Buffer.alloc(0)).tree;
    const files = store.treeFiles(repo, baseTree);
    if (!files.has(path)) return errorJson(404, 'Not Found');
    const newTree = store.setPathInTree(repo, baseTree, path, null);
    const commitOid = store.commitOnBranch(repo, branch, newTree, `${message}\n`);
    return jsonResult(200, { commit: { sha: commitOid } });
  }
  return errorJson(404, 'Not Found');
}

/** The tree oid of the directory at `dirPath` within the tree `treeOid`. */
function dirTreeSha(store: Store, repo: Repo, treeOid: string, dirPath: string): string {
  const parts = dirPath.split('/').filter((p) => p !== '');
  let current: string | null = treeOid;
  for (const part of parts) {
    if (current === null) return ZERO_OID;
    const obj = store.getObject(repo, current);
    if (obj === undefined || obj.type !== 'tree') return ZERO_OID;
    const entry = parseTree(obj.data).find((e) => e.name === part && e.mode === '40000');
    current = entry === undefined ? null : entry.oid;
  }
  return current ?? ZERO_OID;
}

// ------------------------------------------------------------ issues

function handleIssues(ctx: RestContext, repo: Repo, tail: string[]): RouteResult {
  const { store } = ctx;
  // POST /issues — create.
  if (tail.length === 0 && ctx.method === 'POST') {
    const body = bodyObject(ctx);
    if (!body.ok) return errorJson(400, 'Malformed JSON body');
    const title = asString(body.value.title);
    const bodyText = asString(body.value.body);
    const labelsRaw = Array.isArray(body.value.labels) ? (body.value.labels as unknown[]) : [];
    const labels: string[] = [];
    for (const l of labelsRaw) {
      const name = typeof l === 'string' ? l : asString((l as Record<string, unknown> | null)?.name);
      if (name === '') continue;
      if (!repo.labels.has(name)) return errorJson(422, `Label does not exist: ${name}`);
      labels.push(name);
    }
    const issue = store.createIssue(repo, title, bodyText, labels);
    return jsonResult(201, issueObject(store, repo, issue));
  }
  // GET /issues — list.
  if (tail.length === 0 && ctx.method === 'GET') {
    let items = [...repo.issues.values()];
    const state = ctx.query.get('state');
    if (state === 'open' || state === 'closed') items = items.filter((i) => i.state === state);
    else if (state === null || state === '') items = items.filter((i) => i.state === 'open');
    // state=all: no filter.
    const direction = ctx.query.get('direction');
    if (ctx.query.get('sort') === 'created' || ctx.query.get('sort') === null) {
      items.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
    }
    const { page } = paginate(items, ctx);
    return jsonResult(200, page.map((i) => issueObject(store, repo, i)));
  }
  if (tail.length >= 1) {
    const num = parseInt(tail[0] as string, 10);
    if (!Number.isFinite(num)) return errorJson(404, 'Not Found');
    const issue = repo.issues.get(num);
    if (issue === undefined) return errorJson(404, 'Not Found');
    // GET /issues/{n}
    if (tail.length === 1 && ctx.method === 'GET') return jsonResult(200, issueObject(store, repo, issue));
    // PATCH /issues/{n}
    if (tail.length === 1 && ctx.method === 'PATCH') {
      const body = bodyObject(ctx);
      if (!body.ok) return errorJson(400, 'Malformed JSON body');
      if (body.value.state === 'open' || body.value.state === 'closed') issue.state = body.value.state;
      if (typeof body.value.title === 'string') issue.title = body.value.title;
      if (typeof body.value.body === 'string') issue.body = body.value.body;
      issue.updatedAt = store.nowIso();
      return jsonResult(200, { number: issue.number, state: issue.state });
    }
    // /issues/{n}/comments
    if (tail.length === 2 && tail[1] === 'comments') {
      if (ctx.method === 'POST') {
        const body = bodyObject(ctx);
        if (!body.ok) return errorJson(400, 'Malformed JSON body');
        const comment = store.addComment(repo, num, asString(body.value.body));
        return jsonResult(201, commentObject(store, repo, comment));
      }
      if (ctx.method === 'GET') {
        const list = repo.comments.get(num) ?? [];
        return jsonResult(200, list.map((c) => commentObject(store, repo, c)));
      }
    }
  }
  return errorJson(404, 'Not Found');
}

// ------------------------------------------------------------ pull requests

function handlePulls(ctx: RestContext, repo: Repo, tail: string[]): RouteResult {
  const { store } = ctx;
  // POST /pulls — create.
  if (tail.length === 0 && ctx.method === 'POST') {
    const body = bodyObject(ctx);
    if (!body.ok) return errorJson(400, 'Malformed JSON body');
    const title = asString(body.value.title);
    const bodyText = asString(body.value.body);
    const head = asString(body.value.head);
    const base = asString(body.value.base) || repo.defaultBranch;
    const pr = store.createPullRequest(repo, title, bodyText, head, base);
    return jsonResult(201, prObject(store, repo, pr));
  }
  // GET /pulls — list.
  if (tail.length === 0 && ctx.method === 'GET') {
    let items = [...repo.prs.values()];
    const state = ctx.query.get('state');
    if (state !== 'all') items = items.filter((p) => p.state === 'open');
    items.sort((a, b) => b.number - a.number);
    const { page } = paginate(items, ctx);
    return jsonResult(200, page.map((p) => prObject(store, repo, p)));
  }
  if (tail.length >= 1) {
    const num = parseInt(tail[0] as string, 10);
    if (!Number.isFinite(num)) return errorJson(404, 'Not Found');
    const pr = repo.prs.get(num);
    if (pr === undefined) return errorJson(404, 'Not Found');
    // GET /pulls/{n}
    if (tail.length === 1 && ctx.method === 'GET') return jsonResult(200, prObject(store, repo, pr));
    // GET /pulls/{n}/files
    if (tail.length === 2 && tail[1] === 'files' && ctx.method === 'GET') {
      const baseCommit = store.getObject(repo, pr.baseSha);
      const headCommit = store.getObject(repo, pr.headSha);
      if (baseCommit === undefined || headCommit === undefined) return jsonResult(200, []);
      const baseTree = parseCommit(baseCommit.data).tree;
      const headTree = parseCommit(headCommit.data).tree;
      const baseFiles = store.treeFiles(repo, baseTree);
      const headFiles = store.treeFiles(repo, headTree);
      const paths = store.diffPaths(repo, baseTree, headTree);
      const out = paths.map((path) => {
        const b = baseFiles.get(path);
        const h = headFiles.get(path);
        const status = b === undefined ? 'added' : h === undefined ? 'removed' : 'modified';
        const newText = h === undefined ? '' : (store.getObject(repo, h.oid)?.data.toString('utf8') ?? '');
        const oldText = b === undefined ? '' : (store.getObject(repo, b.oid)?.data.toString('utf8') ?? '');
        let additions = 0;
        let deletions = 0;
        if (status === 'added') additions = Math.max(1, lineCount(newText));
        else if (status === 'removed') deletions = Math.max(1, lineCount(oldText));
        else {
          const newLines = new Set(newText.split('\n'));
          const oldLines = new Set(oldText.split('\n'));
          additions = [...newLines].filter((l) => !oldLines.has(l)).length;
          deletions = [...oldLines].filter((l) => !newLines.has(l)).length;
          if (additions === 0 && deletions === 0) additions = 1;
        }
        return { filename: path, status, additions, deletions, changes: additions + deletions };
      });
      return jsonResult(200, out);
    }
    // PUT /pulls/{n}/merge
    if (tail.length === 2 && tail[1] === 'merge' && ctx.method === 'PUT') {
      const body = bodyObject(ctx);
      if (!body.ok) return errorJson(400, 'Malformed JSON body');
      if (pr.state === 'closed') return errorJson(405, 'Pull request is already closed');
      const merged = store.squashMerge(repo, pr);
      if (merged === null) return errorJson(405, 'Merge conflict');
      pr.state = 'closed';
      pr.merged = true;
      pr.mergeCommitSha = merged.commitOid;
      pr.mergedAt = store.nowIso();
      pr.updatedAt = pr.mergedAt;
      return jsonResult(200, { merged: true, sha: merged.commitOid, message: `Merged pull request #${pr.number}` });
    }
  }
  return errorJson(404, 'Not Found');
}
