// gitcore.ts — the git object model: SHA-1 ids, pkt-line framing, packfiles,
// commit/tree/tag parsing and building. No I/O, no clock, no randomness.

import { inflateSync, deflateSync } from 'node:zlib';
import { createHash as createCryptoHash } from 'node:crypto';

export const ZERO_OID = '0000000000000000000000000000000000000000';
const OID_RE = /^[0-9a-f]{40}$/;

export function isObjectId(value: string): boolean {
  return OID_RE.test(value);
}

/** SHA-1 of `<type> <size>\0<data>`: the git object id. */
export function hashObject(type: string, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'ascii');
  return createCryptoHash('sha1').update(header).update(data).digest('hex');
}

/** Raw SHA-1 of bytes (pack trailer). */
export function sha1Bytes(data: Buffer): string {
  return createCryptoHash('sha1').update(data).digest('hex');
}

export type ObjectType = 'blob' | 'tree' | 'commit' | 'tag';

export interface GitObject {
  type: ObjectType;
  data: Buffer;
}

// ---------------------------------------------------------------- pkt-lines

export type PktKind = 'data' | 'flush' | 'delim' | 'response-end';

export interface Pkt {
  kind: PktKind;
  payload: Buffer;
}

/** Encode one pkt-line. Payloads longer than 65516 bytes are split by the caller. */
export function encodePkt(payload: Buffer | string): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = data.length + 4;
  const head = Buffer.alloc(4);
  head.write(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, data]);
}

export function encodeFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

export function encodeDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

/** Encode several lines, then a flush. Lines may be strings or the literals 'flush'/'delim'. */
export function encodePktLines(lines: readonly (string | 'flush' | 'delim')[]): Buffer {
  const parts: Buffer[] = [];
  for (const line of lines) {
    if (line === 'flush') parts.push(encodeFlush());
    else if (line === 'delim') parts.push(encodeDelim());
    else parts.push(encodePkt(line));
  }
  return Buffer.concat(parts);
}

/** Decode a whole buffer of pkt-lines. Throws on a malformed frame. */
export function decodePktLines(buf: Buffer): Pkt[] {
  const out: Pkt[] = [];
  let off = 0;
  while (off < buf.length) {
    if (off + 4 > buf.length) throw new Error('truncated pkt-line length');
    const head = buf.subarray(off, off + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) throw new Error(`bad pkt-line length ${JSON.stringify(head)}`);
    const len = parseInt(head, 16);
    if (len === 0) {
      out.push({ kind: 'flush', payload: Buffer.alloc(0) });
      off += 4;
      continue;
    }
    if (len === 1) {
      out.push({ kind: 'delim', payload: Buffer.alloc(0) });
      off += 4;
      continue;
    }
    if (len === 2) {
      out.push({ kind: 'response-end', payload: Buffer.alloc(0) });
      off += 4;
      continue;
    }
    if (len < 4 || off + len > buf.length) throw new Error('bad pkt-line length');
    out.push({ kind: 'data', payload: Buffer.from(buf.subarray(off + 4, off + len)) });
    off += len;
  }
  return out;
}

/** Split a sideband payload into pkt-lines of at most 65520 bytes each (band byte + chunk). */
export function encodeSideband(band: number, data: Buffer): Buffer {
  const parts: Buffer[] = [];
  const CHUNK = 65515; // pkt-line max 65520 bytes: 4 (length) + 1 (band) + chunk
  for (let off = 0; off < data.length; off += CHUNK) {
    const chunk = data.subarray(off, Math.min(data.length, off + CHUNK));
    const payload = Buffer.concat([Buffer.from([band]), chunk]);
    parts.push(encodePkt(payload));
  }
  if (data.length === 0) parts.push(encodePkt(Buffer.from([band])));
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- commits

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

/** Parse a commit object's bytes. */
export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
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
  return { tree, parents, author, committer, message };
}

/** Build a commit object's bytes. Message is terminated with \n. */
export function buildCommit(info: { tree: string; parents: readonly string[]; author: string; committer: string; message: string }): Buffer {
  const msg = info.message.endsWith('\n') ? info.message : `${info.message}\n`;
  const lines = [`tree ${info.tree}`];
  for (const parent of info.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${info.author}`);
  lines.push(`committer ${info.committer}`);
  return Buffer.from(`${lines.join('\n')}\n\n${msg}`, 'utf8');
}

// ---------------------------------------------------------------- trees

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

/** Parse a tree object's bytes. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let off = 0;
  while (off < data.length) {
    const space = data.indexOf(0x20, off);
    if (space < 0) throw new Error('malformed tree: no space');
    const mode = data.subarray(off, space).toString('ascii');
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > data.length) throw new Error('malformed tree: no NUL');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    off = nul + 21;
  }
  return entries;
}

/** Git's tree sort: directory names compare as if they end in '/'. */
export function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

/** Build a tree object's bytes from entries (sorted git-style). */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => (treeSortKey(a) < treeSortKey(b) ? -1 : treeSortKey(a) > treeSortKey(b) ? 1 : 0));
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- tags

export interface TagInfo {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Buffer): TagInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let object = '';
  let type = '';
  let tag = '';
  let tagger = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4);
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}

// ---------------------------------------------------------------- packs

const PACK_TYPES: Record<number, ObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const PACK_TYPE_CODES: Record<ObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

/** Read a varint size/type header at `off`. Returns [typeCode, size, nextOff]. */
function readPackHeader(buf: Buffer, off: number): [number, number, number] {
  let byte = buf[off];
  if (byte === undefined) throw new Error('pack header truncated');
  const type = (byte >> 4) & 0x07;
  let size = byte & 0x0f;
  let shift = 4;
  let pos = off + 1;
  while ((byte & 0x80) !== 0) {
    byte = buf[pos];
    if (byte === undefined) throw new Error('pack header truncated');
    size |= (byte & 0x7f) << shift;
    shift += 7;
    pos += 1;
  }
  return [type, size, pos];
}

/** Apply a git delta to a base buffer. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let off = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[off];
      if (byte === undefined) throw new Error('delta truncated');
      off += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const baseSize = readVarint();
  if (baseSize !== base.length) throw new Error('delta base size mismatch');
  const resultSize = readVarint();
  const parts: Buffer[] = [];
  let produced = 0;
  while (off < delta.length) {
    const op = delta[off];
    if (op === undefined) break;
    off += 1;
    if ((op & 0x80) !== 0) {
      let cpOff = 0;
      let cpSize = 0;
      if (op & 0x01) { cpOff = delta[off] ?? 0; off += 1; }
      if (op & 0x02) { cpOff |= (delta[off] ?? 0) << 8; off += 1; }
      if (op & 0x04) { cpOff |= (delta[off] ?? 0) << 16; off += 1; }
      if (op & 0x08) { cpOff |= (delta[off] ?? 0) << 24; off += 1; }
      if (op & 0x10) { cpSize = delta[off] ?? 0; off += 1; }
      if (op & 0x20) { cpSize |= (delta[off] ?? 0) << 8; off += 1; }
      if (op & 0x40) { cpSize |= (delta[off] ?? 0) << 16; off += 1; }
      if (cpSize === 0) cpSize = 0x10000;
      parts.push(base.subarray(cpOff, cpOff + cpSize));
      produced += cpSize;
    } else if (op !== 0) {
      parts.push(delta.subarray(off, off + op));
      off += op;
      produced += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  if (produced !== resultSize) throw new Error('delta result size mismatch');
  return Buffer.concat(parts);
}

export interface PackReadResult {
  objects: Map<string, GitObject>;
  deltaCount: number;
}

/**
 * Parse a packfile (version 2 or 3). Verifies each object's hash. Deltas resolve
 * against earlier objects in the pack first, then `resolveBase` (the local store).
 */
export function readPack(pack: Buffer, resolveBase?: (oid: string) => GitObject | undefined): PackReadResult {
  if (pack.length < 12 || pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a packfile');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const objects = new Map<string, GitObject>();
  const byOffset = new Map<number, GitObject>();
  let deltaCount = 0;
  let off = 12;
  for (let i = 0; i < count; i += 1) {
    const start = off;
    const [typeCode, _size, afterHeader] = readPackHeader(pack, off);
    off = afterHeader;
    if (typeCode === 6 || typeCode === 7) {
      deltaCount += 1;
      let baseOid: string | null = null;
      let baseOffset = -1;
      if (typeCode === 6) {
        // OFS_DELTA: negative offset varint
        let byte = pack[off];
        if (byte === undefined) throw new Error('ofs-delta truncated');
        off += 1;
        let offset = byte & 0x7f;
        while ((byte & 0x80) !== 0) {
          byte = pack[off];
          if (byte === undefined) throw new Error('ofs-delta truncated');
          off += 1;
          offset = ((offset + 1) << 7) | (byte & 0x7f);
        }
        baseOffset = start - offset;
      } else {
        baseOid = pack.subarray(off, off + 20).toString('hex');
        off += 20;
      }
      const { data, consumed } = inflateWithLength(pack.subarray(off));
      off += consumed;
      const base = baseOffset >= 0
        ? byOffset.get(baseOffset)
        : baseOid !== null
          ? objects.get(baseOid) ?? resolveBase?.(baseOid)
          : undefined;
      if (base === undefined) throw new Error('delta base not found');
      const resolved = applyDelta(base.data, data);
      const obj: GitObject = { type: base.type, data: resolved };
      const oid = hashObject(obj.type, obj.data);
      objects.set(oid, obj);
      byOffset.set(start, obj);
    } else {
      const type = PACK_TYPES[typeCode];
      if (type === undefined) throw new Error(`unknown pack object type ${typeCode}`);
      const { data, consumed } = inflateWithLength(pack.subarray(off));
      off += consumed;
      const obj: GitObject = { type, data };
      const oid = hashObject(type, data);
      objects.set(oid, obj);
      byOffset.set(start, obj);
    }
  }
  return { objects, deltaCount };
}

/**
 * Inflate a zlib stream, reporting how many input bytes it consumed.
 * Node's inflateSync ignores trailing bytes and throws "unexpected end of file" when
 * truncated, so "inflates cleanly" is monotonic in the prefix length: binary-search the
 * smallest prefix that inflates, which is exactly the stream's end.
 */
function inflateWithLength(buf: Buffer): { data: Buffer; consumed: number } {
  let lo = 1;
  let hi = buf.length;
  // Binary search on success: inflateSync throws "unexpected end of file" when truncated
  // and succeeds (ignoring trailing bytes) once the prefix covers the whole stream.
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    try {
      inflateSync(buf.subarray(0, mid));
      found = mid;
      hi = mid - 1;
    } catch (err) {
      const msg = err instanceof Error ? err.message : '';
      if (/unexpected end|incomplete|buffer/i.test(msg)) lo = mid + 1;
      else if (/incorrect|invalid|unknown|header|distance|check/i.test(msg)) throw err;
      else lo = mid + 1;
    }
  }
  if (found < 0) throw new Error('could not inflate pack object');
  return { data: inflateSync(buf.subarray(0, found)), consumed: found };
}

/** Write a packfile (version 2, plain objects, no deltas) with a valid trailer. */
export function writePack(objects: readonly GitObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const obj of objects) {
    const typeCode = PACK_TYPE_CODES[obj.type];
    const size = obj.data.length;
    // varint type/size header
    const headerBytes: number[] = [];
    let first = (typeCode << 4) | (size & 0x0f);
    let rest = size >> 4;
    if (rest !== 0) first |= 0x80;
    headerBytes.push(first);
    while (rest !== 0) {
      let byte = rest & 0x7f;
      rest >>= 7;
      if (rest !== 0) byte |= 0x80;
      headerBytes.push(byte);
    }
    parts.push(Buffer.from(headerBytes));
    parts.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  const trailer = Buffer.from(sha1Bytes(body), 'hex');
  return Buffer.concat([body, trailer]);
}

/** Verify a packfile's trailer SHA-1. */
export function verifyPackChecksum(pack: Buffer): { ok: boolean; actual: string; expected: string } {
  if (pack.length < 20) return { ok: false, actual: '', expected: '' };
  const expected = pack.subarray(pack.length - 20).toString('hex');
  const actual = sha1Bytes(pack.subarray(0, pack.length - 20));
  return { ok: actual === expected, actual, expected };
}
