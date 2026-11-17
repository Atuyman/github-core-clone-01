// GraphQL v4 at /api/graphql: a minimal parser + executor for the fixed set of
// documents gh / github-mcp-server send (18 documents, 5 mutations, Relay ids,
// introspection, batching). No GraphQL library — stdlib only.

import { Store, globalId, parseGlobalId, type Repo, type Issue, type PullRequest } from './store.ts';
import { parseCommit } from './gitobj.ts';
import { jsonResult, errorJson, type RouteResult } from './util.ts';

// ------------------------------------------------------------ lexer

type Token =
  | { kind: 'punct'; value: string }
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: string }
  | { kind: 'float'; value: string }
  | { kind: 'string'; value: string };

function lex(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if ('{}()[]:!=$@&|'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '.' && input.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < input.length && input[j] !== '"') {
        if (input[j] === '\\' && j + 1 < input.length) {
          const esc = input[j + 1] as string;
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          j += 2;
        } else {
          out += input[j] as string;
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      while (j < input.length && /[0-9.]/.test(input[j] as string)) j += 1;
      const text = input.slice(i, j);
      tokens.push(text.includes('.') ? { kind: 'float', value: text } : { kind: 'int', value: text });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < input.length && /[A-Za-z0-9_]/.test(input[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: input.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  return tokens;
}

// ------------------------------------------------------------ parser

export type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: { name: string; value: ValueNode }[] };

export interface FieldNode {
  readonly kind: 'field';
  readonly alias: string | null;
  readonly name: string;
  readonly args: { name: string; value: ValueNode }[];
  readonly selectionSet: SelectionNode[];
}

export interface FragmentNode {
  readonly kind: 'fragment';
  readonly typeCondition: string;
  readonly selectionSet: SelectionNode[];
}

export type SelectionNode = FieldNode | FragmentNode;

export interface OperationNode {
  readonly type: 'query' | 'mutation';
  readonly name: string | null;
  readonly variableDefinitions: { name: string; type: string; nullable: boolean }[];
  readonly selectionSet: SelectionNode[];
}

class Parser {
  #tokens: Token[];
  #pos = 0;

  constructor(tokens: Token[]) {
    this.#tokens = tokens;
  }

  #peek(): Token | undefined {
    return this.#tokens[this.#pos];
  }

  #next(): Token {
    const tok = this.#tokens[this.#pos];
    if (tok === undefined) throw new Error('unexpected end of GraphQL document');
    this.#pos += 1;
    return tok;
  }

  #expectPunct(value: string): void {
    const tok = this.#next();
    if (tok.kind !== 'punct' || tok.value !== value) throw new Error(`expected ${value} in GraphQL document`);
  }

  #expectName(value?: string): string {
    const tok = this.#next();
    if (tok.kind !== 'name') throw new Error('expected a name in GraphQL document');
    if (value !== undefined && tok.value !== value) throw new Error(`expected ${value} in GraphQL document`);
    return tok.value;
  }

  parseDocument(): OperationNode[] {
    const operations: OperationNode[] = [];
    while (this.#pos < this.#tokens.length) {
      operations.push(this.#parseOperation());
    }
    return operations;
  }

  #parseOperation(): OperationNode {
    let type: 'query' | 'mutation' = 'query';
    let name: string | null = null;
    const tok = this.#peek();
    if (tok !== undefined && tok.kind === 'name' && (tok.value === 'query' || tok.value === 'mutation')) {
      type = tok.value as 'query' | 'mutation';
      this.#next();
      const next = this.#peek();
      if (next !== undefined && next.kind === 'name') name = this.#next().value as string;
    } else if (tok !== undefined && tok.kind === 'name') {
      name = this.#next().value as string;
    }
    const variableDefinitions: OperationNode['variableDefinitions'] = [];
    if (this.#peek()?.kind === 'punct' && (this.#peek() as { value: string }).value === '(') {
      this.#next();
      while (!(this.#peek()?.kind === 'punct' && (this.#peek() as { value: string }).value === ')')) {
        this.#expectPunct('$');
        const varName = this.#expectName();
        this.#expectPunct(':');
        const varType = this.#parseType();
        variableDefinitions.push({ name: varName, type: varType.type, nullable: varType.nullable });
        if (this.#peek()?.kind === 'punct' && (this.#peek() as { value: string }).value === '=') {
          this.#next();
          this.#parseValue();
        }
      }
      this.#expectPunct(')');
    }
    const selectionSet = this.#parseSelectionSet();
    return { type, name, variableDefinitions, selectionSet };
  }

  #parseType(): { type: string; nullable: boolean } {
    let nullable = true;
    const tok = this.#next();
    let type: string;
    if (tok.kind === 'punct' && tok.value === '[') {
      const inner = this.#parseType();
      this.#expectPunct(']');
      type = `[${inner.type}]`;
    } else if (tok.kind === 'name') {
      type = tok.value;
    } else {
      throw new Error('expected a type in GraphQL document');
    }
    if (this.#peek()?.kind === 'punct' && (this.#peek() as { value: string }).value === '!') {
      this.#next();
      nullable = false;
    }
    return { type, nullable };
  }

  #parseSelectionSet(): SelectionNode[] {
    this.#expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!(this.#peek()?.kind === 'punct' && (this.#peek() as { value: string }).value === '}')) {
      selections.push(this.#parseSelection());
    }
    this.#expectPunct('}');
    return selections;
  }

  #parseSelection(): SelectionNode {
    const tok = this.#peek();
    if (tok?.kind === 'punct' && tok.value === '...') {
      this.#next();
      const next = this.#peek();
      if (next?.kind === 'name' && next.value === 'on') {
        this.#next();
        const typeCondition = this.#expectName();
        return { kind: 'fragment', typeCondition, selectionSet: this.#parseSelectionSet() };
      }
      // Named fragment spread (not used by the checked documents) — skip its set.
      this.#expectName();
      return { kind: 'fragment', typeCondition: '', selectionSet: [] };
    }
    const first = this.#expectName();
    let alias: string | null = null;
    let name = first;
    if (this.#peek()?.kind === 'punct' && (this.#peek() as { value: string }).value === ':') {
      this.#next();
      alias = first;
      name = this.#expectName();
    }
    const args: FieldNode['args'] = [];
    if (this.#peek()?.kind === 'punct' && (this.#peek() as { value: string }).value === '(') {
      this.#next();
      while (!(this.#peek()?.kind === 'punct' && (this.#peek() as { value: string }).value === ')')) {
        const argName = this.#expectName();
        this.#expectPunct(':');
        args.push({ name: argName, value: this.#parseValue() });
      }
      this.#expectPunct(')');
    }
    let selectionSet: SelectionNode[] = [];
    if (this.#peek()?.kind === 'punct' && (this.#peek() as { value: string }).value === '{') {
      selectionSet = this.#parseSelectionSet();
    }
    return { kind: 'field', alias, name, args, selectionSet };
  }

  #parseValue(): ValueNode {
    const tok = this.#next();
    if (tok.kind === 'punct' && tok.value === '$') return { kind: 'variable', name: this.#expectName() };
    if (tok.kind === 'punct' && tok.value === '[') {
      const values: ValueNode[] = [];
      while (!(this.#peek()?.kind === 'punct' && (this.#peek() as { value: string }).value === ']')) {
        values.push(this.#parseValue());
      }
      this.#expectPunct(']');
      return { kind: 'list', values };
    }
    if (tok.kind === 'punct' && tok.value === '{') {
      const fields: { name: string; value: ValueNode }[] = [];
      while (!(this.#peek()?.kind === 'punct' && (this.#peek() as { value: string }).value === '}')) {
        const name = this.#expectName();
        this.#expectPunct(':');
        fields.push({ name, value: this.#parseValue() });
      }
      this.#expectPunct('}');
      return { kind: 'object', fields };
    }
    if (tok.kind === 'int') return { kind: 'int', value: parseInt(tok.value, 10) };
    if (tok.kind === 'float') return { kind: 'float', value: parseFloat(tok.value) };
    if (tok.kind === 'string') return { kind: 'string', value: tok.value };
    if (tok.kind === 'name') {
      if (tok.value === 'true') return { kind: 'boolean', value: true };
      if (tok.value === 'false') return { kind: 'boolean', value: false };
      if (tok.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: tok.value };
    }
    throw new Error('unexpected value in GraphQL document');
  }
}

// ------------------------------------------------------------ schema tables

const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', '__type'],
  User: ['login', 'id', 'name', 'email', 'url'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'isPrivate', 'createdAt', 'updatedAt', 'url'],
  Ref: ['name'],
  Issue: ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'author', 'labels', 'url'],
  IssueConnection: ['nodes', 'pageInfo', 'totalCount'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRefOid', 'baseRefOid', 'files', 'createdAt', 'updatedAt', 'mergedAt', 'author', 'url'],
  PullRequestConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestChangedFileConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  IssueComment: ['id', 'body', 'createdAt', 'updatedAt', 'author'],
  IssueCommentEdge: ['node', 'cursor'],
  AddCommentPayload: ['commentEdge', 'clientMutationId'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  __Type: ['name', 'kind', 'fields', 'enumValues', 'description'],
  __Field: ['name', 'description', 'type'],
  __EnumValue: ['name', 'description'],
  Node: ['id'],
};

const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
};

// ------------------------------------------------------------ executor

interface ExecContext {
  store: Store;
  variables: Record<string, unknown>;
  errors: { message: string }[];
}

type ResolvedValue =
  | { __typename: string; [key: string]: unknown }
  | Record<string, unknown>
  | unknown;

function valueOf(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name] ?? null;
    case 'int':
    case 'float':
    case 'string':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((v) => valueOf(v, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const f of node.fields) out[f.name] = valueOf(f.value, variables);
      return out;
    }
  }
}

function argValue(field: FieldNode, name: string, ctx: ExecContext): unknown {
  const arg = field.args.find((a) => a.name === name);
  return arg === undefined ? undefined : valueOf(arg.value, ctx.variables);
}

function issueId(store: Store, repo: Repo, issue: Issue): string {
  return globalId('issue', `${repo.owner}/${repo.name}/${issue.number}`);
}

function repoId(store: Store, repo: Repo): string {
  return globalId('repo', `${repo.owner}/${repo.name}`);
}

function prId(store: Store, repo: Repo, pr: PullRequest): string {
  return globalId('pr', `${repo.owner}/${repo.name}/${pr.number}`);
}

function issueState(issue: Issue): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}

function prState(pr: PullRequest): string {
  if (pr.merged) return 'MERGED';
  return pr.state === 'open' ? 'OPEN' : 'CLOSED';
}

function resolveIssue(ctx: ExecContext, repo: Repo, issue: Issue, selections: SelectionNode[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of selections) {
    if (sel.kind === 'fragment') continue;
    const key = sel.alias ?? sel.name;
    switch (sel.name) {
      case 'id':
        out[key] = issueId(ctx.store, repo, issue);
        break;
      case 'number':
        out[key] = issue.number;
        break;
      case 'title':
        out[key] = issue.title;
        break;
      case 'state':
        out[key] = issueState(issue);
        break;
      case 'body':
        out[key] = issue.body;
        break;
      case 'createdAt':
        out[key] = issue.createdAt;
        break;
      case 'updatedAt':
        out[key] = issue.updatedAt;
        break;
      default:
        ctx.errors.push({ message: `Cannot query field "${sel.name}" on type "Issue".` });
        out[key] = null;
    }
  }
  return out;
}

function resolvePr(ctx: ExecContext, repo: Repo, pr: PullRequest, selections: SelectionNode[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of selections) {
    if (sel.kind === 'fragment') continue;
    const key = sel.alias ?? sel.name;
    switch (sel.name) {
      case 'id':
        out[key] = prId(ctx.store, repo, pr);
        break;
      case 'number':
        out[key] = pr.number;
        break;
      case 'title':
        out[key] = pr.title;
        break;
      case 'body':
        out[key] = pr.body;
        break;
      case 'state':
        out[key] = prState(pr);
        break;
      case 'merged':
        out[key] = pr.merged;
        break;
      case 'mergeable':
        out[key] = pr.state === 'open' ? (ctx.store.prConflicts(repo, pr) ? 'CONFLICTING' : 'MERGEABLE') : 'UNKNOWN';
        break;
      case 'headRefName':
        out[key] = pr.head;
        break;
      case 'baseRefName':
        out[key] = pr.base;
        break;
      case 'headRefOid':
        out[key] = repo.refs.get(pr.head) ?? pr.headSha;
        break;
      case 'baseRefOid':
        out[key] = repo.refs.get(pr.base) ?? pr.baseSha;
        break;
      case 'createdAt':
        out[key] = pr.createdAt;
        break;
      case 'updatedAt':
        out[key] = pr.updatedAt;
        break;
      case 'mergedAt':
        out[key] = pr.mergedAt;
        break;
      case 'files': {
        const first = argValue(sel, 'first', ctx);
        const baseCommit = ctx.store.getObject(repo, pr.baseSha);
        const headCommit = ctx.store.getObject(repo, pr.headSha);
        let paths: string[] = [];
        if (baseCommit !== undefined && headCommit !== undefined) {
          paths = ctx.store.diffPaths(repo, parseCommit(baseCommit.data).tree, parseCommit(headCommit.data).tree);
        }
        const cap = typeof first === 'number' ? first : paths.length;
        const nodes = paths.slice(0, cap).map((path) => ({ __typename: 'PullRequestChangedFile', path }));
        const filesObj: Record<string, unknown> = { __typename: 'PullRequestChangedFileConnection' };
        for (const sub of sel.selectionSet) {
          if (sub.kind === 'fragment') continue;
          if (sub.name === 'nodes') {
            filesObj[sub.alias ?? 'nodes'] = nodes.map((n) => resolveChangedFile(ctx, n, sub.selectionSet));
          } else if (sub.name === 'pageInfo') {
            filesObj[sub.alias ?? 'pageInfo'] = { __typename: 'PageInfo', hasNextPage: paths.length > cap, endCursor: null };
          } else {
            ctx.errors.push({ message: `Cannot query field "${sub.name}" on type "PullRequestChangedFileConnection".` });
          }
        }
        out[key] = filesObj;
        break;
      }
      default:
        ctx.errors.push({ message: `Cannot query field "${sel.name}" on type "PullRequest".` });
        out[key] = null;
    }
  }
  return out;
}

function resolveChangedFile(ctx: ExecContext, node: { path: string }, selections: SelectionNode[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of selections) {
    if (sel.kind === 'fragment') continue;
    if (sel.name === 'path') out[sel.alias ?? 'path'] = node.path;
    else {
      ctx.errors.push({ message: `Cannot query field "${sel.name}" on type "PullRequestChangedFile".` });
      out[sel.alias ?? sel.name] = null;
    }
  }
  return out;
}

function cursorFor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64url');
}

function numberFromCursor(cursor: string | null | undefined): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  try {
    const text = Buffer.from(cursor, 'base64url').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match === null ? null : parseInt(match[1] as string, 10);
  } catch {
    return null;
  }
}

function resolveIssuesConnection(ctx: ExecContext, repo: Repo, field: FieldNode): Record<string, unknown> {
  const first = argValue(field, 'first', ctx);
  const states = argValue(field, 'states', ctx);
  const orderBy = argValue(field, 'orderBy', ctx) as { field?: string; direction?: string } | undefined;
  const after = argValue(field, 'after', ctx) as string | null | undefined;
  let items = [...repo.issues.values()];
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((s) => String(s)));
    items = items.filter((i) => wanted.has(issueState(i)));
  }
  const afterNumber = numberFromCursor(after);
  if (orderBy !== undefined && orderBy.field === 'CREATED_AT' && orderBy.direction === 'DESC') {
    items.sort((a, b) => b.number - a.number);
    if (afterNumber !== null) items = items.filter((i) => i.number < afterNumber);
  } else {
    items.sort((a, b) => a.number - b.number);
    if (afterNumber !== null) items = items.filter((i) => i.number > afterNumber);
  }
  const cap = typeof first === 'number' ? first : items.length;
  const page = items.slice(0, cap);
  const hasNextPage = items.length > cap;
  const endCursor = page.length > 0 ? cursorFor(page[page.length - 1]?.number as number) : null;
  const out: Record<string, unknown> = { __typename: 'IssueConnection' };
  for (const sub of field.selectionSet) {
    if (sub.kind === 'fragment') continue;
    if (sub.name === 'nodes') {
      out[sub.alias ?? 'nodes'] = page.map((issue) => resolveIssue(ctx, repo, issue, sub.selectionSet));
    } else if (sub.name === 'pageInfo') {
      const pageInfo: Record<string, unknown> = { __typename: 'PageInfo' };
      for (const pi of sub.selectionSet) {
        if (pi.kind === 'fragment') continue;
        if (pi.name === 'hasNextPage') pageInfo[pi.alias ?? 'hasNextPage'] = hasNextPage;
        else if (pi.name === 'endCursor') pageInfo[pi.alias ?? 'endCursor'] = endCursor;
        else if (pi.name === 'hasPreviousPage') pageInfo[pi.alias ?? 'hasPreviousPage'] = false;
        else if (pi.name === 'startCursor') pageInfo[pi.alias ?? 'startCursor'] = page.length > 0 ? cursorFor(page[0]?.number as number) : null;
        else ctx.errors.push({ message: `Cannot query field "${pi.name}" on type "PageInfo".` });
      }
      out[sub.alias ?? 'pageInfo'] = pageInfo;
    } else if (sub.name === 'totalCount') {
      out[sub.alias ?? 'totalCount'] = items.length;
    } else {
      ctx.errors.push({ message: `Cannot query field "${sub.name}" on type "IssueConnection".` });
    }
  }
  return out;
}

function resolvePrsConnection(ctx: ExecContext, repo: Repo, field: FieldNode): Record<string, unknown> {
  const first = argValue(field, 'first', ctx);
  const states = argValue(field, 'states', ctx);
  let items = [...repo.prs.values()];
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((s) => String(s)));
    items = items.filter((p) => wanted.has(prState(p)));
  }
  items.sort((a, b) => b.number - a.number);
  const cap = typeof first === 'number' ? first : items.length;
  const page = items.slice(0, cap);
  const out: Record<string, unknown> = { __typename: 'PullRequestConnection' };
  for (const sub of field.selectionSet) {
    if (sub.kind === 'fragment') continue;
    if (sub.name === 'nodes') {
      out[sub.alias ?? 'nodes'] = page.map((pr) => resolvePr(ctx, repo, pr, sub.selectionSet));
    } else if (sub.name === 'pageInfo') {
      out[sub.alias ?? 'pageInfo'] = { __typename: 'PageInfo', hasNextPage: items.length > cap, endCursor: null };
    } else if (sub.name === 'totalCount') {
      out[sub.alias ?? 'totalCount'] = items.length;
    } else {
      ctx.errors.push({ message: `Cannot query field "${sub.name}" on type "PullRequestConnection".` });
    }
  }
  return out;
}

function resolveRepository(ctx: ExecContext, repo: Repo, selections: SelectionNode[]): Record<string, unknown> {
  const out: Record<string, unknown> = { __typename: 'Repository' };
  for (const sel of selections) {
    if (sel.kind === 'fragment') {
      if (sel.typeCondition === 'Repository' || sel.typeCondition === '') {
        Object.assign(out, resolveRepository(ctx, repo, sel.selectionSet));
      }
      continue;
    }
    const key = sel.alias ?? sel.name;
    switch (sel.name) {
      case 'id':
        out[key] = repoId(ctx.store, repo);
        break;
      case 'databaseId':
        out[key] = repo.databaseId;
        break;
      case 'name':
        out[key] = repo.name;
        break;
      case 'nameWithOwner':
        out[key] = `${repo.owner}/${repo.name}`;
        break;
      case 'owner': {
        const ownerObj: Record<string, unknown> = { __typename: 'User' };
        for (const sub of sel.selectionSet) {
          if (sub.kind === 'fragment') continue;
          if (sub.name === 'login') ownerObj[sub.alias ?? 'login'] = repo.owner;
          else if (sub.name === 'id') ownerObj[sub.alias ?? 'id'] = ctx.store.user(repo.owner).id;
          else ctx.errors.push({ message: `Cannot query field "${sub.name}" on type "User".` });
        }
        out[key] = ownerObj;
        break;
      }
      case 'defaultBranchRef': {
        const refObj: Record<string, unknown> = { __typename: 'Ref' };
        for (const sub of sel.selectionSet) {
          if (sub.kind === 'fragment') continue;
          if (sub.name === 'name') refObj[sub.alias ?? 'name'] = repo.defaultBranch;
          else ctx.errors.push({ message: `Cannot query field "${sub.name}" on type "Ref".` });
        }
        out[key] = refObj;
        break;
      }
      case 'viewerPermission':
        out[key] = 'ADMIN';
        break;
      case 'hasIssuesEnabled':
        out[key] = true;
        break;
      case 'description':
        out[key] = repo.description;
        break;
      case 'isPrivate':
        out[key] = repo.isPrivate;
        break;
      case 'issue': {
        const number = argValue(sel, 'number', ctx);
        const issue = typeof number === 'number' ? repo.issues.get(number) : undefined;
        out[key] = issue === undefined ? null : resolveIssue(ctx, repo, issue, sel.selectionSet);
        break;
      }
      case 'issues':
        out[key] = resolveIssuesConnection(ctx, repo, sel);
        break;
      case 'pullRequests':
        out[key] = resolvePrsConnection(ctx, repo, sel);
        break;
      case 'pullRequest': {
        const number = argValue(sel, 'number', ctx);
        const pr = typeof number === 'number' ? repo.prs.get(number) : undefined;
        out[key] = pr === undefined ? null : resolvePr(ctx, repo, pr, sel.selectionSet);
        break;
      }
      default:
        ctx.errors.push({ message: `Cannot query field "${sel.name}" on type "Repository".` });
        out[key] = null;
    }
  }
  return out;
}

function resolveTypeIntrospection(ctx: ExecContext, name: string, selections: SelectionNode[]): Record<string, unknown> | null {
  const fields = TYPE_FIELDS[name];
  const enums = ENUM_VALUES[name];
  if (fields === undefined && enums === undefined) return null;
  const out: Record<string, unknown> = { __typename: '__Type', name };
  for (const sel of selections) {
    if (sel.kind === 'fragment') continue;
    const key = sel.alias ?? sel.name;
    if (sel.name === 'fields') {
      out[key] = fields === undefined ? null : fields.map((f) => ({ __typename: '__Field', name: f }));
    } else if (sel.name === 'enumValues') {
      out[key] = enums === undefined ? null : enums.map((e) => ({ __typename: '__EnumValue', name: e }));
    } else if (sel.name === 'kind') {
      out[key] = enums !== undefined ? 'ENUM' : 'OBJECT';
    } else if (sel.name === 'description') {
      out[key] = null;
    } else {
      ctx.errors.push({ message: `Cannot query field "${sel.name}" on type "__Type".` });
      out[key] = null;
    }
  }
  return out;
}

function findRepoByGlobalId(ctx: ExecContext, id: string): Repo | null {
  const parsed = parseGlobalId(id);
  if (parsed === null) return null;
  if (parsed.kind === 'repo') {
    const [owner, name] = parsed.payload.split('/');
    if (owner === undefined || name === undefined) return null;
    return ctx.store.getRepo(owner, name) ?? null;
  }
  return null;
}

function findIssueByGlobalId(ctx: ExecContext, id: string): { repo: Repo; issue: Issue } | null {
  const parsed = parseGlobalId(id);
  if (parsed === null || parsed.kind !== 'issue') return null;
  const parts = parsed.payload.split('/');
  const [owner, name, num] = parts;
  if (owner === undefined || name === undefined || num === undefined) return null;
  const repo = ctx.store.getRepo(owner, name);
  if (repo === undefined) return null;
  const issue = repo.issues.get(parseInt(num, 10));
  return issue === undefined ? null : { repo, issue };
}

function findPrByGlobalId(ctx: ExecContext, id: string): { repo: Repo; pr: PullRequest } | null {
  const parsed = parseGlobalId(id);
  if (parsed === null || parsed.kind !== 'pr') return null;
  const parts = parsed.payload.split('/');
  const [owner, name, num] = parts;
  if (owner === undefined || name === undefined || num === undefined) return null;
  const repo = ctx.store.getRepo(owner, name);
  if (repo === undefined) return null;
  const pr = repo.prs.get(parseInt(num, 10));
  return pr === undefined ? null : { repo, pr };
}

function executeOperation(store: Store, op: OperationNode, variables: Record<string, unknown>): { data: Record<string, unknown> | null; errors: { message: string }[] } {
  const ctx: ExecContext = { store, variables, errors: [] };
  const data: Record<string, unknown> = {};
  if (op.type === 'mutation') {
    executeMutation(ctx, op, data);
    return { data, errors: ctx.errors };
  }
  for (const sel of op.selectionSet) {
    if (sel.kind === 'fragment') continue;
    const key = sel.alias ?? sel.name;
    switch (sel.name) {
      case 'viewer': {
        const viewerObj: Record<string, unknown> = { __typename: 'User' };
        for (const sub of sel.selectionSet) {
          if (sub.kind === 'fragment') continue;
          if (sub.name === 'login') viewerObj[sub.alias ?? 'login'] = store.viewerLogin ?? '';
          else if (sub.name === 'id') viewerObj[sub.alias ?? 'id'] = store.viewerLogin === null ? 0 : store.user(store.viewerLogin).id;
          else ctx.errors.push({ message: `Cannot query field "${sub.name}" on type "User".` });
        }
        data[key] = viewerObj;
        break;
      }
      case 'repository': {
        const owner = argValue(sel, 'owner', ctx);
        const name = argValue(sel, 'name', ctx);
        const repo =
          typeof owner === 'string' && typeof name === 'string' ? store.getRepo(owner, name) ?? null : null;
        data[key] = repo === null ? null : resolveRepository(ctx, repo, sel.selectionSet);
        break;
      }
      case 'node': {
        const id = argValue(sel, 'id', ctx);
        const repo = typeof id === 'string' ? findRepoByGlobalId(ctx, id) : null;
        if (repo === null) {
          data[key] = null;
          break;
        }
        const nodeObj: Record<string, unknown> = { __typename: 'Repository', id };
        for (const sub of sel.selectionSet) {
          if (sub.kind === 'fragment') {
            if (sub.typeCondition === 'Repository') Object.assign(nodeObj, resolveRepository(ctx, repo, sub.selectionSet));
            continue;
          }
          if (sub.name === 'id') nodeObj[sub.alias ?? 'id'] = id;
          else ctx.errors.push({ message: `Cannot query field "${sub.name}" on type "Node".` });
        }
        data[key] = nodeObj;
        break;
      }
      case '__type': {
        const name = argValue(sel, 'name', ctx);
        data[key] = typeof name === 'string' ? resolveTypeIntrospection(ctx, name, sel.selectionSet) : null;
        break;
      }
      default:
        ctx.errors.push({ message: `Cannot query field "${sel.name}" on type "Query".` });
        data[key] = null;
    }
  }
  return { data, errors: ctx.errors };
}

function executeMutation(ctx: ExecContext, op: OperationNode, data: Record<string, unknown>): void {
  for (const sel of op.selectionSet) {
    if (sel.kind === 'fragment') continue;
    const key = sel.alias ?? sel.name;
    const input = argValue(sel, 'input', ctx) as Record<string, unknown> | undefined;
    if (input === undefined) {
      ctx.errors.push({ message: `${String(sel.name)}: missing input` });
      data[key] = null;
      break;
    }
    switch (sel.name) {
      case 'createIssue': {
        const repo = findRepoByGlobalId(ctx, String(input.repositoryId ?? ''));
        if (repo === null) {
          ctx.errors.push({ message: 'createIssue: repository not found' });
          data[key] = null;
          break;
        }
        const issue = ctx.store.createIssue(repo, String(input.title ?? ''), String(input.body ?? ''), []);
        const issueObj: Record<string, unknown> = {};
        for (const sub of sel.selectionSet) {
          if (sub.kind === 'fragment') continue;
          if (sub.name === 'issue') {
            const inner: Record<string, unknown> = {};
            for (const f of sub.selectionSet) {
              if (f.kind === 'fragment') continue;
              if (f.name === 'number') inner[f.alias ?? 'number'] = issue.number;
              else if (f.name === 'id') inner[f.alias ?? 'id'] = issueId(ctx.store, repo, issue);
              else if (f.name === 'title') inner[f.alias ?? 'title'] = issue.title;
              else if (f.name === 'state') inner[f.alias ?? 'state'] = issueState(issue);
              else ctx.errors.push({ message: `Cannot query field "${f.name}" on type "Issue".` });
            }
            issueObj[sub.alias ?? 'issue'] = inner;
          }
        }
        data[key] = issueObj;
        break;
      }
      case 'closeIssue': {
        const found = findIssueByGlobalId(ctx, String(input.issueId ?? ''));
        if (found === null) {
          ctx.errors.push({ message: 'closeIssue: issue not found' });
          data[key] = null;
          break;
        }
        found.issue.state = 'closed';
        found.issue.updatedAt = ctx.store.nowIso();
        found.repo.issueRev += 1;
        const issueObj: Record<string, unknown> = {};
        for (const sub of sel.selectionSet) {
          if (sub.kind === 'fragment') continue;
          if (sub.name === 'issue') {
            const inner: Record<string, unknown> = {};
            for (const f of sub.selectionSet) {
              if (f.kind === 'fragment') continue;
              if (f.name === 'number') inner[f.alias ?? 'number'] = found.issue.number;
              else if (f.name === 'id') inner[f.alias ?? 'id'] = issueId(ctx.store, found.repo, found.issue);
              else if (f.name === 'state') inner[f.alias ?? 'state'] = issueState(found.issue);
              else ctx.errors.push({ message: `Cannot query field "${f.name}" on type "Issue".` });
            }
            issueObj[sub.alias ?? 'issue'] = inner;
          }
        }
        data[key] = issueObj;
        break;
      }
      case 'createPullRequest': {
        const repo = findRepoByGlobalId(ctx, String(input.repositoryId ?? ''));
        if (repo === null) {
          ctx.errors.push({ message: 'createPullRequest: repository not found' });
          data[key] = null;
          break;
        }
        const pr = ctx.store.createPullRequest(
          repo,
          String(input.title ?? ''),
          String(input.body ?? ''),
          String(input.headRefName ?? ''),
          String(input.baseRefName ?? ''),
        );
        const prObj: Record<string, unknown> = {};
        for (const sub of sel.selectionSet) {
          if (sub.kind === 'fragment') continue;
          if (sub.name === 'pullRequest') {
            prObj[sub.alias ?? 'pullRequest'] = resolvePr(ctx, repo, pr, sub.selectionSet);
          }
        }
        data[key] = prObj;
        break;
      }
      case 'mergePullRequest': {
        const found = findPrByGlobalId(ctx, String(input.pullRequestId ?? ''));
        if (found === null) {
          ctx.errors.push({ message: 'mergePullRequest: pull request not found' });
          data[key] = null;
          break;
        }
        const merged = ctx.store.squashMerge(found.repo, found.pr);
        if (merged === null) {
          ctx.errors.push({ message: 'mergePullRequest: merge conflict' });
          data[key] = null;
          break;
        }
        found.pr.state = 'closed';
        found.pr.merged = true;
        found.pr.mergeCommitSha = merged.commitOid;
        found.pr.mergedAt = ctx.store.nowIso();
        found.pr.updatedAt = found.pr.mergedAt;
        const prObj: Record<string, unknown> = {};
        for (const sub of sel.selectionSet) {
          if (sub.kind === 'fragment') continue;
          if (sub.name === 'pullRequest') {
            prObj[sub.alias ?? 'pullRequest'] = resolvePr(ctx, found.repo, found.pr, sub.selectionSet);
          }
        }
        data[key] = prObj;
        break;
      }
      case 'addComment': {
        const found = findIssueByGlobalId(ctx, String(input.subjectId ?? ''));
        if (found === null) {
          ctx.errors.push({ message: 'addComment: issue not found' });
          data[key] = null;
          break;
        }
        const comment = ctx.store.addComment(found.repo, found.issue.number, String(input.body ?? ''));
        const commentId = globalId('comment', `${found.repo.owner}/${found.repo.name}/${found.issue.number}/${comment.id}`);
        const payload: Record<string, unknown> = {};
        for (const sub of sel.selectionSet) {
          if (sub.kind === 'fragment') continue;
          if (sub.name === 'commentEdge') {
            const edge: Record<string, unknown> = {};
            for (const e of sub.selectionSet) {
              if (e.kind === 'fragment') continue;
              if (e.name === 'node') {
                const node: Record<string, unknown> = {};
                for (const n of e.selectionSet) {
                  if (n.kind === 'fragment') continue;
                  if (n.name === 'id') node[n.alias ?? 'id'] = commentId;
                  else if (n.name === 'body') node[n.alias ?? 'body'] = comment.body;
                  else ctx.errors.push({ message: `Cannot query field "${n.name}" on type "IssueComment".` });
                }
                edge[e.alias ?? 'node'] = node;
              }
            }
            payload[sub.alias ?? 'commentEdge'] = edge;
          }
        }
        data[key] = payload;
        break;
      }
      default:
        ctx.errors.push({ message: `Cannot query field "${sel.name}" on type "Mutation".` });
        data[key] = null;
    }
  }
}

// ------------------------------------------------------------ HTTP entry

export function handleGraphql(store: Store, authorized: boolean, body: Buffer): RouteResult {
  if (!authorized) return errorJson(401, 'Requires authentication');
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8')) as unknown;
  } catch {
    return errorJson(400, 'Malformed JSON body');
  }
  const runOne = (op: unknown): Record<string, unknown> => {
    if (op === null || typeof op !== 'object' || Array.isArray(op)) {
      return { data: null, errors: [{ message: 'Invalid GraphQL operation' }] };
    }
    const obj = op as { query?: unknown; variables?: unknown; operationName?: unknown };
    if (typeof obj.query !== 'string') {
      return { data: null, errors: [{ message: 'Missing query' }] };
    }
    const variables = (obj.variables !== undefined && typeof obj.variables === 'object' && obj.variables !== null ? obj.variables : {}) as Record<string, unknown>;
    let operations: OperationNode[];
    try {
      operations = new Parser(lex(obj.query)).parseDocument();
    } catch (err) {
      return { data: null, errors: [{ message: err instanceof Error ? err.message : 'Parse error' }] };
    }
    const operation =
      typeof obj.operationName === 'string'
        ? operations.find((o) => o.name === obj.operationName) ?? operations[0]
        : operations[0];
    if (operation === undefined) return { data: null, errors: [{ message: 'No operation found' }] };
    const { data, errors } = executeOperation(store, operation, variables);
    const out: Record<string, unknown> = { data };
    if (errors.length > 0) out.errors = errors;
    return out;
  };
  if (Array.isArray(parsed)) {
    return jsonResult(200, parsed.map((op) => runOne(op)));
  }
  return jsonResult(200, runOne(parsed));
}
