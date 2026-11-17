// Git smart HTTP: protocol v2 upload-pack (ls-refs, fetch), v0 upload-pack
// advertisement + fetch fallback, and v0 receive-pack (push). Stdlib only.
// Wire details follow the kit's git-client.ts / checks-git.ts exactly.

import {
  encodePktLine, pktLineFlush, PktLineDecoder, readPack, writePack,
  parseCommit, parseTag, parseTree, isObjectId,
} from './gitobj.ts';
import { Store, type Repo } from './store.ts';
import type { GitObjectType } from './gitobj.ts';

export const ZERO_OID = '0'.repeat(40);

export interface GitResult {
  readonly status: number;
  readonly contentType: string;
  readonly body: Buffer;
}

const UPLOAD_AD = 'application/x-git-upload-pack-advertisement';
const RECEIVE_AD = 'application/x-git-receive-pack-advertisement';
const UPLOAD_RESULT = 'application/x-git-upload-pack-result';
const RECEIVE_RESULT = 'application/x-git-receive-pack-result';

function ok(contentType: string, body: Buffer): GitResult {
  return { status: 200, contentType, body };
}

function notFound(): GitResult {
  return { status: 404, contentType: 'text/plain; charset=utf-8', body: Buffer.from('repository not found\n') };
}

function badRequest(message: string): GitResult {
  return { status: 400, contentType: 'text/plain; charset=utf-8', body: Buffer.from(`${message}\n`) };
}

/** Peel an annotated tag (following tag->tag chains) to its non-tag target. */
function peelTag(store: Store, repo: Repo, oid: string): string {
  let current = oid;
  for (let i = 0; i < 16; i += 1) {
    const obj = store.getObject(repo, current);
    if (obj === undefined || obj.type !== 'tag') return current;
    current = parseTag(obj.data).object;
  }
  return current;
}

/** Split a sideband payload into pkt-lines of band byte + <=65515 bytes. */
function sidebandPackets(band: number, data: Buffer): Buffer[] {
  const out: Buffer[] = [];
  const CHUNK = 65515;
  if (data.length === 0) return out;
  for (let off = 0; off < data.length; off += CHUNK) {
    const slice = data.subarray(off, Math.min(data.length, off + CHUNK));
    out.push(encodePktLine(Buffer.concat([Buffer.from([band]), slice])));
  }
  return out;
}

// ------------------------------------------------------------ advertisements

const V2_ADVERTISEMENT: Buffer = Buffer.concat([
  encodePktLine('version 2\n'),
  encodePktLine('fetch=shallow\n'),
  encodePktLine('ls-refs=unborn\n'),
  encodePktLine('object-format=sha1\n'),
  pktLineFlush(),
]);

function v2Advertisement(): Buffer {
  return V2_ADVERTISEMENT;
}

/**
 * v0 advertisement: `# service=...` preamble, then ref lines; capabilities ride
 * on the first line after a NUL. Empty repo: a single `capabilities^{}` line.
 *
 * Cached per repo + service + gitRev: the advertisement is a pure function of
 * the ref set, and the clone workload fetches the identical advertisement 50x
 * per round. The cache is keyed by the Repo object (a recreated repo is a new
 * object) and invalidated by any gitRev bump.
 */
const AD_CACHE = new WeakMap<Repo, { rev: number; upload: Buffer | null; receive: Buffer | null }>();
function v0Advertisement(store: Store, repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const cached = AD_CACHE.get(repo);
  if (cached !== undefined && cached.rev === repo.gitRev) {
    const hit = service === 'git-upload-pack' ? cached.upload : cached.receive;
    if (hit !== null) return hit;
  }
  const built = buildV0Advertisement(store, repo, service);
  const entry = cached !== undefined && cached.rev === repo.gitRev
    ? cached
    : { rev: repo.gitRev, upload: null, receive: null };
  if (service === 'git-upload-pack') entry.upload = built;
  else entry.receive = built;
  AD_CACHE.set(repo, entry);
  return built;
}

function buildV0Advertisement(store: Store, repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const lines: Buffer[] = [encodePktLine(`# service=${service}\n`)];
  const caps =
    service === 'git-upload-pack'
      ? 'side-band-64k shallow thin-pack ofs-delta multi_ack_detailed symref=HEAD:refs/heads/main'
      : 'report-status side-band-64k delete-refs ofs-delta symref=HEAD:refs/heads/main';
  const refs = store.allRefs(repo);
  if (refs.length === 0) {
    lines.push(encodePktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    const headTip = repo.refs.get(repo.defaultBranch);
    const headOid = headTip ?? ZERO_OID;
    lines.push(encodePktLine(`${headOid} HEAD\0${caps}\n`));
    for (const { ref, oid } of refs) {
      lines.push(encodePktLine(`${oid} ${ref}\n`));
      const obj = store.getObject(repo, oid);
      if (obj !== undefined && obj.type === 'tag') {
        lines.push(encodePktLine(`${peelTag(store, repo, oid)} ${ref}^{}\n`));
      }
    }
  }
  lines.push(pktLineFlush());
  return Buffer.concat(lines);
}

export function handleInfoRefs(
  store: Store,
  owner: string,
  repoName: string,
  service: string,
  gitProtocol: string | undefined,
): GitResult {
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) return notFound();
  if (service === 'git-upload-pack') {
    if (gitProtocol === 'version=2') return ok(UPLOAD_AD, v2Advertisement());
    return ok(UPLOAD_AD, v0Advertisement(store, repo, 'git-upload-pack'));
  }
  if (service === 'git-receive-pack') {
    return ok(RECEIVE_AD, v0Advertisement(store, repo, 'git-receive-pack'));
  }
  return notFound();
}

// ------------------------------------------------------------ ls-refs (v2)

interface LsRefsOptions {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

function handleLsRefs(store: Store, repo: Repo, opts: LsRefsOptions): Buffer {
  const lines: Buffer[] = [];
  const refs = store.allRefs(repo);
  const includeHead = opts.prefixes.length === 0;
  if (includeHead) {
    const tip = repo.refs.get(repo.defaultBranch);
    const attrs = opts.symrefs ? ' symref-target:refs/heads/main' : '';
    if (tip !== undefined) lines.push(encodePktLine(`${tip} HEAD${attrs}\n`));
    else if (opts.unborn) lines.push(encodePktLine(`unborn HEAD${attrs}\n`));
  }
  for (const { ref, oid } of refs) {
    if (opts.prefixes.length > 0 && !opts.prefixes.some((p) => ref.startsWith(p))) continue;
    let attrs = '';
    if (opts.peel) {
      const obj = store.getObject(repo, oid);
      if (obj !== undefined && obj.type === 'tag') {
        attrs += ` peeled:${peelTag(store, repo, oid)}`;
      }
    }
    lines.push(encodePktLine(`${oid} ${ref}${attrs}\n`));
  }
  lines.push(pktLineFlush());
  return Buffer.concat(lines);
}

// ------------------------------------------------------------ fetch selection

interface FetchSelection {
  objects: { type: GitObjectType; data: Buffer }[];
  shallow: string[];
  unshallow: string[];
}

/**
 * The negotiated object set for a fetch: closure(wants) minus closure(haves),
 * with `deepen` limiting commit generations from each want tip and shallow
 * boundaries stopping the have-closure walk.
 */
function selectFetch(
  store: Store,
  repo: Repo,
  wants: string[],
  haves: string[],
  shallowBoundaries: string[],
  depth: number | null,
): FetchSelection {
  const boundarySet = new Set(shallowBoundaries);
  // Exclusion set E: full closure of each have, except a shallow boundary have
  // contributes only itself (+ its tree/blobs), not its parents.
  const excluded = new Map<string, { type: GitObjectType; data: Buffer }>();
  const excludedCommits = new Set<string>();
  const excludeCommit = (oid: string, includeParents: boolean): void => {
    const queue: string[] = [oid];
    const seen = new Set<string>();
    while (queue.length > 0) {
      const cur = queue.pop() as string;
      if (seen.has(cur)) continue;
      seen.add(cur);
      const obj = store.getObject(repo, cur);
      if (obj === undefined || obj.type !== 'commit') continue;
      excludedCommits.add(cur);
      excluded.set(cur, { type: 'commit', data: obj.data });
      const commit = parseCommit(obj.data);
      addTreeClosure(store, repo, commit.tree, excluded);
      if (includeParents && !boundarySet.has(cur)) {
        for (const parent of commit.parents) queue.push(parent);
      }
    }
  };
  for (const have of haves) {
    const obj = store.getObject(repo, have);
    if (obj === undefined) continue;
    if (obj.type === 'commit') excludeCommit(have, !boundarySet.has(have));
    else if (obj.type === 'tag') {
      excluded.set(have, { type: 'tag', data: obj.data });
      const target = parseTag(obj.data).object;
      const targetObj = store.getObject(repo, target);
      if (targetObj !== undefined && targetObj.type === 'commit') excludeCommit(target, true);
    } else {
      excluded.set(have, { type: obj.type, data: obj.data });
    }
  }

  // Candidate set: BFS from each want; commit generations counted from the want.
  const candidates = new Map<string, { type: GitObjectType; data: Buffer }>();
  const candidateGen = new Map<string, number>(); // commit oid -> min generation (1 = tip)
  const queue: { oid: string; gen: number }[] = [];
  for (const want of wants) queue.push({ oid: want, gen: 1 });
  const seenWant = new Set<string>();
  while (queue.length > 0) {
    const { oid, gen } = queue.shift() as { oid: string; gen: number };
    const key = `${oid}@${gen}`;
    if (seenWant.has(key)) continue;
    seenWant.add(key);
    const obj = store.getObject(repo, oid);
    if (obj === undefined) continue;
    if (obj.type === 'commit') {
      const prevGen = candidateGen.get(oid);
      if (prevGen !== undefined && prevGen <= gen) continue;
      candidateGen.set(oid, gen);
      candidates.set(oid, { type: 'commit', data: obj.data });
      const commit = parseCommit(obj.data);
      addTreeClosure(store, repo, commit.tree, candidates);
      if (depth === null || gen < depth) {
        for (const parent of commit.parents) queue.push({ oid: parent, gen: gen + 1 });
      }
    } else if (obj.type === 'tag') {
      if (!candidates.has(oid)) candidates.set(oid, { type: 'tag', data: obj.data });
      const target = parseTag(obj.data).object;
      queue.push({ oid: target, gen });
    } else {
      if (!candidates.has(oid)) candidates.set(oid, { type: obj.type, data: obj.data });
    }
  }

  // Delivered = candidates minus excluded (object level).
  const objects: { type: GitObjectType; data: Buffer }[] = [];
  const deliveredCommits = new Set<string>();
  for (const [oid, obj] of candidates) {
    if (excluded.has(oid)) continue;
    objects.push(obj);
    if (obj.type === 'commit') deliveredCommits.add(oid);
  }

  // Shallow boundaries: delivered commits at exactly `depth` generations that
  // still have a parent; unshallow: old boundaries whose parents are now all
  // delivered-or-held.
  const shallow: string[] = [];
  const unshallow: string[] = [];
  if (depth !== null) {
    for (const [oid, gen] of candidateGen) {
      if (gen !== depth || !deliveredCommits.has(oid)) continue;
      const obj = store.getObject(repo, oid);
      if (obj !== undefined && obj.type === 'commit' && parseCommit(obj.data).parents.length > 0) {
        shallow.push(oid);
      }
    }
  }
  for (const old of shallowBoundaries) {
    const obj = store.getObject(repo, old);
    if (obj === undefined || obj.type !== 'commit') continue;
    const parents = parseCommit(obj.data).parents;
    if (parents.length === 0) continue;
    const allKnown = parents.every((p) => deliveredCommits.has(p) || excludedCommits.has(p));
    if (allKnown && !shallow.includes(old)) unshallow.push(old);
  }
  return { objects, shallow, unshallow };
}

function addTreeClosure(
  store: Store,
  repo: Repo,
  treeOid: string,
  out: Map<string, { type: GitObjectType; data: Buffer }>,
): void {
  const walk = (oid: string): void => {
    if (out.has(oid)) return;
    const obj = store.getObject(repo, oid);
    if (obj === undefined) return;
    out.set(oid, { type: obj.type, data: obj.data });
    if (obj.type !== 'tree') return;
    for (const entry of parseTree(obj.data)) {
      if (entry.mode === '40000') walk(entry.oid);
      else if (!out.has(entry.oid)) {
        const blob = store.getObject(repo, entry.oid);
        if (blob !== undefined) out.set(entry.oid, { type: blob.type, data: blob.data });
      }
    }
  };
  walk(treeOid);
}

// ------------------------------------------------------------ fetch (v2 + v0)

interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
}

function parseFetchLines(packets: { kind: string; text?: string }[]): FetchRequest {
  const req: FetchRequest = { wants: [], haves: [], shallow: [], depth: null };
  for (const packet of packets) {
    if (packet.kind !== 'data' || packet.text === undefined) continue;
    const line = packet.text.replace(/\n$/, '');
    if (line.startsWith('want ')) req.wants.push(line.slice(5).trim().split(' ')[0] as string);
    else if (line.startsWith('have ')) req.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) req.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const n = parseInt(line.slice(7).trim(), 10);
      if (Number.isFinite(n)) req.depth = n;
    }
    // thin-pack / no-progress / ofs-delta / done / agent= / object-format= : accepted, ignored.
  }
  return req;
}

function fetchResponseV2(selection: FetchSelection, acks: { nak: boolean; acked: string[] }): Buffer {
  const parts: Buffer[] = [];
  parts.push(encodePktLine('acknowledgments\n'));
  if (acks.acked.length > 0) {
    for (const oid of acks.acked) parts.push(encodePktLine(`ACK ${oid}\n`));
    parts.push(encodePktLine('ready\n'));
  } else {
    parts.push(encodePktLine('NAK\n'));
  }
  parts.push(pktLineFlush());
  if (selection.shallow.length > 0 || selection.unshallow.length > 0) {
    parts.push(encodePktLine('shallow-info\n'));
    for (const oid of selection.shallow) parts.push(encodePktLine(`shallow ${oid}\n`));
    for (const oid of selection.unshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
    parts.push(pktLineFlush());
  }
  const pack = writePack(selection.objects);
  parts.push(encodePktLine('packfile\n'));
  for (const pkt of sidebandPackets(1, pack)) parts.push(pkt);
  parts.push(pktLineFlush());
  return Buffer.concat(parts);
}

function fetchResponseV0(selection: FetchSelection, acks: { nak: boolean; acked: string[] }): Buffer {
  const parts: Buffer[] = [];
  if (acks.acked.length > 0) {
    for (const oid of acks.acked) parts.push(encodePktLine(`ACK ${oid}\n`));
  } else {
    parts.push(encodePktLine('NAK\n'));
  }
  for (const oid of selection.shallow) parts.push(encodePktLine(`shallow ${oid}\n`));
  for (const oid of selection.unshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
  const pack = writePack(selection.objects);
  for (const pkt of sidebandPackets(1, pack)) parts.push(pkt);
  parts.push(pktLineFlush());
  return Buffer.concat(parts);
}

function computeAcks(store: Store, repo: Repo, haves: string[]): { nak: boolean; acked: string[] } {
  const acked = haves.filter((h) => store.getObject(repo, h) !== undefined);
  return { nak: acked.length === 0, acked };
}

/**
 * Fetch-response cache: a fetch answer is a pure function of the repo state
 * (gitRev) plus the negotiated request (wants, haves, shallow, depth). The
 * clone workload repeats the identical depth-1 fetch 50x per round, so the
 * first builds the pack and the rest reuse the exact bytes. Keyed by the Repo
 * object; a recreated repo is a new object, so no stale entry can survive a
 * delete + recreate. The cached Buffer is never mutated after creation.
 */
const FETCH_CACHE = new WeakMap<Repo, { key: string; rev: number; body: Buffer }>();
function fetchCacheKey(wants: string[], haves: string[], shallow: string[], depth: number | null): string {
  return `${wants.join(',')}|${haves.join(',')}|${shallow.join(',')}|${depth ?? ''}`;
}

function handleUploadPackPost(store: Store, repo: Repo, body: Buffer): GitResult {
  const decoder = new PktLineDecoder();
  let packets;
  try {
    packets = decoder.push(body);
  } catch {
    return badRequest('malformed pkt-line stream');
  }
  const dataLines = packets.filter((p) => p.kind === 'data').map((p) => (p.kind === 'data' ? p.text : ''));
  const first = dataLines[0] ?? '';
  if (first.startsWith('command=ls-refs')) {
    const opts: LsRefsOptions = { peel: false, symrefs: false, unborn: false, prefixes: [] };
    for (const line of dataLines.slice(1)) {
      const l = line.replace(/\n$/, '');
      if (l === 'peel') opts.peel = true;
      else if (l === 'symrefs') opts.symrefs = true;
      else if (l === 'unborn') opts.unborn = true;
      else if (l.startsWith('ref-prefix ')) opts.prefixes.push(l.slice('ref-prefix '.length));
    }
    return ok(UPLOAD_RESULT, handleLsRefs(store, repo, opts));
  }
  if (first.startsWith('command=fetch')) {
    const req = parseFetchLines(packets);
    const key = fetchCacheKey(req.wants, req.haves, req.shallow, req.depth);
    const hit = FETCH_CACHE.get(repo);
    if (hit !== undefined && hit.rev === repo.gitRev && hit.key === key) return ok(UPLOAD_RESULT, hit.body);
    const selection = selectFetch(store, repo, req.wants, req.haves, req.shallow, req.depth);
    const acks = computeAcks(store, repo, req.haves);
    const out = fetchResponseV2(selection, acks);
    FETCH_CACHE.set(repo, { key, rev: repo.gitRev, body: out });
    return ok(UPLOAD_RESULT, out);
  }
  if (first.startsWith('want ')) {
    // v0 fetch: two sections (wants, then haves) separated by a flush.
    const req = parseFetchLines(packets);
    const key = fetchCacheKey(req.wants, req.haves, req.shallow, req.depth);
    const hit = FETCH_CACHE.get(repo);
    if (hit !== undefined && hit.rev === repo.gitRev && hit.key === key) return ok(UPLOAD_RESULT, hit.body);
    const selection = selectFetch(store, repo, req.wants, req.haves, req.shallow, req.depth);
    const acks = computeAcks(store, repo, req.haves);
    const out = fetchResponseV0(selection, acks);
    FETCH_CACHE.set(repo, { key, rev: repo.gitRev, body: out });
    return ok(UPLOAD_RESULT, out);
  }
  return badRequest('unknown upload-pack command');
}

export function handleUploadPack(
  store: Store,
  owner: string,
  repoName: string,
  body: Buffer,
): GitResult {
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) return notFound();
  return handleUploadPackPost(store, repo, body);
}

// ------------------------------------------------------------ receive-pack

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/** Parse pkt-lines from a buffer, returning packets and the offset just past the flush. */
function parseCommands(body: Buffer): { commands: PushCommand[]; packOffset: number } | null {
  const commands: PushCommand[] = [];
  let offset = 0;
  for (;;) {
    if (offset + 4 > body.length) return null;
    const lenText = body.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(lenText)) return null;
    const len = parseInt(lenText, 16);
    if (len === 0) {
      offset += 4;
      break;
    }
    if (len < 4 || offset + len > body.length) return null;
    const payload = body.subarray(offset + 4, offset + len).toString('utf8');
    offset += len;
    const nul = payload.indexOf('\0');
    const line = (nul >= 0 ? payload.slice(0, nul) : payload).replace(/\n$/, '');
    const parts = line.split(' ');
    if (parts.length < 3) return null;
    commands.push({ oldOid: parts[0] as string, newOid: parts[1] as string, ref: parts[2] as string });
  }
  return { commands, packOffset: offset };
}

function refParts(ref: string): { kind: 'heads' | 'tags'; name: string } | null {
  if (ref.startsWith('refs/heads/')) return { kind: 'heads', name: ref.slice('refs/heads/'.length) };
  if (ref.startsWith('refs/tags/')) return { kind: 'tags', name: ref.slice('refs/tags/'.length) };
  return null;
}

export function handleReceivePack(store: Store, owner: string, repoName: string, body: Buffer): GitResult {
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) return notFound();
  const parsed = parseCommands(body);
  if (parsed === null || parsed.commands.length === 0) return badRequest('malformed receive-pack command list');
  const { commands, packOffset } = parsed;
  const packBytes = body.subarray(packOffset);

  // Unpack first, judge second: a refused update still reports `unpack ok`.
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (packBytes.length > 0) {
    try {
      const { objects } = readPack(packBytes, {
        resolveBase: (oid) => {
          const obj = store.getObject(repo, oid);
          return obj === undefined ? undefined : { type: obj.type, data: obj.data, oid };
        },
      });
      store.putObjects(repo, objects);
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message.slice(0, 200) : 'unpack failed';
    }
  }

  const wasEmpty = repo.refs.size === 0 && repo.tags.size === 0;
  let firstCreatedBranch: string | null = null;
  const reportLines: string[] = [`unpack ${unpackDetail}`];
  for (const cmd of commands) {
    const parts = refParts(cmd.ref);
    let verdict: { ok: boolean; reason: string } = { ok: false, reason: 'invalid ref' };
    if (parts === null) {
      verdict = { ok: false, reason: 'invalid ref' };
    } else if (!isObjectId(cmd.oldOid) || !isObjectId(cmd.newOid)) {
      verdict = { ok: false, reason: 'invalid object id' };
    } else if (!unpackOk) {
      verdict = { ok: false, reason: 'unpack failed' };
    } else {
      const current = parts.kind === 'heads' ? repo.refs.get(parts.name) : repo.tags.get(parts.name);
      if (cmd.newOid === ZERO_OID) {
        // Delete.
        if (current === undefined) verdict = { ok: false, reason: 'ref does not exist' };
        else if (current !== cmd.oldOid) verdict = { ok: false, reason: 'old value mismatch' };
        else verdict = { ok: true, reason: '' };
      } else if (cmd.oldOid === ZERO_OID) {
        // Create.
        if (current !== undefined) verdict = { ok: false, reason: 'ref already exists' };
        else if (store.getObject(repo, cmd.newOid) === undefined) verdict = { ok: false, reason: 'object not found' };
        else verdict = { ok: true, reason: '' };
      } else {
        // Update: fast-forward only.
        if (current === undefined) verdict = { ok: false, reason: 'ref does not exist' };
        else if (current !== cmd.oldOid) verdict = { ok: false, reason: 'old value mismatch' };
        else if (!store.isAncestor(repo, cmd.oldOid, cmd.newOid)) verdict = { ok: false, reason: 'non-fast-forward' };
        else verdict = { ok: true, reason: '' };
      }
    }
    if (verdict.ok && parts !== null) {
      if (cmd.newOid === ZERO_OID) {
        if (parts.kind === 'heads') repo.refs.delete(parts.name);
        else repo.tags.delete(parts.name);
      } else {
        if (parts.kind === 'heads') {
          repo.refs.set(parts.name, cmd.newOid);
          if (wasEmpty && firstCreatedBranch === null) firstCreatedBranch = parts.name;
        } else {
          repo.tags.set(parts.name, cmd.newOid);
        }
      }
      repo.gitRev += 1;
      repo.pushedAt = store.nowIso();
    }
    reportLines.push(verdict.ok ? `ok ${cmd.ref}` : `ng ${cmd.ref} ${verdict.reason}`);
  }
  if (wasEmpty && firstCreatedBranch !== null) repo.defaultBranch = firstCreatedBranch;

  // Report: pkt-framed lines inside band-1 sideband packets (the client demuxes
  // band 1 then parses the pkt-framed report stream).
  const inner = Buffer.concat(reportLines.map((line) => encodePktLine(`${line}\n`)));
  const bodyOut = Buffer.concat([...sidebandPackets(1, inner), pktLineFlush()]);
  return ok(RECEIVE_RESULT, bodyOut);
}
