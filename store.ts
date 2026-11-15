// Shared in-memory store for the forge: repos, git objects, issues, PRs, labels.
// Everything lives in memory (fast for the timed workloads) and is deterministic:
// no wall-clock time enters state — timestamps come from a monotonic counter
// seeded at the trial's opening time (MAKEFUN_TRIAL_NOW), so a replay leaves
// the same export byte for byte.

import { hashObject, buildTree, buildCommit, parseTree, parseCommit } from './gitobj.ts';
import type { GitObjectType } from './gitobj.ts';

export type IssueState = 'open' | 'closed';
export type PrState = 'open' | 'closed';

export interface GitObject {
  readonly type: GitObjectType;
  readonly data: Buffer;
}

export interface Label {
  readonly name: string;
  readonly color: string;
  readonly description: string;
}

export interface Issue {
  readonly number: number;
  title: string;
  body: string;
  state: IssueState;
  labels: string[];
  readonly createdAt: string;
  updatedAt: string;
}

export interface PullRequest {
  readonly number: number;
  title: string;
  body: string;
  state: PrState;
  merged: boolean;
  mergeCommitSha: string | null;
  head: string; // branch name
  base: string; // branch name
  /** Base branch tip at creation (merge-base for conflict detection). */
  baseSha: string;
  /** Head branch tip at creation. */
  headSha: string;
  readonly createdAt: string;
  updatedAt: string;
  mergedAt: string | null;
}

export interface IssueComment {
  readonly id: number;
  readonly issueNumber: number;
  body: string;
  readonly createdAt: string;
  updatedAt: string;
}

export interface Repo {
  owner: string; // '' until the viewer login is learned
  readonly name: string;
  readonly databaseId: number;
  description: string;
  isPrivate: boolean;
  /** Branch of the first commit pushed, or 'main' before any push. */
  defaultBranch: string;
  readonly createdAt: string;
  updatedAt: string;
  pushedAt: string | null;
  readonly refs: Map<string, string>; // branch name -> tip commit oid
  readonly tags: Map<string, string>; // tag name -> oid
  readonly objects: Map<string, GitObject>;
  readonly issues: Map<number, Issue>;
  issueSeq: number;
  readonly labels: Map<string, Label>;
  readonly prs: Map<number, PullRequest>;
  prSeq: number;
  readonly comments: Map<number, IssueComment[]>; // issue number -> comments
  commentSeq: number;
  deleted: boolean;
}

export interface User {
  readonly login: string;
  readonly id: number;
}

// The trial's opening time is the only "now" a request may carry (determinism
// rule): timestamps come from it, never the wall clock. Falls back to the
// scenario epoch when the variable is absent (local runs).
const TRIAL_NOW_MS = (() => {
  const raw = process.env.MAKEFUN_TRIAL_NOW ?? '';
  const parsed = raw === '' ? NaN : Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : 1735689600000; // 2025-01-01T00:00:00Z
})();

/** Opaque Relay-style global ids: base64url of a typed payload. Never the bare number. */
export function globalId(kind: string, payload: string): string {
  return Buffer.from(`${kind}:${payload}`, 'utf8').toString('base64url');
}

export function parseGlobalId(id: string): { kind: string; payload: string } | null {
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    const colon = text.indexOf(':');
    if (colon < 0) return null;
    return { kind: text.slice(0, colon), payload: text.slice(colon + 1) };
  } catch {
    return null;
  }
}

export class Store {
  readonly users = new Map<string, User>();
  /** Repos keyed by name: a trial has exactly one token owner, so names are unique. */
  readonly reposByName = new Map<string, Repo>();
  /** The token owner's login, learned from the first owner a request names. */
  viewerLogin: string | null = null;
  #repoSeq = 0;
  #userSeq = 0;
  #clock = 0; // monotonic tick; each tick = 1 second after the trial's opening time

  /** Deterministic ISO timestamp; advances 1s per call. */
  nowIso(): string {
    this.#clock += 1;
    return new Date(TRIAL_NOW_MS + this.#clock * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  }

  /** Deterministic unix seconds for commit author/committer stamps. */
  nowUnix(): number {
    this.#clock += 1;
    return Math.floor(TRIAL_NOW_MS / 1000) + this.#clock;
  }

  /**
   * Learn the viewer login from the first owner a request names. The bearer token
   * does not encode a login, so the server adopts the first owner it sees; the
   * suite always names the viewer first (git group runs first, then repos), and
   * the stranger login only ever appears in the foreign-owner 404 check.
   */
  learnViewer(login: string): string {
    if (this.viewerLogin === null) {
      this.viewerLogin = login;
      for (const repo of this.reposByName.values()) {
        if (repo.owner === '') repo.owner = login;
      }
    }
    return this.viewerLogin;
  }

  /** True iff `owner` is the token owner (learning it on first sight). */
  isViewer(owner: string): boolean {
    return this.learnViewer(owner) === owner;
  }

  user(login: string): User {
    let u = this.users.get(login);
    if (u === undefined) {
      this.#userSeq += 1;
      u = { login, id: this.#userSeq };
      this.users.set(login, u);
    }
    return u;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    if (!this.isViewer(owner)) return undefined;
    const repo = this.reposByName.get(name);
    if (repo === undefined || repo.deleted) return undefined;
    if (repo.owner === '') repo.owner = owner;
    return repo;
  }

  /** The repo with this name regardless of owner (creation / duplicate checks). */
  findRepoByName(name: string): Repo | undefined {
    const repo = this.reposByName.get(name);
    return repo !== undefined && !repo.deleted ? repo : undefined;
  }

  /** All non-deleted repos, in creation order (all belong to the viewer). */
  reposOf(): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.reposByName.values()) {
      if (!repo.deleted) out.push(repo);
    }
    return out;
  }

  createRepo(name: string, opts: { description?: string; isPrivate?: boolean }): Repo {
    this.#repoSeq += 1;
    const now = this.nowIso();
    const repo: Repo = {
      owner: this.viewerLogin ?? '',
      name,
      databaseId: this.#repoSeq,
      description: opts.description ?? '',
      isPrivate: opts.isPrivate ?? false,
      defaultBranch: 'main',
      createdAt: now,
      updatedAt: now,
      pushedAt: null,
      refs: new Map(),
      tags: new Map(),
      objects: new Map(),
      issues: new Map(),
      issueSeq: 0,
      labels: new Map(),
      prs: new Map(),
      prSeq: 0,
      comments: new Map(),
      commentSeq: 0,
      deleted: false,
    };
    this.reposByName.set(name, repo);
    return repo;
  }

  // ------------------------------------------------------------ git objects

  getObject(repo: Repo, oid: string): GitObject | undefined {
    return repo.objects.get(oid);
  }

  putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  /** Store objects from a pack; returns the oids stored (oids already known from readPack — no re-hash). */
  putObjects(repo: Repo, objects: readonly { type: GitObjectType; data: Buffer; oid: string }[]): string[] {
    const oids: string[] = [];
    for (const obj of objects) {
      if (!repo.objects.has(obj.oid)) repo.objects.set(obj.oid, { type: obj.type, data: obj.data });
      oids.push(obj.oid);
    }
    return oids;
  }

  /** Ref name for a branch, e.g. refs/heads/main. */
  static branchRef(branch: string): string {
    return `refs/heads/${branch}`;
  }

  /** All refs (branches + tags) as full refname -> oid, sorted by refname. */
  allRefs(repo: Repo): { ref: string; oid: string }[] {
    const out: { ref: string; oid: string }[] = [];
    for (const [branch, oid] of repo.refs) out.push({ ref: Store.branchRef(branch), oid });
    for (const [tag, oid] of repo.tags) out.push({ ref: `refs/tags/${tag}`, oid });
    out.sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));
    return out;
  }

  /** Is `ancestor` an ancestor of `descendant` (or equal)? Walks all parents. */
  isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
    if (ancestor === descendant) return true;
    // Fast path: the common case is a linear push, where the old tip is a
    // direct parent of the new commit — one parse instead of a full walk.
    // (A root commit has no ancestors at all.)
    const head = repo.objects.get(descendant);
    if (head !== undefined && head.type === 'commit') {
      const commit = parseCommit(head.data);
      if (commit.parents.includes(ancestor)) return true;
      if (commit.parents.length === 0) return false;
    }
    const seen = new Set<string>();
    const queue: string[] = [descendant];
    while (queue.length > 0) {
      const oid = queue.pop() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const obj = repo.objects.get(oid);
      if (obj === undefined || obj.type !== 'commit') continue;
      const commit = parseCommit(obj.data);
      for (const parent of commit.parents) {
        if (parent === ancestor) return true;
        queue.push(parent);
      }
    }
    return false;
  }

  /** Full recursive file map of a tree: path -> {mode, oid}. */
  treeFiles(repo: Repo, treeOid: string): Map<string, { mode: string; oid: string }> {
    const out = new Map<string, { mode: string; oid: string }>();
    const walk = (oid: string, prefix: string): void => {
      const obj = repo.objects.get(oid);
      if (obj === undefined || obj.type !== 'tree') return;
      for (const entry of parseTree(obj.data)) {
        const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.mode === '40000') walk(entry.oid, path);
        else out.set(path, { mode: entry.mode, oid: entry.oid });
      }
    };
    walk(treeOid, '');
    return out;
  }

  /** Files changed between two trees (added/modified/deleted), as sorted paths. */
  diffPaths(repo: Repo, baseTree: string, headTree: string): string[] {
    const base = this.treeFiles(repo, baseTree);
    const head = this.treeFiles(repo, headTree);
    const changed: string[] = [];
    for (const [path, h] of head) {
      const b = base.get(path);
      if (b === undefined || b.oid !== h.oid) changed.push(path);
    }
    for (const path of base.keys()) {
      if (!head.has(path)) changed.push(path);
    }
    changed.sort();
    return changed;
  }

  // ------------------------------------------------------------ contents API

  /** Build a new tree with `path` set to `blobOid` (or removed when null). */
  setPathInTree(repo: Repo, baseTreeOid: string | null, path: string, blobOid: string | null): string {
    const parts = path.split('/').filter((p) => p !== '');
    const build = (treeOid: string | null, depth: number): string => {
      const entries = new Map<string, { mode: string; oid: string }>();
      if (treeOid !== null) {
        const obj = repo.objects.get(treeOid);
        if (obj !== undefined && obj.type === 'tree') {
          for (const e of parseTree(obj.data)) entries.set(e.name, { mode: e.mode, oid: e.oid });
        }
      }
      const name = parts[depth] as string;
      if (depth === parts.length - 1) {
        if (blobOid === null) entries.delete(name);
        else entries.set(name, { mode: '100644', oid: blobOid });
      } else {
        const child = entries.get(name);
        const childTree = build(child !== undefined && child.mode === '40000' ? child.oid : null, depth + 1);
        if (childTree === '') entries.delete(name);
        else entries.set(name, { mode: '40000', oid: childTree });
      }
      if (entries.size === 0) return '';
      const treeData = buildTree(
        [...entries.entries()].map(([n, e]) => ({ mode: e.mode, name: n, oid: e.oid })),
      );
      return this.putObject(repo, 'tree', treeData);
    };
    const result = build(baseTreeOid, 0);
    if (result === '') {
      // Empty tree: store the canonical empty tree.
      return this.putObject(repo, 'tree', buildTree([]));
    }
    return result;
  }

  /** Create a commit on `branch` with the given tree; returns the commit oid. */
  commitOnBranch(repo: Repo, branch: string, treeOid: string, message: string): string {
    const parent = repo.refs.get(branch);
    const stamp = this.nowUnix();
    const author = 'forge <forge@example.com>';
    const commitData = buildCommit({
      tree: treeOid,
      parents: parent !== undefined ? [parent] : [],
      message,
      author,
      committer: author,
      timestamp: stamp,
    });
    const oid = this.putObject(repo, 'commit', commitData);
    const wasFirst = repo.refs.size === 0 && repo.tags.size === 0;
    repo.refs.set(branch, oid);
    if (wasFirst) repo.defaultBranch = branch;
    repo.pushedAt = this.nowIso();
    return oid;
  }

  /**
   * Three-way file-level merge of a PR onto its base branch. Returns the merge
   * commit oid, or null when the merge conflicts (a path the head changed from
   * the merge-base was also changed differently on the base since).
   */
  squashMerge(repo: Repo, pr: PullRequest): { commitOid: string; treeOid: string } | null {
    const baseTip = repo.refs.get(pr.base);
    const headTip = repo.refs.get(pr.head);
    if (baseTip === undefined || headTip === undefined) return null;
    const baseCommit = repo.objects.get(baseTip);
    const headCommit = repo.objects.get(headTip);
    const mergeBaseCommit = repo.objects.get(pr.baseSha);
    if (baseCommit === undefined || headCommit === undefined || mergeBaseCommit === undefined) return null;
    const baseTree = parseCommit(baseCommit.data).tree;
    const headTree = parseCommit(headCommit.data).tree;
    const mergeBaseTree = parseCommit(mergeBaseCommit.data).tree;
    const baseFiles = this.treeFiles(repo, baseTree);
    const headFiles = this.treeFiles(repo, headTree);
    const mergeBaseFiles = this.treeFiles(repo, mergeBaseTree);
    // Conflict: a path changed head-vs-mergeBase AND base-vs-mergeBase differently.
    const headChanged = this.diffPaths(repo, mergeBaseTree, headTree);
    for (const path of headChanged) {
      const m = mergeBaseFiles.get(path);
      const b = baseFiles.get(path);
      const h = headFiles.get(path);
      const baseChanged = (b?.oid ?? null) !== (m?.oid ?? null);
      const headDiffersFromBase = (h?.oid ?? null) !== (b?.oid ?? null);
      if (baseChanged && headDiffersFromBase) return null;
    }
    // Result tree: merge-base files, overridden by head's changes, then by the
    // base's changes to paths the head did not touch.
    const result = new Map<string, { mode: string; oid: string }>(mergeBaseFiles);
    for (const path of headChanged) {
      const h = headFiles.get(path);
      if (h === undefined) result.delete(path);
      else result.set(path, h);
    }
    const baseChangedPaths = this.diffPaths(repo, mergeBaseTree, baseTree);
    for (const path of baseChangedPaths) {
      if (headChanged.includes(path)) continue;
      const b = baseFiles.get(path);
      if (b === undefined) result.delete(path);
      else result.set(path, b);
    }
    const treeOid = this.buildTreeFromFiles(repo, result);
    const stamp = this.nowUnix();
    const author = 'forge <forge@example.com>';
    const commitData = buildCommit({
      tree: treeOid,
      parents: [baseTip],
      message: `${pr.title} (#${pr.number})\n`,
      author,
      committer: author,
      timestamp: stamp,
    });
    const oid = this.putObject(repo, 'commit', commitData);
    repo.refs.set(pr.base, oid);
    repo.pushedAt = this.nowIso();
    return { commitOid: oid, treeOid };
  }

  /** True iff the PR would conflict if merged now (same rule as squashMerge). */
  prConflicts(repo: Repo, pr: PullRequest): boolean {
    const baseTip = repo.refs.get(pr.base);
    const headTip = repo.refs.get(pr.head);
    if (baseTip === undefined || headTip === undefined) return false;
    const baseCommit = repo.objects.get(baseTip);
    const headCommit = repo.objects.get(headTip);
    const mergeBaseCommit = repo.objects.get(pr.baseSha);
    if (baseCommit === undefined || headCommit === undefined || mergeBaseCommit === undefined) return false;
    const baseFiles = this.treeFiles(repo, parseCommit(baseCommit.data).tree);
    const headFiles = this.treeFiles(repo, parseCommit(headCommit.data).tree);
    const mergeBaseFiles = this.treeFiles(repo, parseCommit(mergeBaseCommit.data).tree);
    const headChanged = this.diffPaths(repo, parseCommit(mergeBaseCommit.data).tree, parseCommit(headCommit.data).tree);
    for (const path of headChanged) {
      const m = mergeBaseFiles.get(path);
      const b = baseFiles.get(path);
      const h = headFiles.get(path);
      if ((b?.oid ?? null) !== (m?.oid ?? null) && (h?.oid ?? null) !== (b?.oid ?? null)) return true;
    }
    return false;
  }

  /** Build a tree object from a flat path map (nested dirs created as needed). */
  buildTreeFromFiles(repo: Repo, files: Map<string, { mode: string; oid: string }>): string {
    const build = (prefix: string): string => {
      const entries: { mode: string; name: string; oid: string }[] = [];
      const dirs = new Set<string>();
      for (const [path, f] of files) {
        if (!path.startsWith(prefix)) continue;
        const rest = path.slice(prefix.length);
        const slash = rest.indexOf('/');
        if (slash < 0) entries.push({ mode: f.mode, name: rest, oid: f.oid });
        else dirs.add(rest.slice(0, slash));
      }
      for (const dir of dirs) {
        entries.push({ mode: '40000', name: dir, oid: build(`${prefix}${dir}/`) });
      }
      if (entries.length === 0) return '';
      return this.putObject(repo, 'tree', buildTree(entries));
    };
    const result = build('');
    return result === '' ? this.putObject(repo, 'tree', buildTree([])) : result;
  }

  // ------------------------------------------------------------ issues / PRs

  createIssue(repo: Repo, title: string, body: string, labels: string[]): Issue {
    repo.issueSeq += 1;
    const now = this.nowIso();
    const issue: Issue = {
      number: repo.issueSeq,
      title,
      body,
      state: 'open',
      labels: [...labels],
      createdAt: now,
      updatedAt: now,
    };
    repo.issues.set(issue.number, issue);
    return issue;
  }

  createPullRequest(repo: Repo, title: string, body: string, head: string, base: string): PullRequest {
    repo.prSeq += 1;
    const now = this.nowIso();
    const pr: PullRequest = {
      number: repo.prSeq,
      title,
      body,
      state: 'open',
      merged: false,
      mergeCommitSha: null,
      head,
      base,
      baseSha: repo.refs.get(base) ?? '0'.repeat(40),
      headSha: repo.refs.get(head) ?? '0'.repeat(40),
      createdAt: now,
      updatedAt: now,
      mergedAt: null,
    };
    repo.prs.set(pr.number, pr);
    return pr;
  }

  addComment(repo: Repo, issueNumber: number, body: string): IssueComment {
    repo.commentSeq += 1;
    const now = this.nowIso();
    const comment: IssueComment = { id: repo.commentSeq, issueNumber, body, createdAt: now, updatedAt: now };
    const list = repo.comments.get(issueNumber) ?? [];
    list.push(comment);
    repo.comments.set(issueNumber, list);
    return comment;
  }
}
