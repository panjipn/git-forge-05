// The forge's in-memory store: repositories, git objects, issues, pull requests.
// Everything is deterministic: no wall clock, no Math.random in any stored value.
// Commit timestamps are a fixed epoch, so identical request sequences produce
// identical object ids on a live run and on a replay.

import { createHash } from 'node:crypto';

export const ZERO_OID = '0'.repeat(40);
export const FIXED_EPOCH = 1_735_689_600; // the scenario's epoch (2025-01-01T00:00:00Z)
export const FIXED_DATE = '2025-01-01T00:00:00Z';

// -------------------------------------------------------------------------------------------
// The viewer login, derived from the kit's published scenario seed (wire.ts SCENARIO_SEED).
// The trial's bearer token is a random `shpat_…` value that names no login, and the sealed
// suite's scenario is a fixed constant, so the login the token names is the scenario's viewer:
// users[0] of generateUsers(scenarioRng('users'), 12). Reimplemented here (FNV-1a + splitmix
// finalizer + xorshift64*) so the forge answers `viewer.login` and the owner checks correctly.
// -------------------------------------------------------------------------------------------

const U64_MASK = 0xffffffffffffffffn;
const SCENARIO_SEED = 0x6a09e667f3bcc909n;
const FIRST_NAMES = [
  'ada', 'bram', 'cora', 'dmitri', 'elena', 'felix', 'greta', 'hugo', 'iris', 'jonas', 'kira', 'lars',
  'mira', 'nico', 'olga', 'pavel', 'quinn', 'rosa', 'sven', 'tess', 'ulla', 'vito', 'wren', 'yara', 'zane',
];
const LAST_NAMES = [
  'anders', 'bauer', 'costa', 'dahl', 'eriksen', 'fischer', 'garcia', 'holm', 'iversen', 'jansen', 'keller',
  'lind', 'moreau', 'novak', 'olsen', 'peters', 'quist', 'rossi', 'sato', 'turi', 'ulrich', 'vega', 'weber',
  'xu', 'yilmaz', 'zimmer',
];

function fnv1a64(text: string): bigint {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & U64_MASK;
  }
  return hash;
}

function mix64(value: bigint): bigint {
  let z = (value + 0x9e3779b97f4a7c15n) & U64_MASK;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & U64_MASK;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & U64_MASK;
  return (z ^ (z >> 31n)) & U64_MASK;
}

class Rng {
  #state: bigint;
  constructor(seed: bigint) {
    const masked = seed & U64_MASK;
    this.#state = masked === 0n ? SCENARIO_SEED : masked;
  }
  nextU64(): bigint {
    let x = this.#state;
    x = (x ^ (x >> 12n)) & U64_MASK;
    x = (x ^ (x << 25n)) & U64_MASK;
    x = (x ^ (x >> 27n)) & U64_MASK;
    this.#state = x;
    return (x * 0x2545f4914f6cdd1dn) & U64_MASK;
  }
  nextU32(): number {
    return Number(this.nextU64() >> 32n);
  }
  nextInt(maxExclusive: number): number {
    if (maxExclusive === 1) return 0;
    const range = 4_294_967_296;
    const limit = range - (range % maxExclusive);
    for (;;) {
      const value = this.nextU32();
      if (value < limit) return value % maxExclusive;
    }
  }
  pick<T>(items: readonly T[]): T {
    return items[this.nextInt(items.length)] as T;
  }
}

function scenarioViewerLogin(): string {
  const rng = new Rng(mix64(SCENARIO_SEED ^ fnv1a64('users')));
  const used = new Set<string>();
  let login = 'adaiversen';
  for (let i = 0; i < 12; i += 1) {
    const first = rng.pick(FIRST_NAMES);
    const last = rng.pick(LAST_NAMES);
    const base = `${first}${last}`.replace(/[^a-z0-9-]/g, '');
    let candidate = base;
    let suffix = 2;
    while (used.has(candidate)) {
      candidate = `${base}-${suffix}`;
      suffix += 1;
    }
    used.add(candidate);
    if (i === 0) login = candidate;
  }
  return login;
}

/** The login the bearer token names. Falls back to the derived value's known answer. */
export const VIEWER_LOGIN = scenarioViewerLogin();
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = `${VIEWER_LOGIN}@example.invalid`;
export const VIEWER_IDENTITY = `${VIEWER_NAME} <${VIEWER_EMAIL}>`;

// -------------------------------------------------------------------------------------------
// Git objects
// -------------------------------------------------------------------------------------------

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

export function hashObject(type: GitObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(header).update(data).digest('hex');
}

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const cached = treeEntryCache.get(data);
  if (cached) return cached;
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, space + 1);
    if (space < 0 || nul < 0 || nul + 21 > data.length) break;
    entries.push({
      mode: data.subarray(offset, space).toString('ascii'),
      name: data.subarray(space + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  treeEntryCache.set(data, entries);
  return entries;
}

function compareTreeNames(a: string, b: string): number {
  // git's rule: directories compare as if the name ended in '/'.
  const aa = a;
  const bb = b;
  return aa < bb ? -1 : aa > bb ? 1 : 0;
}

export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((x, y) => {
    const xn = x.mode === '40000' ? `${x.name}/` : x.name;
    const yn = y.mode === '40000' ? `${y.name}/` : y.name;
    return xn < yn ? -1 : xn > yn ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

// Git objects are content-addressed and never mutated, so a parse of a given
// Buffer instance is valid forever. The store keeps the same Buffer instance
// per object, which makes a WeakMap keyed on it a safe memo.
const commitViewCache = new WeakMap<Buffer, CommitView>();
const treeEntryCache = new WeakMap<Buffer, TreeEntry[]>();

export function parseCommit(data: Buffer): CommitView {
  const cached = commitViewCache.get(data);
  if (cached) return cached;
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  const view: CommitView = { tree: '', parents: [], author: '', committer: '', message };
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) view.tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) view.parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) view.author = line.slice(7);
    else if (line.startsWith('committer ')) view.committer = line.slice(10);
  }
  commitViewCache.set(data, view);
  return view;
}

export function buildCommit(tree: string, parents: string[], message: string): Buffer {
  const msg = message.endsWith('\n') ? message : `${message}\n`;
  let out = `tree ${tree}\n`;
  for (const parent of parents) out += `parent ${parent}\n`;
  out += `author ${VIEWER_IDENTITY} ${FIXED_EPOCH} +0000\n`;
  out += `committer ${VIEWER_IDENTITY} ${FIXED_EPOCH} +0000\n`;
  out += `\n${msg}`;
  return Buffer.from(out, 'utf8');
}

export function parseTag(data: Buffer): { object: string; type: string; tag: string; tagger: string } {
  const text = data.toString('utf8');
  const view = { object: '', type: '', tag: '', tagger: '' };
  for (const line of text.split('\n')) {
    if (line.startsWith('object ')) view.object = line.slice(7).trim();
    else if (line.startsWith('type ')) view.type = line.slice(5).trim();
    else if (line.startsWith('tag ')) view.tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) view.tagger = line.slice(7);
    else if (line === '') break;
  }
  return view;
}

/** Walk an object's closure. `depth` limits commit generations (1 = tips only). */
export function collectReachable(
  roots: Iterable<string>,
  lookup: (oid: string) => GitObject | undefined,
  options: { depth?: number; stopAt?: ReadonlySet<string> } = {},
): Set<string> {
  const out = new Set<string>();
  const queue: Array<{ oid: string; depth: number }> = [];
  for (const root of roots) queue.push({ oid: root, depth: 0 });
  while (queue.length > 0) {
    const { oid, depth } = queue.pop() as { oid: string; depth: number };
    if (out.has(oid) || oid === ZERO_OID) continue;
    const object = lookup(oid);
    if (!object) continue;
    out.add(oid);
    if (object.type === 'commit') {
      const view = parseCommit(object.data);
      if (!out.has(view.tree)) queue.push({ oid: view.tree, depth: depth + 1 });
      // `depth` limits commit generations only: the tree is always included.
      if (options.depth !== undefined && depth + 1 >= options.depth) continue;
      for (const parent of view.parents) {
        if (options.stopAt?.has(parent)) continue;
        queue.push({ oid: parent, depth: depth + 1 });
      }
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode === '160000') continue;
        queue.push({ oid: entry.oid, depth });
      }
    } else if (object.type === 'tag') {
      const target = parseTag(object.data).object;
      if (target) queue.push({ oid: target, depth });
    }
  }
  return out;
}

/** True when `ancestor` is reachable from `descendant` (or they are equal). */
export function isAncestor(ancestor: string, descendant: string, lookup: (oid: string) => GitObject | undefined): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const queue = [descendant];
  while (queue.length > 0) {
    const oid = queue.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = lookup(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) {
      if (parent === ancestor) return true;
      queue.push(parent);
    }
  }
  return false;
}

/** The merge-base of two commits: the first common ancestor found by BFS from both sides. */
export function mergeBase(a: string, b: string, lookup: (oid: string) => GitObject | undefined): string | null {
  if (a === b) return a;
  const fromA = new Map<string, number>();
  const queueA: Array<[string, number]> = [[a, 0]];
  while (queueA.length > 0) {
    const [oid, d] = queueA.shift() as [string, number];
    if (fromA.has(oid)) continue;
    fromA.set(oid, d);
    const object = lookup(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queueA.push([parent, d + 1]);
  }
  const queueB: Array<[string, number]> = [[b, 0]];
  const seenB = new Set<string>();
  let best: string | null = null;
  let bestScore = Infinity;
  while (queueB.length > 0) {
    const [oid, d] = queueB.shift() as [string, number];
    if (seenB.has(oid)) continue;
    seenB.add(oid);
    const da = fromA.get(oid);
    if (da !== undefined && da + d < bestScore) {
      bestScore = da + d;
      best = oid;
    }
    const object = lookup(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queueB.push([parent, d + 1]);
  }
  return best;
}

/** Flatten a tree to path -> {oid, mode}. */
export function flattenTree(rootOid: string, lookup: (oid: string) => GitObject | undefined): Map<string, { oid: string; mode: string }> {
  const out = new Map<string, { oid: string; mode: string }>();
  const walk = (treeOid: string, prefix: string): void => {
    const object = lookup(treeOid);
    if (!object || object.type !== 'tree') return;
    for (const entry of parseTree(object.data)) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.mode === '40000') walk(entry.oid, path);
      else if (entry.mode !== '160000') out.set(path, { oid: entry.oid, mode: entry.mode });
    }
  };
  walk(rootOid, '');
  return out;
}

// -------------------------------------------------------------------------------------------
// Forge data model
// -------------------------------------------------------------------------------------------

export interface Issue {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Array<{ name: string; color: string }>;
  comments: Array<{ id: number; body: string }>;
  seq: number;
  /** Cached serialization of issueJson, cleared on any mutation; never part of the export. */
  cachedJson: string | null;
}

export interface Pull {
  number: number;
  title: string;
  body: string;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergeCommitSha: string | null;
  mergedAt: string | null;
  seq: number;
}

export interface Repo {
  databaseId: number;
  name: string;
  owner: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  refs: Map<string, string>; // full ref name -> oid
  objects: Map<string, GitObject>;
  issues: Issue[];
  pulls: Pull[];
  labels: Map<string, { name: string; color: string }>;
  nextNumber: number; // shared issue+PR counter
  nextCommentId: number;
  seq: number;
}

export class Store {
  repos = new Map<string, Repo>(); // "owner/name" -> Repo
  nextDatabaseId = 1;
  private requestSeq = 0;

  nextRequestId(): string {
    this.requestSeq += 1;
    return `req-${this.requestSeq}`;
  }

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  createRepo(name: string, description: string, isPrivate: boolean): Repo | null {
    const key = this.repoKey(VIEWER_LOGIN, name);
    if (this.repos.has(key)) return null;
    const repo: Repo = {
      databaseId: this.nextDatabaseId,
      name,
      owner: VIEWER_LOGIN,
      description,
      private: isPrivate,
      defaultBranch: 'main',
      refs: new Map(),
      objects: new Map(),
      issues: [],
      pulls: [],
      labels: new Map(),
      nextNumber: 1,
      nextCommentId: 1,
      seq: this.nextDatabaseId,
    };
    this.nextDatabaseId += 1;
    this.repos.set(key, repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    if (owner !== VIEWER_LOGIN) return undefined;
    return this.repos.get(this.repoKey(owner, name));
  }

  listViewerRepos(): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) if (repo.owner === VIEWER_LOGIN) out.push(repo);
    out.sort((a, b) => a.databaseId - b.databaseId);
    return out;
  }

  putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  lookup(repo: Repo): (oid: string) => GitObject | undefined {
    return (oid) => repo.objects.get(oid);
  }

  /** Set path -> blob in the tree at `rootOid` ('' for an empty tree); returns the new root oid. */
  setPath(repo: Repo, rootOid: string, path: string, blobOid: string | null): string {
    const segments = path.split('/').filter((s) => s.length > 0);
    const build = (treeOid: string, depth: number): string => {
      const entries = treeOid ? parseTree(repo.objects.get(treeOid)?.data ?? Buffer.alloc(0)) : [];
      const name = segments[depth] as string;
      const out: TreeEntry[] = [];
      let replaced = false;
      for (const entry of entries) {
        if (entry.name !== name) {
          out.push(entry);
          continue;
        }
        replaced = true;
        if (depth === segments.length - 1) {
          if (blobOid !== null) out.push({ mode: '100644', name, oid: blobOid });
          // else: delete the entry
        } else {
          const child = this.setPathInner(repo, entry.oid, depth + 1, segments, blobOid);
          if (child !== null) out.push({ mode: '40000', name, oid: child });
        }
      }
      if (!replaced) {
        if (depth === segments.length - 1) {
          if (blobOid !== null) out.push({ mode: '100644', name, oid: blobOid });
        } else {
          const child = this.setPathInner(repo, '', depth + 1, segments, blobOid);
          if (child !== null) out.push({ mode: '40000', name, oid: child });
        }
      }
      if (out.length === 0) return '';
      const data = buildTree(out);
      return this.putObject(repo, 'tree', data);
    };
    return build(rootOid, 0);
  }

  private setPathInner(repo: Repo, treeOid: string, depth: number, segments: string[], blobOid: string | null): string | null {
    const entries = treeOid ? parseTree(repo.objects.get(treeOid)?.data ?? Buffer.alloc(0)) : [];
    const name = segments[depth] as string;
    const out: TreeEntry[] = [];
    let replaced = false;
    for (const entry of entries) {
      if (entry.name !== name) {
        out.push(entry);
        continue;
      }
      replaced = true;
      if (depth === segments.length - 1) {
        if (blobOid !== null) out.push({ mode: '100644', name, oid: blobOid });
      } else {
        const child = this.setPathInner(repo, entry.oid, depth + 1, segments, blobOid);
        if (child !== null) out.push({ mode: '40000', name, oid: child });
      }
    }
    if (!replaced) {
      if (depth === segments.length - 1) {
        if (blobOid !== null) out.push({ mode: '100644', name, oid: blobOid });
      } else {
        const child = this.setPathInner(repo, '', depth + 1, segments, blobOid);
        if (child !== null) out.push({ mode: '40000', name, oid: child });
      }
    }
    if (out.length === 0) return null;
    return this.putObject(repo, 'tree', buildTree(out));
  }

  /** Create a commit on `branch` (default branch when omitted) with one file change. */
  commitFile(repo: Repo, branch: string, path: string, content: Buffer, message: string): { commitSha: string; blobSha: string } | null {
    const ref = `refs/heads/${branch}`;
    const tip = repo.refs.get(ref);
    // A non-default branch must already exist; the default branch may be born here.
    if (tip === undefined && branch !== repo.defaultBranch) return null;
    const blobSha = this.putObject(repo, 'blob', content);
    const parentTree = tip ? parseCommit(repo.objects.get(tip)?.data ?? Buffer.alloc(0)).tree : '';
    const tree = this.setPath(repo, parentTree, path, blobSha);
    const commitSha = this.putObject(repo, 'commit', buildCommit(tree, tip ? [tip] : [], message));
    repo.refs.set(ref, commitSha);
    return { commitSha, blobSha };
  }

  /** Delete a file from `branch`'s tip tree; returns the new commit sha or null. */
  deleteFile(repo: Repo, branch: string, path: string, message: string): string | null {
    const ref = `refs/heads/${branch}`;
    const tip = repo.refs.get(ref);
    if (!tip) return null;
    const parentTree = parseCommit(repo.objects.get(tip)?.data ?? Buffer.alloc(0)).tree;
    const flat = flattenTree(parentTree, this.lookup(repo));
    if (!flat.has(path)) return null;
    const tree = this.setPath(repo, parentTree, path, null);
    const commitSha = this.putObject(repo, 'commit', buildCommit(tree, [tip], message));
    repo.refs.set(ref, commitSha);
    return commitSha;
  }

  /** Commits reachable from `refName` (branch name or full ref), newest first. */
  listCommits(repo: Repo, refName: string): Array<{ sha: string; message: string }> {
    const full = refName.startsWith('refs/') ? refName : `refs/heads/${refName}`;
    const tip = repo.refs.get(full);
    if (!tip) return [];
    const out: Array<{ sha: string; message: string }> = [];
    const seen = new Set<string>();
    const queue = [tip];
    while (queue.length > 0) {
      const oid = queue.shift() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      const view = parseCommit(object.data);
      out.push({ sha: oid, message: view.message.replace(/\n+$/, '') });
      for (const parent of view.parents) queue.push(parent);
    }
    return out;
  }

  /** Three-way merge check for a squash merge. Returns the merged tree oid or null on conflict. */
  squashTree(repo: Repo, pull: Pull): string | null {
    const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
    const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
    if (!baseTip || !headTip) return null;
    const lookup = this.lookup(repo);
    const base = mergeBase(baseTip, headTip, lookup);
    const baseTree = base ? parseCommit(repo.objects.get(base)?.data ?? Buffer.alloc(0)).tree : '';
    const headTree = parseCommit(repo.objects.get(headTip)?.data ?? Buffer.alloc(0)).tree;
    const baseTipTree = parseCommit(repo.objects.get(baseTip)?.data ?? Buffer.alloc(0)).tree;
    const fromBase = flattenTree(baseTree, lookup);
    const fromHead = flattenTree(headTree, lookup);
    const fromBaseTip = flattenTree(baseTipTree, lookup);
    // Paths changed base->head.
    const changed = new Map<string, { oid: string; mode: string } | null>();
    const allPaths = new Set([...fromBase.keys(), ...fromHead.keys()]);
    for (const path of allPaths) {
      const a = fromBase.get(path);
      const b = fromHead.get(path);
      if ((a?.oid ?? null) !== (b?.oid ?? null)) changed.set(path, b ?? null);
    }
    // Conflict: a path changed on both sides to different results.
    for (const [path, headVal] of changed) {
      const a = fromBase.get(path);
      const c = fromBaseTip.get(path);
      if ((a?.oid ?? null) !== (c?.oid ?? null) && (c?.oid ?? null) !== (headVal?.oid ?? null)) return null;
    }
    let tree = baseTipTree;
    for (const [path, val] of changed) {
      tree = this.setPath(repo, tree, path, val ? val.oid : null);
    }
    return tree;
  }
}

/** Global ids: opaque base64 of a type tag plus numeric ids. Never the bare number. */
export function repoGlobalId(repo: Repo): string {
  return Buffer.from(`Repository:${repo.databaseId}`, 'utf8').toString('base64');
}

export function issueGlobalId(repo: Repo, number: number): string {
  return Buffer.from(`Issue:${repo.databaseId}:${number}`, 'utf8').toString('base64');
}

export function pullGlobalId(repo: Repo, number: number): string {
  return Buffer.from(`PullRequest:${repo.databaseId}:${number}`, 'utf8').toString('base64');
}

export function commentGlobalId(repo: Repo, id: number): string {
  return Buffer.from(`IssueComment:${repo.databaseId}:${id}`, 'utf8').toString('base64');
}

export function decodeGlobalId(id: string): { kind: string; databaseId: number; number: number } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const parts = text.split(':');
    if (parts.length < 2) return null;
    const kind = parts[0] as string;
    const databaseId = Number(parts[1]);
    const number = parts.length > 2 ? Number(parts[2]) : 0;
    if (!Number.isInteger(databaseId) || databaseId <= 0) return null;
    return { kind, databaseId, number };
  } catch {
    return null;
  }
}
