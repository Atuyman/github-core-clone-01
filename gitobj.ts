// Git object model and packfile codec (stdlib only: node:crypto, node:zlib).
// Implements the git object format and the pack protocol framing the suite speaks:
// loose object hashing, trees/commits/tags, pack read (incl. ofs/ref deltas) and
// pack write (plain objects, no deltas — always valid, and fast for small packs).

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

const TYPE_CODE: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export function sha1Hex(data: Uint8Array): string {
  return createHash('sha1').update(data).digest('hex');
}

/** `<type> <size>\0<data>` — the bytes a loose object hashes over. */
export function objectHeader(type: GitObjectType, size: number): Buffer {
  return Buffer.from(`${type} ${size}\0`, 'ascii');
}

/** The SHA-1 id of an object. */
export function hashObject(type: GitObjectType, data: Uint8Array): string {
  // Two updates instead of a concat: same hash, no throwaway copy of the data.
  return createHash('sha1').update(objectHeader(type, data.length)).update(data).digest('hex');
}

/** A loose object as stored: zlib-deflated `<type> <size>\0<data>`. */
export function encodeLooseObject(type: GitObjectType, data: Uint8Array): Buffer {
  // Level 1: a valid zlib stream either way, produced faster. Inflate is
  // identical, so stored objects read back exactly as before.
  return deflateSync(Buffer.concat([objectHeader(type, data.length), Buffer.from(data)]), { level: 1 });
}

const HEX40 = /^[0-9a-f]{40}$/;
export function isObjectId(value: string): boolean {
  return HEX40.test(value);
}

// ---------------------------------------------------------------- trees

export interface TreeEntry {
  readonly mode: string;
  readonly name: string;
  readonly oid: string;
}

export function parseTree(data: Uint8Array): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) throw new Error('tree entry has no mode');
    const mode = Buffer.from(data.subarray(offset, space)).toString('ascii');
    const nul = data.indexOf(0, space + 1);
    if (nul < 0) throw new Error('tree entry has no name');
    const name = Buffer.from(data.subarray(space + 1, nul)).toString('utf8');
    if (nul + 21 > data.length) throw new Error('tree entry has no oid');
    const oid = Buffer.from(data.subarray(nul + 1, nul + 21)).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

function compareTreeNames(a: { name: string; mode: string }, b: { name: string; mode: string }): number {
  const an = a.mode === '40000' ? `${a.name}/` : a.name;
  const bn = b.mode === '40000' ? `${b.name}/` : b.name;
  return an < bn ? -1 : an > bn ? 1 : 0;
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- commits / tags

export interface CommitView {
  readonly tree: string;
  readonly parents: readonly string[];
  readonly author: string;
  readonly committer: string;
  readonly message: string;
  readonly raw: string;
}

export function parseCommit(data: Uint8Array): CommitView {
  const raw = Buffer.from(data).toString('utf8');
  const headEnd = raw.indexOf('\n\n');
  const head = headEnd < 0 ? raw : raw.slice(0, headEnd);
  const message = headEnd < 0 ? '' : raw.slice(headEnd + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message, raw };
}

export interface BuildCommitFields {
  readonly tree: string;
  readonly parents: readonly string[];
  readonly message: string;
  readonly author: string;
  readonly committer: string;
  readonly timestamp: number;
}

export function buildCommit(fields: BuildCommitFields): Buffer {
  const stamp = `${fields.timestamp} +0000`;
  const lines: string[] = [`tree ${fields.tree}`];
  for (const parent of fields.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${fields.author} ${stamp}`);
  lines.push(`committer ${fields.committer} ${stamp}`);
  lines.push('', fields.message);
  return Buffer.from(lines.join('\n'), 'utf8');
}

export interface TagView {
  readonly object: string;
  readonly type: GitObjectType;
  readonly tag: string;
  readonly tagger: string;
  readonly message: string;
}

export function parseTag(data: Uint8Array): TagView {
  const raw = Buffer.from(data).toString('utf8');
  const headEnd = raw.indexOf('\n\n');
  const head = headEnd < 0 ? raw : raw.slice(0, headEnd);
  const message = headEnd < 0 ? '' : raw.slice(headEnd + 2);
  let object = '';
  let type: GitObjectType = 'commit';
  let tag = '';
  let tagger = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim() as GitObjectType;
    else if (line.startsWith('tag ')) tag = line.slice(4);
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}

// ---------------------------------------------------------------- pkt-line

export function encodePktLine(payload: string | Uint8Array): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : Buffer.from(payload);
  const len = body.length + 4;
  if (len > 0xffff) throw new Error('pkt-line too long');
  return Buffer.concat([Buffer.from(len.toString(16).padStart(4, '0'), 'ascii'), body]);
}

export function pktLineFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

export function pktLineDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

export function pktLineResponseEnd(): Buffer {
  return Buffer.from('0002', 'ascii');
}

export type GitPacket =
  | { readonly kind: 'data'; readonly text: string; readonly bytes: Uint8Array }
  | { readonly kind: 'flush' }
  | { readonly kind: 'delim' }
  | { readonly kind: 'response-end' };

export class PktLineDecoder {
  #buffer = Buffer.alloc(0);

  push(chunk: Uint8Array): GitPacket[] {
    this.#buffer = Buffer.concat([this.#buffer, Buffer.from(chunk)]);
    const out: GitPacket[] = [];
    for (;;) {
      if (this.#buffer.length < 4) break;
      const lenText = this.#buffer.subarray(0, 4).toString('ascii');
      if (!/^[0-9a-fA-F]{4}$/.test(lenText)) throw new Error(`bad pkt-line length ${JSON.stringify(lenText)}`);
      const len = parseInt(lenText, 16);
      if (len === 0) {
        out.push({ kind: 'flush' });
        this.#buffer = this.#buffer.subarray(4);
        continue;
      }
      if (len === 1) {
        out.push({ kind: 'delim' });
        this.#buffer = this.#buffer.subarray(4);
        continue;
      }
      if (len === 2) {
        out.push({ kind: 'response-end' });
        this.#buffer = this.#buffer.subarray(4);
        continue;
      }
      if (len < 4 || this.#buffer.length < len) break;
      const bytes = this.#buffer.subarray(4, len);
      out.push({ kind: 'data', text: bytes.toString('utf8'), bytes: Buffer.from(bytes) });
      this.#buffer = this.#buffer.subarray(len);
    }
    return out;
  }

  get buffered(): number {
    return this.#buffer.length;
  }
}

// ---------------------------------------------------------------- pack read

export interface PackObject {
  readonly type: GitObjectType;
  readonly data: Buffer;
  readonly oid: string;
}

function readVarintSize(buffer: Buffer, start: number): { size: number; next: number; first: number } {
  let offset = start;
  const first = buffer[offset] ?? 0;
  let size = first & 0x0f;
  let shift = 4;
  offset += 1;
  let byte = first;
  while ((byte & 0x80) !== 0) {
    byte = buffer[offset] ?? 0;
    size |= (byte & 0x7f) << shift;
    shift += 7;
    offset += 1;
    if (shift > 63) throw new Error('pack object size varint too long');
  }
  return { size, next: offset, first };
}

function readOfsDeltaBase(buffer: Buffer, start: number): { baseOffset: number; next: number } {
  let offset = start;
  let byte = buffer[offset] ?? 0;
  let baseOffset = byte & 0x7f;
  offset += 1;
  while ((byte & 0x80) !== 0) {
    byte = buffer[offset] ?? 0;
    baseOffset = ((baseOffset + 1) << 7) | (byte & 0x7f);
    offset += 1;
  }
  return { baseOffset, next: offset };
}

/** Adler-32 of `data` (the checksum a zlib stream ends with, big-endian). */
function adler32(data: Buffer): number {
  // Deferred modulo: inside a 1024-byte block a stays below 65521 + 1024*255
  // and b below 1024 * that, both far under 2^53, so the per-byte % (the old
  // hot loop) is replaced by one % per block. Same result, bit for bit.
  const MOD = 65521;
  let a = 1;
  let b = 0;
  for (let off = 0; off < data.length; off += 1024) {
    const end = Math.min(off + 1024, data.length);
    for (let i = off; i < end; i += 1) {
      a += data[i] as number;
      b += a;
    }
    a %= MOD;
    b %= MOD;
  }
  return ((b << 16) | a) >>> 0;
}

export function inflateAt(buffer: Uint8Array, offset: number): { data: Buffer; next: number } {
  // Fast path: one inflateSync with { info: true } reports, via
  // engine.bytesWritten, exactly how many input bytes the zlib stream
  // consumed — the stream's end, with no scan and no second inflate. The
  // end is self-verifying: the stream's last 4 bytes are its Adler-32
  // checksum, so if the computed end does not carry it, fall through to the
  // scan path below. (On a Node without the info option the call returns a
  // plain Buffer, or throws on the option; both fall through too.)
  try {
    const res = inflateSync(buffer.subarray(offset), { info: true }) as unknown;
    if (res !== null && typeof res === 'object' && !Buffer.isBuffer(res)) {
      const info = res as { buffer?: unknown; engine?: { bytesWritten?: unknown } };
      const data = info.buffer;
      const written = info.engine?.bytesWritten;
      if (Buffer.isBuffer(data) && typeof written === 'number') {
        const next = offset + written;
        if (next > offset + 2 && next <= buffer.length) {
          const buf = Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength);
          if (buf.readUInt32BE(next - 4) === adler32(data)) return { data, next };
        }
      }
    }
  } catch {
    // Fall through to the scan path.
  }
  // inflateSync ignores bytes after the stream's end, so one call inflates the
  // object; the stream's end is where its Adler-32 checksum sits (its last 4
  // bytes, big-endian). Scan forward for that checksum and verify the slice
  // inflates to the same data — a match inside the deflate payload is rejected
  // because the truncated slice cannot inflate. Two inflateSync calls per
  // object instead of the binary search's ~log2(n) + 1.
  const data = inflateSync(buffer.subarray(offset));
  const checksum = adler32(data);
  const buf = Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  // Same scan as before (every offset whose 4 big-endian bytes equal the
  // checksum), but via Buffer.indexOf: the C++ memmem-style search replaces
  // the per-byte readUInt32BE loop. Each candidate is still verified by
  // inflating the truncated slice, so a match inside the deflate payload is
  // rejected exactly as before.
  const needle = Buffer.alloc(4);
  needle.writeUInt32BE(checksum, 0);
  let p = buf.indexOf(needle, offset + 2);
  while (p !== -1 && p + 4 <= buf.length) {
    const end = p + 4;
    try {
      const check = inflateSync(buffer.subarray(offset, end));
      if (check.equals(data)) return { data, next: end };
    } catch {
      // Match inside the deflate payload: the truncated slice cannot inflate.
    }
    p = buf.indexOf(needle, p + 1);
  }
  // Fallback (never expected for valid packs): the binary search.
  const end = findZlibEnd(buffer, offset);
  return { data: inflateSync(buffer.subarray(offset, end)), next: end };
}

function findZlibEnd(buffer: Uint8Array, offset: number): number {
  // Binary search the smallest end >= offset+2 such that inflateSync succeeds and
  // the stream is complete (inflateSync throws on truncation, succeeds on exact end).
  let lo = offset + 2;
  let hi = buffer.length;
  // First find any end that works by exponential probe from lo.
  let probe = lo;
  let found = -1;
  while (probe <= hi) {
    try {
      inflateSync(buffer.subarray(offset, probe));
      found = probe;
      break;
    } catch {
      // truncated: need more bytes
    }
    probe = probe === lo ? lo + 64 : Math.min(hi, probe * 2);
    if (probe >= hi) {
      try {
        inflateSync(buffer.subarray(offset, hi));
        found = hi;
      } catch {
        throw new Error('truncated zlib stream in pack');
      }
      break;
    }
  }
  if (found < 0) throw new Error('truncated zlib stream in pack');
  hi = found;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    try {
      inflateSync(buffer.subarray(offset, mid));
      hi = mid;
    } catch {
      lo = mid + 1;
    }
  }
  return lo;
}

/** Apply a git delta (copy/insert instruction stream) to a base object's bytes. */
export function applyDelta(base: Uint8Array, delta: Uint8Array): Buffer {
  const baseBuffer = Buffer.from(base);
  const deltaBuffer = Buffer.from(delta);
  let offset = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= deltaBuffer.length) throw new Error('delta size varint is truncated');
      const byte = deltaBuffer[offset++];
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
      if (shift > 63) throw new Error('delta size varint is too long');
    }
    return value;
  };
  const sourceSize = readVarint();
  const targetSize = readVarint();
  if (sourceSize !== baseBuffer.length) throw new Error(`delta expects a ${sourceSize}-byte base, got ${baseBuffer.length}`);
  const out = Buffer.alloc(targetSize);
  let written = 0;
  while (offset < deltaBuffer.length) {
    const op = deltaBuffer[offset++];
    if ((op & 0x80) !== 0) {
      let copyOffset = 0;
      let copySize = 0;
      for (let shift = 0; shift < 4; shift += 1) {
        if ((op & (1 << shift)) !== 0) {
          if (offset >= deltaBuffer.length) throw new Error('delta copy offset is truncated');
          copyOffset |= deltaBuffer[offset++] << (shift * 8);
        }
      }
      for (let shift = 0; shift < 3; shift += 1) {
        if ((op & (0x10 << shift)) !== 0) {
          if (offset >= deltaBuffer.length) throw new Error('delta copy size is truncated');
          copySize |= deltaBuffer[offset++] << (shift * 8);
        }
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > baseBuffer.length) throw new Error('delta copy is out of the base');
      if (written + copySize > targetSize) throw new Error('delta writes past its target size');
      baseBuffer.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op;
      if (offset + literal > deltaBuffer.length) throw new Error('delta insert is truncated');
      if (written + literal > targetSize) throw new Error('delta writes past its target size');
      deltaBuffer.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) throw new Error(`delta produced ${written} of ${targetSize} bytes`);
  return out;
}

export interface PackReadResult {
  readonly objects: PackObject[];
  readonly deltaCount: number;
}

export function packChecksum(pack: Uint8Array): string {
  return sha1Hex(pack.subarray(0, pack.length - 20));
}

export function verifyPackChecksum(pack: Uint8Array): { ok: boolean; expected: string; actual: string } {
  const expected = Buffer.from(pack.subarray(pack.length - 20)).toString('hex');
  const actual = packChecksum(pack);
  return { ok: expected === actual, expected, actual };
}

export function readPack(pack: Uint8Array, options: { resolveBase?: (oid: string) => PackObject | undefined } = {}): PackReadResult {
  const buffer = Buffer.from(pack);
  if (buffer.length < 12 + 20) throw new Error('pack too short');
  if (buffer.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack has no PACK signature');
  const version = buffer.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = buffer.readUInt32BE(8);
  const trailerStart = buffer.length - 20;
  let offset = 12;
  interface RawEntry {
    readonly offset: number;
    readonly typeCode: number;
    readonly size: number;
    readonly data: Buffer;
    readonly delta: { readonly kind: 'ofs' | 'ref'; readonly baseOffset: number; readonly baseOid: string } | null;
  }
  const raw: RawEntry[] = [];
  const byOffset = new Map<number, RawEntry>();
  for (let i = 0; i < count; i += 1) {
    const entryOffset = offset;
    const { size, next, first } = readVarintSize(buffer, offset);
    const typeCode = (first >> 4) & 0x07;
    offset = next;
    let delta: RawEntry['delta'] = null;
    if (typeCode === 6) {
      const base = readOfsDeltaBase(buffer, offset);
      offset = base.next;
      delta = { kind: 'ofs', baseOffset: entryOffset - base.baseOffset, baseOid: '' };
    } else if (typeCode === 7) {
      if (offset + 20 > trailerStart) throw new Error('ref-delta base id is truncated');
      const baseOid = buffer.subarray(offset, offset + 20).toString('hex');
      offset += 20;
      delta = { kind: 'ref', baseOffset: -1, baseOid };
    }
    const inflated = inflateAt(buffer, offset);
    offset = inflated.next;
    const entry: RawEntry = { offset: entryOffset, typeCode, size, data: inflated.data, delta };
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  const objects: PackObject[] = [];
  let deltaCount = 0;
  const resolved = new Map<number, PackObject>();
  const resolve = (entry: RawEntry, seen: Set<number>): PackObject => {
    const cached = resolved.get(entry.offset);
    if (cached !== undefined) return cached;
    if (seen.has(entry.offset)) throw new Error(`delta cycle at pack offset ${entry.offset}`);
    seen.add(entry.offset);
    let obj: PackObject;
    if (entry.delta === null) {
      const type = CODE_TYPE[entry.typeCode];
      if (type === undefined) throw new Error(`unknown pack object type ${entry.typeCode}`);
      if (entry.data.length !== entry.size) throw new Error(`pack object size mismatch: header ${entry.size}, inflated ${entry.data.length}`);
      obj = { type, data: entry.data, oid: hashObject(type, entry.data) };
    } else {
      deltaCount += 1;
      let base: PackObject | undefined;
      if (entry.delta.kind === 'ofs') {
        const baseEntry = byOffset.get(entry.delta.baseOffset);
        if (baseEntry === undefined) throw new Error(`ofs-delta at ${entry.offset} names an invalid base offset ${entry.delta.baseOffset}`);
        base = resolve(baseEntry, seen);
      } else {
        base = options.resolveBase?.(entry.delta.baseOid);
        if (base === undefined) {
          // Look for the base among the pack's own resolved objects.
          for (const cand of resolved.values()) {
            if (cand.oid === entry.delta.baseOid) {
              base = cand;
              break;
            }
          }
        }
        if (base === undefined) throw new Error(`ref-delta at ${entry.offset} names unknown base ${entry.delta.baseOid}`);
      }
      const data = applyDelta(base.data, entry.data);
      obj = { type: base.type, data, oid: hashObject(base.type, data) };
    }
    resolved.set(entry.offset, obj);
    return obj;
  };
  for (const entry of raw) objects.push(resolve(entry, new Set()));
  return { objects, deltaCount };
}

// ---------------------------------------------------------------- pack write

function writePackObjectHeader(type: GitObjectType, size: number): Buffer {
  const bytes: number[] = [];
  let first = (TYPE_CODE[type] << 4) | (size & 0x0f);
  let remaining = size >> 4;
  if (remaining > 0) first |= 0x80;
  bytes.push(first);
  while (remaining > 0) {
    let byte = remaining & 0x7f;
    remaining >>= 7;
    if (remaining > 0) byte |= 0x80;
    bytes.push(byte);
  }
  return Buffer.from(bytes);
}

export interface GitObjectInput {
  readonly type: GitObjectType;
  readonly data: Uint8Array;
}

/** A packfile of plain (non-delta) objects, with the SHA-1 trailer. */
export function writePack(objects: Iterable<GitObjectInput>): Buffer {
  const list = [...objects];
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const obj of list) {
    parts.push(writePackObjectHeader(obj.type, obj.data.length));
    // Level 1: a valid pack either way (the suite reads packs, never exact
    // deflate bytes), produced faster — this is the clone workload's hot loop.
    parts.push(deflateSync(Buffer.from(obj.data), { level: 1 }));
  }
  const withoutTrailer = Buffer.concat(parts);
  const trailer = createHash('sha1').update(withoutTrailer).digest();
  return Buffer.concat([withoutTrailer, trailer]);
}

/** The objects reachable from `tips` (commits + their trees/blobs), in commit order. */
export function collectReachable(
  tips: readonly string[],
  lookup: (oid: string) => { type: GitObjectType; data: Buffer } | undefined,
): PackObject[] {
  const out: PackObject[] = [];
  const seen = new Set<string>();
  const visitCommit = (oid: string): void => {
    if (seen.has(oid)) return;
    const obj = lookup(oid);
    if (obj === undefined || obj.type !== 'commit') return;
    seen.add(oid);
    out.push({ type: 'commit', data: obj.data, oid });
    const commit = parseCommit(obj.data);
    visitTree(commit.tree);
    for (const parent of commit.parents) visitCommit(parent);
  };
  const visitTree = (oid: string): void => {
    if (seen.has(oid)) return;
    const obj = lookup(oid);
    if (obj === undefined || obj.type !== 'tree') return;
    seen.add(oid);
    out.push({ type: 'tree', data: obj.data, oid });
    for (const entry of parseTree(obj.data)) {
      if (entry.mode === '40000') visitTree(entry.oid);
      else {
        if (seen.has(entry.oid)) continue;
        const blob = lookup(entry.oid);
        if (blob === undefined) continue;
        seen.add(entry.oid);
        out.push({ type: blob.type, data: blob.data, oid: entry.oid });
      }
    }
  };
  for (const tip of tips) visitCommit(tip);
  return out;
}
