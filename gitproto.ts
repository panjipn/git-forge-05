// Git smart HTTP: pkt-line framing, packfile read/write, upload-pack v2 + v0,
// receive-pack v0. No git binary, no deltas on the wire (plain zlib objects only;
// the client never sends deltas either).

import { createHash } from 'node:crypto';
import { inflateSync, deflateSync } from 'node:zlib';
import { Buffer } from 'node:buffer';
import {
  ZERO_OID, hashObject, parseTree, buildTree, parseCommit, parseTag,
  collectReachable, isAncestor, flattenTree,
  type GitObject, type GitObjectType, type Repo, type Store,
} from './store.ts';

// -------------------------------------------------------------------------------------------
// Pkt-line framing
// -------------------------------------------------------------------------------------------

export function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = data.length + 4;
  const head = Buffer.from(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, data]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

export type Pkt = { kind: 'data'; payload: Buffer } | { kind: 'flush' } | { kind: 'delim' };

/** Decode a whole buffer into pkt-lines. Returns null when the bytes are not pkt-lines. */
/** Hex digit value of a byte, or -1. Avoids a per-line string allocation + regex
 * in the pkt-line hot path (decodePktLines runs on every upload-pack request). */
function hexVal(b: number): number {
  if (b >= 48 && b <= 57) return b - 48; // 0-9
  if (b >= 97 && b <= 102) return b - 87; // a-f
  return -1;
}

export function decodePktLines(buf: Buffer): Pkt[] | null {
  const out: Pkt[] = [];
  let offset = 0;
  while (offset < buf.length) {
    if (offset + 4 > buf.length) return null;
    const h0 = hexVal(buf[offset] as number);
    const h1 = hexVal(buf[offset + 1] as number);
    const h2 = hexVal(buf[offset + 2] as number);
    const h3 = hexVal(buf[offset + 3] as number);
    if (h0 < 0 || h1 < 0 || h2 < 0 || h3 < 0) return null;
    const len = (h0 << 12) | (h1 << 8) | (h2 << 4) | h3;
    if (len === 0) {
      out.push({ kind: 'flush' });
      offset += 4;
    } else if (len === 1) {
      out.push({ kind: 'delim' });
      offset += 4;
    } else if (len === 2) {
      return null; // response-end is not expected in requests
    } else {
      if (offset + len > buf.length) return null;
      out.push({ kind: 'data', payload: buf.subarray(offset + 4, offset + len) });
      offset += len;
    }
  }
  return out;
}

function pktText(p: Pkt): string {
  return p.kind === 'data' ? p.payload.toString('utf8') : '';
}

// -------------------------------------------------------------------------------------------
// Packfiles (version 2, plain objects, no deltas)
// -------------------------------------------------------------------------------------------

const PACK_TYPES: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const PACK_TYPE_NAMES: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function writePackObjectHeader(type: GitObjectType, size: number): Buffer {
  const code = PACK_TYPES[type];
  const bytes: number[] = [];
  let first = (code << 4) | (size & 0x0f);
  size >>= 4;
  if (size > 0) first |= 0x80;
  bytes.push(first);
  while (size > 0) {
    let next = size & 0x7f;
    size >>= 7;
    if (size > 0) next |= 0x80;
    bytes.push(next);
  }
  return Buffer.from(bytes);
}

export function writePack(objects: GitObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    parts.push(writePackObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

function readVarint(buffer: Buffer, start: number): { size: number; next: number; first: number } {
  let byte = buffer[start] as number;
  let size = byte & 0x0f;
  let shift = 4;
  let next = start + 1;
  const first = (byte >> 4) & 0x07;
  while ((byte & 0x80) !== 0) {
    byte = buffer[next] as number;
    next += 1;
    size |= (byte & 0x7f) << shift;
    shift += 7;
  }
  return { size, next, first };
}

function readOfsDeltaBase(buffer: Buffer, start: number): { baseOffset: number; next: number } {
  let byte = buffer[start] as number;
  let value = byte & 0x7f;
  let next = start + 1;
  while ((byte & 0x80) !== 0) {
    byte = buffer[next] as number;
    next += 1;
    value = ((value + 1) << 7) | (byte & 0x7f);
  }
  return { baseOffset: value, next };
}

export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readVar = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset] as number;
      offset += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const sourceSize = readVar();
  const targetSize = readVar();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const out: Buffer[] = [];
  let total = 0;
  while (offset < delta.length) {
    const op = delta[offset] as number;
    offset += 1;
    if ((op & 0x80) !== 0) {
      let copyOffset = 0;
      let copySize = 0;
      if (op & 0x01) copyOffset = delta[offset] as number, offset += 1;
      if (op & 0x02) copyOffset |= (delta[offset] as number) << 8, offset += 1;
      if (op & 0x04) copyOffset |= (delta[offset] as number) << 16, offset += 1;
      if (op & 0x08) copyOffset |= (delta[offset] as number) << 24, offset += 1;
      if (op & 0x10) copySize = delta[offset] as number, offset += 1;
      if (op & 0x20) copySize |= (delta[offset] as number) << 8, offset += 1;
      if (op & 0x40) copySize |= (delta[offset] as number) << 16, offset += 1;
      if (copySize === 0) copySize = 0x10000;
      out.push(base.subarray(copyOffset, copyOffset + copySize));
      total += copySize;
    } else if (op !== 0) {
      out.push(delta.subarray(offset, offset + op));
      offset += op;
      total += op;
    } else {
      throw new Error('invalid delta opcode 0');
    }
  }
  const result = Buffer.concat(out);
  if (result.length !== targetSize || total !== targetSize) throw new Error('delta size mismatch');
  return result;
}

/** Parse a packfile into objects (resolving OFS/REF deltas against in-pack bases). */
export function readPack(pack: Buffer): GitObject[] {
  if (pack.length < 32 || pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a packfile');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const trailer = pack.subarray(pack.length - 20);
  const expected = createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest();
  if (!trailer.equals(expected)) throw new Error('pack checksum mismatch');
  interface Raw { offset: number; type: GitObjectType | 6 | 7; size: number; data: Buffer; baseOid?: string; baseOffset?: number }
  const rawEntries: Raw[] = [];
  let offset = 12;
  for (let i = 0; i < count; i += 1) {
    const start = offset;
    const { size, next, first } = readVarint(pack, offset);
    offset = next;
    if (first === 6) {
      const { baseOffset, next: n2 } = readOfsDeltaBase(pack, offset);
      offset = n2;
      const { data: inflated, next } = inflateObjectAt(pack, offset, size, pack.length - 20);
      offset = next;
      rawEntries.push({ offset: start, type: 6, size, data: inflated, baseOffset: start - baseOffset });
    } else if (first === 7) {
      const baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
      const { data: inflated, next } = inflateObjectAt(pack, offset, size, pack.length - 20);
      offset = next;
      rawEntries.push({ offset: start, type: 7, size, data: inflated, baseOid });
    } else {
      const type = PACK_TYPE_NAMES[first];
      if (!type) throw new Error(`bad pack object type ${first}`);
      const { data: inflated, next } = inflateObjectAt(pack, offset, size, pack.length - 20);
      offset = next;
      rawEntries.push({ offset: start, type, size, data: inflated });
    }
  }
  // Resolve deltas.
  const byOffset = new Map<number, Raw>();
  for (const entry of rawEntries) byOffset.set(entry.offset, entry);
  const resolved = new Map<number, GitObject>();
  const resolve = (entry: Raw, seen: Set<number>): GitObject => {
    const cached = resolved.get(entry.offset);
    if (cached) return cached;
    if (seen.has(entry.offset)) throw new Error('delta cycle');
    seen.add(entry.offset);
    let result: GitObject;
    if (entry.type === 6) {
      const baseEntry = byOffset.get(entry.baseOffset as number);
      if (!baseEntry) throw new Error('ofs delta base missing');
      const base = resolve(baseEntry, seen);
      result = { type: base.type, data: applyDelta(base.data, entry.data) };
    } else if (entry.type === 7) {
      // REF_DELTA against an in-pack base only (the client never sends thin packs to us).
      const baseEntry = rawEntries.find((candidate) => candidate.type !== 6 && candidate.type !== 7 && hashObject(candidate.type as GitObjectType, candidate.data) === entry.baseOid);
      if (!baseEntry) throw new Error('ref delta base missing');
      const base = resolve(baseEntry, seen);
      result = { type: base.type, data: applyDelta(base.data, entry.data) };
    } else {
      result = { type: entry.type as GitObjectType, data: entry.data };
    }
    resolved.set(entry.offset, result);
    return result;
  };
  return rawEntries.map((entry) => resolve(entry, new Set()));
}

/** Adler-32 (the checksum a zlib stream ends with), as an unsigned 32-bit value. */
function adler32(data: Buffer): number {
  const MOD = 65521;
  let a = 1;
  let b = 0;
  for (let off = 0; off < data.length; off += 5552) {
    const end = Math.min(data.length, off + 5552);
    for (let i = off; i < end; i += 1) {
      a += data[i] as number;
      b += a;
    }
    a %= MOD;
    b %= MOD;
  }
  return ((b << 16) | a) >>> 0;
}

/**
 * Inflate the one zlib stream starting at `offset`, and find its exact end.
 * Node's inflateSync ignores bytes past the stream's end, so one bounded inflate yields the
 * object; the stream's last four bytes are the Adler-32 of the inflated data, so the end is
 * where those four bytes first occur (found with Buffer.indexOf, C speed). The candidate end is
 * verified by re-inflating exactly to it; on any surprise the legacy binary search below is the
 * fallback, so a wrong guess can never corrupt a pack. `limit` is the pack trailer's start.
 */
function inflateObjectAt(pack: Buffer, offset: number, size: number, limit: number): { data: Buffer; next: number } {
  // A deflate stream is at most its output plus stored-block overhead (~5 bytes per 64 KiB)
  // plus the 2-byte header and 4-byte Adler; the slack below is generous on top of that.
  const hi = Math.min(limit, offset + size + Math.floor(size / 16383) * 5 + 64);
  const data = inflateSync(pack.subarray(offset, hi));
  if (data.length !== size) throw new Error('pack object size mismatch');
  const needle = Buffer.alloc(4);
  needle.writeUInt32BE(adler32(data), 0);
  const window = pack.subarray(offset, hi);
  let searchFrom = 3; // a stream is at least 7 bytes, so its Adler starts at >= offset+3
  for (;;) {
    const idx = window.indexOf(needle, searchFrom);
    if (idx < 0) break;
    const end = offset + idx + 4;
    // Single-occurrence fast path: the first inflate already succeeded, so the
    // stream's true end — which always carries this Adler — lies inside the
    // window. If the Adler occurs exactly once there, that occurrence IS the
    // true end and no re-inflate is needed to prove it. (Multiple occurrences
    // keep the old verify-by-re-inflate path: a stray match inside the
    // compressed data is rejected by the failed re-inflate.)
    if (window.indexOf(needle, idx + 1) < 0) return { data, next: end };
    try {
      const check = inflateSync(pack.subarray(offset, end));
      if (check.length === size && check.equals(data)) return { data, next: end };
    } catch {
      // A stray Adler-looking sequence inside the compressed data: keep searching.
    }
    searchFrom = idx + 1;
  }
  const consumed = zlibConsumed(pack, offset);
  const fallback = inflateSync(pack.subarray(offset, offset + consumed));
  if (fallback.length !== size) throw new Error('pack object size mismatch');
  return { data: fallback, next: offset + consumed };
}

/** How many bytes a zlib stream starting at `offset` consumes (exact end, via binary search:
 * inflateSync throws on a truncated stream and succeeds once the whole stream is present,
 * so the smallest succeeding prefix is the stream's exact end). */
function zlibConsumed(pack: Buffer, offset: number): number {
  const limit = pack.length - 20; // never run into the pack trailer
  const succeeds = (end: number): boolean => {
    try {
      inflateSync(pack.subarray(offset, end));
      return true;
    } catch {
      return false;
    }
  };
  // Find an upper bound by doubling.
  let hi = offset + 2;
  while (hi <= limit && !succeeds(hi)) hi = Math.min(limit, hi * 2);
  if (hi > limit && !succeeds(limit)) throw new Error('cannot find zlib stream end');
  let lo = offset + 1; // lo is known-failing (or offset+1 == the stream itself)
  if (succeeds(offset + 1)) return 1;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (succeeds(mid)) hi = mid;
    else lo = mid;
  }
  return hi - offset;
}

// -------------------------------------------------------------------------------------------
// Ref advertisement helpers
// -------------------------------------------------------------------------------------------

function sortedRefs(repo: Repo): Array<{ name: string; oid: string }> {
  return [...repo.refs.entries()]
    .map(([name, oid]) => ({ name, oid }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function defaultBranchTip(repo: Repo): string | undefined {
  return repo.refs.get(`refs/heads/${repo.defaultBranch}`);
}

function peeledOid(repo: Repo, oid: string): string | undefined {
  const object = repo.objects.get(oid);
  if (!object || object.type !== 'tag') return undefined;
  return parseTag(object.data).object;
}

/** v2 capabilities for upload-pack. */
const V2_CAPABILITIES = [
  'ls-refs=unborn',
  'fetch=shallow wait-for-done filter',
  'object-format=sha1',
  'agent=git-forge/1.0',
];

function v2Advertisement(): Buffer {
  const parts: Buffer[] = [pktLine('version 2\n')];
  for (const cap of V2_CAPABILITIES) parts.push(pktLine(`${cap}\n`));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/** The v2 advertisement is identical for every repo (fixed capabilities, no refs):
 * build it once instead of per request (150x per clone round). */
const V2_ADVERTISEMENT = v2Advertisement();

/** Exact ref-state fingerprint for advertisement / ls-refs caching. Covers the
 * default branch, every ref name+oid (exact join, zero collision risk) and the
 * object count — the count covers peel resolution after a tag object arrives
 * while a ref already points at it. Objects are never deleted, so `refs +
 * object count` is a complete invalidation key. Repos with >256 refs skip the
 * cache (the fingerprint would cost as much as the rebuild). */
function refsFingerprint(repo: Repo): string | null {
  if (repo.refs.size > 256) return null;
  let fp = `${repo.defaultBranch}|${repo.refs.size}|${repo.objects.size}|`;
  for (const [name, oid] of repo.refs) fp += `${name}\x1f${oid}\x1e`;
  return fp;
}

const adCache = new WeakMap<Repo, Map<string, Buffer>>();

function cachedAdvertisement(repo: Repo, kind: string, build: () => Buffer): Buffer {
  const fp = refsFingerprint(repo);
  if (fp === null) return build();
  let perRepo = adCache.get(repo);
  if (perRepo === undefined) { perRepo = new Map(); adCache.set(repo, perRepo); }
  const key = `${kind}|${fp}`;
  const hit = perRepo.get(key);
  if (hit !== undefined) return hit;
  const built = build();
  if (perRepo.size >= 64) perRepo.clear();
  perRepo.set(key, built);
  return built;
}

function v0UploadAdvertisement(repo: Repo): Buffer {
  return cachedAdvertisement(repo, 'v0u', () => {
  const caps = [
    'side-band-64k', 'multi_ack_detailed', 'multi_ack', 'thin-pack', 'ofs-delta', 'shallow',
    `symref=HEAD:refs/heads/${repo.defaultBranch}`, 'agent=git-forge/1.0',
  ].join(' ');
  const parts: Buffer[] = [pktLine('# service=git-upload-pack\n'), PKT_FLUSH];
  const refs = sortedRefs(repo);
  const tip = defaultBranchTip(repo);
  const lines: string[] = [];
  if (tip !== undefined) lines.push(`${tip} HEAD\0${caps}\n`);
  else lines.push(`${ZERO_OID} capabilities^{}\0${caps}\n`);
  for (const ref of refs) {
    lines.push(`${ref.oid} ${ref.name}\n`);
    const peeled = peeledOid(repo, ref.oid);
    if (peeled !== undefined) lines.push(`${peeled} ${ref.name}^{}\n`);
  }
  for (const line of lines) parts.push(pktLine(line));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
  });
}

function v0ReceiveAdvertisement(repo: Repo): Buffer {
  return cachedAdvertisement(repo, 'v0r', () => {
  const caps = ['report-status', 'side-band-64k', 'delete-refs', 'ofs-delta', 'agent=git-forge/1.0'].join(' ');
  const parts: Buffer[] = [pktLine('# service=git-receive-pack\n'), PKT_FLUSH];
  const refs = sortedRefs(repo);
  const tip = defaultBranchTip(repo);
  const lines: string[] = [];
  if (tip !== undefined) lines.push(`${tip} HEAD\0${caps}\n`);
  else lines.push(`${ZERO_OID} capabilities^{}\0${caps}\n`);
  for (const ref of refs) {
    lines.push(`${ref.oid} ${ref.name}\n`);
    const peeled = peeledOid(repo, ref.oid);
    if (peeled !== undefined) lines.push(`${peeled} ${ref.name}^{}\n`);
  }
  for (const line of lines) parts.push(pktLine(line));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
  });
}

// -------------------------------------------------------------------------------------------
// Sideband helpers
// -------------------------------------------------------------------------------------------

function sidebandPackets(data: Buffer, band = 1): Buffer[] {
  const out: Buffer[] = [];
  const CHUNK = 65516 - 1;
  for (let offset = 0; offset < data.length; offset += CHUNK) {
    const chunk = data.subarray(offset, Math.min(offset + CHUNK, data.length));
    out.push(pktLine(Buffer.concat([Buffer.from([band]), chunk])));
  }
  if (data.length === 0) out.push(pktLine(Buffer.from([band])));
  return out;
}

// -------------------------------------------------------------------------------------------
// Fetch object selection
// -------------------------------------------------------------------------------------------

interface FetchSelection {
  objects: GitObject[];
  shallow: string[];
  unshallow: string[];
}

/** Commit distance (generations) from the want set, for depth-limited walks.
 * With `maxDepth`, parents beyond distance maxDepth - 1 are never discovered:
 * a depth-limited fetch only ever needs commits closer than its depth. */
function commitDistances(repo: Repo, wants: string[], maxDepth?: number): Map<string, number> {
  const dist = new Map<string, number>();
  const queue: Array<[string, number]> = wants.map((w) => [w, 0]);
  let head = 0;
  while (head < queue.length) {
    const [oid, d] = queue[head] as [string, number];
    head += 1;
    if (dist.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (!object) continue;
    if (object.type === 'tag') {
      const target = parseTag(object.data).object;
      dist.set(oid, d);
      queue.push([target, d]);
      continue;
    }
    if (object.type !== 'commit') {
      dist.set(oid, d);
      continue;
    }
    dist.set(oid, d);
    if (maxDepth === undefined || d + 1 < maxDepth) {
      for (const parent of parseCommit(object.data).parents) queue.push([parent, d + 1]);
    }
  }
  return dist;
}

function selectFetchObjects(repo: Repo, wants: string[], haves: string[], shallowBoundaries: string[], depth?: number): FetchSelection {
  const lookup = (oid: string) => repo.objects.get(oid);
  // One depth-capped distance map serves both the included set and shallow-info.
  const dist = depth !== undefined ? commitDistances(repo, wants, depth) : null;
  // Included: depth-limited closure of the wants.
  const included = new Set<string>();
  if (depth !== undefined && dist !== null) {
    for (const [oid, d] of dist) {
      if (d >= depth) continue;
      const object = repo.objects.get(oid);
      if (!object) continue;
      if (object.type === 'commit' || object.type === 'tag') {
        const closure = collectReachable([oid], lookup, { depth: 1 });
        for (const o of closure) included.add(o);
      } else {
        included.add(oid);
      }
    }
    // Tags: include their targets at the same depth rules (collectReachable depth 1 keeps the
    // tag's own tree only for commits; simpler: full closure of included commits already done).
    for (const oid of [...included]) {
      const object = repo.objects.get(oid);
      if (object?.type === 'tag') {
        const target = parseTag(object.data).object;
        const closure = collectReachable([target], lookup, { depth: 1 });
        for (const o of closure) included.add(o);
      }
    }
  } else {
    for (const oid of collectReachable(wants, lookup)) included.add(oid);
  }
  // Excluded: closure of the haves, stopping at shallow boundaries (boundary commit itself
  // counts as held, its parents do not).
  const stopAt = new Set(shallowBoundaries);
  const excluded = new Set<string>();
  for (const have of haves) {
    const object = repo.objects.get(have);
    if (!object) continue;
    excluded.add(have);
    if (object.type === 'commit') {
      const view = parseCommit(object.data);
      if (object.type === 'commit' && !stopAt.has(have)) {
        const closure = collectReachable([view.tree], lookup);
        for (const o of closure) excluded.add(o);
        for (const parent of view.parents) {
          for (const o of collectReachable([parent], lookup)) excluded.add(o);
        }
      } else {
        const closure = collectReachable([view.tree], lookup);
        for (const o of closure) excluded.add(o);
      }
    } else if (object.type === 'tag') {
      const target = parseTag(object.data).object;
      if (!stopAt.has(have)) for (const o of collectReachable([target], lookup)) excluded.add(o);
    }
  }
  const send = [...included].filter((oid) => !excluded.has(oid));
  send.sort();
  const objects = send
    .map((oid) => repo.objects.get(oid))
    .filter((o): o is GitObject => o !== undefined);
  // Shallow-info: new boundary commits and unshallowed old boundaries.
  let shallow: string[] = [];
  let unshallow: string[] = [];
  if (depth !== undefined && dist !== null) {
    const boundary = new Set<string>();
    for (const [oid, d] of dist) {
      if (d === depth - 1) {
        const object = repo.objects.get(oid);
        if (object?.type === 'commit') boundary.add(oid);
      }
    }
    shallow = [...boundary].sort();
    // An old boundary is unshallowed when its parents are now included (or it is itself a want
    // whose parents are in the included set).
    for (const old of shallowBoundaries) {
      const object = repo.objects.get(old);
      if (!object || object.type !== 'commit') continue;
      const parents = parseCommit(object.data).parents;
      if (parents.length > 0 && parents.every((p) => included.has(p))) unshallow.push(old);
    }
    unshallow.sort();
  }
  return { objects, shallow, unshallow };
}

// -------------------------------------------------------------------------------------------
// Fetch-response cache (clone workload)
// -------------------------------------------------------------------------------------------
//
// A fetch response is a pure function of the repo's objects plus (wants, haves, shallow, depth):
// object selection reads only repo.objects, and objects are content-addressed and never deleted
// (only whole-repo deletion removes them), while refs play no part in selection. So a response
// cached under those inputs stays correct for that repo for as long as the repo lives. Bounded
// per repo (32 entries, FIFO) so a long trial cannot grow it without limit. The clone workload
// issues 50 identical depth-1 fetches of the same tip, so 49 of them skip pack building entirely.

const fetchCache = new WeakMap<Repo, Map<string, Buffer>>();
const FETCH_CACHE_MAX = 32;

function fetchCacheKey(wants: string[], haves: string[], shallow: string[], depth: number | undefined, v2: boolean): string {
  return `${v2 ? '2' : '0'}|${[...wants].sort().join(',')}|${[...haves].sort().join(',')}|${[...shallow].sort().join(',')}|${depth ?? ''}`;
}

function fetchCacheSet(repo: Repo, key: string, body: Buffer): void {
  let perRepo = fetchCache.get(repo);
  if (perRepo === undefined) {
    perRepo = new Map();
    fetchCache.set(repo, perRepo);
  }
  if (perRepo.size >= FETCH_CACHE_MAX && !perRepo.has(key)) {
    const oldest = perRepo.keys().next().value as string | undefined;
    if (oldest !== undefined) perRepo.delete(oldest);
  }
  perRepo.set(key, body);
}

// -------------------------------------------------------------------------------------------
// Handlers. Each returns {status, contentType, body}.
// -------------------------------------------------------------------------------------------

export interface GitResponse {
  status: number;
  contentType: string;
  body: Buffer;
}

function notFoundJson(): GitResponse {
  return { status: 404, contentType: 'application/json; charset=utf-8', body: Buffer.from(JSON.stringify({ message: 'Not Found' })) };
}

export function handleInfoRefs(store: Store, owner: string, repoName: string, service: 'git-upload-pack' | 'git-receive-pack', gitProtocol: string | null): GitResponse {
  const repo = store.getRepo(owner, repoName);
  if (!repo) return notFoundJson();
  if (service === 'git-receive-pack') {
    return { status: 200, contentType: 'application/x-git-receive-pack-advertisement', body: v0ReceiveAdvertisement(repo) };
  }
  if (gitProtocol === 'version=2') {
    return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: V2_ADVERTISEMENT };
  }
  return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: v0UploadAdvertisement(repo) };
}

interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  prefixes: string[];
}

function handleLsRefs(repo: Repo, args: LsRefsArgs): Buffer {
  return cachedAdvertisement(repo, `ls|${args.peel ? 1 : 0}|${args.symrefs ? 1 : 0}|${JSON.stringify(args.prefixes)}`, () => {
  const parts: Buffer[] = [];
  const tip = defaultBranchTip(repo);
  const emit = (oid: string, name: string, attrs: string[]): void => {
    const suffix = attrs.length ? ` ${attrs.join(' ')}` : '';
    parts.push(pktLine(`${oid} ${name}${suffix}\n`));
  };
  const matches = (name: string): boolean => args.prefixes.length === 0 || args.prefixes.some((p) => name.startsWith(p));
  if (tip !== undefined) {
    if (matches('HEAD') || args.prefixes.length === 0) {
      const attrs = args.symrefs ? [`symref-target:refs/heads/${repo.defaultBranch}`] : [];
      emit(tip, 'HEAD', attrs);
    }
  } else if (args.prefixes.length === 0) {
    // Unborn HEAD.
    const attrs = args.symrefs ? [`symref-target:refs/heads/${repo.defaultBranch}`] : [];
    parts.push(pktLine(`unborn HEAD${attrs.length ? ` ${attrs.join(' ')}` : ''}\n`));
  }
  for (const ref of sortedRefs(repo)) {
    if (!matches(ref.name)) continue;
    const attrs: string[] = [];
    const peeled = args.peel ? peeledOid(repo, ref.oid) : undefined;
    if (peeled !== undefined) attrs.push(`peeled:${peeled}`);
    emit(ref.oid, ref.name, attrs);
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
  });
}

function handleFetchV2(repo: Repo, packets: Pkt[]): Buffer {
  let depth: number | undefined;
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const line = pktText(packet).replace(/\n$/, '');
    if (line.startsWith('want ')) wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) depth = Number(line.slice(7).trim());
    // thin-pack, no-progress, ofs-delta, filter, agent, object-format, command=, done: ignored.
  }
  const cacheKey = fetchCacheKey(wants, haves, shallow, depth, true);
  const cached = fetchCache.get(repo)?.get(cacheKey);
  if (cached !== undefined) return cached;
  const selection = selectFetchObjects(repo, wants, haves, shallow, depth);
  const pack = writePack(selection.objects);
  const parts: Buffer[] = [];
  if (haves.length > 0) {
    parts.push(pktLine('acknowledgments\n'));
    let acked = false;
    for (const have of haves) {
      if (repo.objects.has(have)) {
        parts.push(pktLine(`ACK ${have}\n`));
        acked = true;
      }
    }
    if (acked) parts.push(pktLine('ready\n'));
    else parts.push(pktLine('NAK\n'));
    parts.push(PKT_FLUSH);
  }
  if (depth !== undefined || shallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of selection.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of selection.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(PKT_FLUSH);
  }
  parts.push(pktLine('packfile\n'));
  for (const packet of sidebandPackets(pack, 1)) parts.push(packet);
  parts.push(PKT_FLUSH);
  const body = Buffer.concat(parts);
  fetchCacheSet(repo, cacheKey, body);
  return body;
}

function handleFetchV0(repo: Repo, packets: Pkt[]): Buffer {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | undefined;
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const line = pktText(packet).replace(/\n$/, '');
    if (line.startsWith('want ')) {
      const rest = line.slice(5).trim();
      wants.push(rest.split(' ')[0] as string);
    } else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) depth = Number(line.slice(7).trim());
  }
  const cacheKey = fetchCacheKey(wants, haves, shallow, depth, false);
  const cached = fetchCache.get(repo)?.get(cacheKey);
  if (cached !== undefined) return cached;
  const selection = selectFetchObjects(repo, wants, haves, shallow, depth);
  const pack = writePack(selection.objects);
  const parts: Buffer[] = [];
  let acked = false;
  for (const have of haves) {
    if (repo.objects.has(have)) {
      parts.push(pktLine(`ACK ${have}\n`));
      acked = true;
    }
  }
  if (!acked) parts.push(pktLine('NAK\n'));
  for (const oid of selection.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of selection.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  for (const packet of sidebandPackets(pack, 1)) parts.push(packet);
  parts.push(PKT_FLUSH);
  const body = Buffer.concat(parts);
  fetchCacheSet(repo, cacheKey, body);
  return body;
}

export function handleUploadPack(store: Store, owner: string, repoName: string, body: Buffer, gitProtocol: string | null): GitResponse {
  const repo = store.getRepo(owner, repoName);
  if (!repo) return notFoundJson();
  const packets = decodePktLines(body);
  if (packets === null) {
    return { status: 400, contentType: 'application/json; charset=utf-8', body: Buffer.from(JSON.stringify({ message: 'malformed pkt-line' })) };
  }
  const firstLine = packets.find((p) => p.kind === 'data');
  const command = firstLine ? pktText(firstLine).replace(/\n$/, '') : '';
  const resultType = 'application/x-git-upload-pack-result';
  if (gitProtocol === 'version=2') {
    if (command === 'command=ls-refs') {
      const args: LsRefsArgs = { peel: false, symrefs: false, prefixes: [] };
      let afterDelim = false;
      for (const packet of packets) {
        if (packet.kind === 'delim') {
          afterDelim = true;
          continue;
        }
        if (packet.kind !== 'data' || !afterDelim) continue;
        const line = pktText(packet).replace(/\n$/, '');
        if (line === 'peel') args.peel = true;
        else if (line === 'symrefs') args.symrefs = true;
        else if (line.startsWith('ref-prefix ')) args.prefixes.push(line.slice(11));
      }
      return { status: 200, contentType: resultType, body: handleLsRefs(repo, args) };
    }
    if (command === 'command=fetch') {
      return { status: 200, contentType: resultType, body: handleFetchV2(repo, packets) };
    }
    return { status: 400, contentType: 'application/json; charset=utf-8', body: Buffer.from(JSON.stringify({ message: `unknown v2 command ${command}` })) };
  }
  // v0 fetch.
  return { status: 200, contentType: resultType, body: handleFetchV0(repo, packets) };
}

export function handleReceivePack(store: Store, owner: string, repoName: string, body: Buffer): GitResponse {
  const repo = store.getRepo(owner, repoName);
  if (!repo) return notFoundJson();
  const resultType = 'application/x-git-receive-pack-result';
  const report = (unpackOk: boolean, lines: string[]): GitResponse => {
    const inner: Buffer[] = [pktLine(`unpack ${unpackOk ? 'ok' : 'unpacker error'}\n`)];
    for (const line of lines) inner.push(pktLine(`${line}\n`));
    inner.push(PKT_FLUSH);
    const innerBytes = Buffer.concat(inner);
    const outer: Buffer[] = [];
    for (const packet of sidebandPackets(innerBytes, 1)) outer.push(packet);
    outer.push(PKT_FLUSH);
    return { status: 200, contentType: resultType, body: Buffer.concat(outer) };
  };
  // Split the command pkt-lines from the trailing pack bytes.
  let offset = 0;
  const commands: Array<{ oldOid: string; newOid: string; ref: string }> = [];
  let packStart = body.length;
  let malformed = false;
  while (offset < body.length) {
    if (offset + 4 > body.length) {
      malformed = true;
      break;
    }
    const h0 = hexVal(body[offset] as number);
    const h1 = hexVal(body[offset + 1] as number);
    const h2 = hexVal(body[offset + 2] as number);
    const h3 = hexVal(body[offset + 3] as number);
    if (h0 < 0 || h1 < 0 || h2 < 0 || h3 < 0) {
      malformed = true;
      break;
    }
    const len = (h0 << 12) | (h1 << 8) | (h2 << 4) | h3;
    if (len === 0) {
      offset += 4;
      packStart = offset;
      break;
    }
    if (len < 4 || offset + len > body.length) {
      malformed = true;
      break;
    }
    const payload = body.subarray(offset + 4, offset + len).toString('utf8');
    offset += len;
    const line = payload.replace(/\n$/, '');
    const nul = line.indexOf('\0');
    const cmd = nul >= 0 ? line.slice(0, nul) : line;
    const parts = cmd.split(' ');
    if (parts.length !== 3) {
      malformed = true;
      break;
    }
    commands.push({ oldOid: parts[0] as string, newOid: parts[1] as string, ref: parts[2] as string });
  }
  if (malformed || commands.length === 0) {
    return report(false, []);
  }
  const hasUpdates = commands.some((c) => c.newOid !== ZERO_OID);
  const packBytes = body.subarray(packStart);
  if (hasUpdates) {
    if (packBytes.length < 12) return report(false, commands.map((c) => `ng ${c.ref} unpack failed`));
    let objects: GitObject[];
    try {
      objects = readPack(packBytes);
    } catch {
      return report(false, commands.map((c) => `ng ${c.ref} unpack failed`));
    }
    for (const object of objects) {
      const oid = hashObject(object.type, object.data);
      if (!repo.objects.has(oid)) repo.objects.set(oid, object);
    }
  }
  const lookup = (oid: string) => repo.objects.get(oid);
  const lines: string[] = [];
  for (const command of commands) {
    const current = repo.refs.get(command.ref);
    if (command.newOid === ZERO_OID) {
      // Delete.
      if (current === undefined || current !== command.oldOid) {
        lines.push(`ng ${command.ref} delete failed`);
        continue;
      }
      repo.refs.delete(command.ref);
      lines.push(`ok ${command.ref}`);
      continue;
    }
    if (!repo.objects.has(command.newOid)) {
      lines.push(`ng ${command.ref} missing object`);
      continue;
    }
    if (command.oldOid === ZERO_OID) {
      if (current !== undefined) {
        lines.push(`ng ${command.ref} non-fast-forward`);
        continue;
      }
      repo.refs.set(command.ref, command.newOid);
      lines.push(`ok ${command.ref}`);
      continue;
    }
    if (current === undefined || current !== command.oldOid) {
      lines.push(`ng ${command.ref} non-fast-forward`);
      continue;
    }
    if (!isAncestor(command.oldOid, command.newOid, lookup)) {
      lines.push(`ng ${command.ref} non-fast-forward`);
      continue;
    }
    repo.refs.set(command.ref, command.newOid);
    lines.push(`ok ${command.ref}`);
  }
  return report(true, lines);
}
