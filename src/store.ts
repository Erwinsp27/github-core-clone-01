// store.ts — the forge's in-memory state: repositories, issues, pull requests,
// and the git graph algorithms (ancestry, merge-base, fetch planning, squash merge).
// Deterministic: timestamps come from MAKEFUN_TRIAL_NOW or a fixed instant; no
// wall clock, no randomness anywhere in this module.

import {
  ZERO_OID,
  hashObject,
  parseCommit,
  parseTree,
  parseTag,
  buildTree,
  buildCommit,
  isObjectId,
  type GitObject,
} from './gitcore.ts';

export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const FORGE_VERSION = '1.0.0';

const FIXED_ISO = '2025-01-01T00:00:00Z';
const FIXED_EPOCH = 1735689600;

/** The trial's fixed now: MAKEFUN_TRIAL_NOW (RFC 3339 or epoch ms) or the fixed instant. */
export function trialNow(): { iso: string; epoch: number } {
  const raw = (process.env.MAKEFUN_TRIAL_NOW ?? '').trim();
  if (raw !== '') {
    const asNumber = Number(raw);
    if (Number.isFinite(asNumber) && asNumber > 0) {
      const date = new Date(asNumber);
      if (!Number.isNaN(date.getTime())) return { iso: date.toISOString().replace(/\.\d{3}Z$/, 'Z'), epoch: Math.floor(asNumber / 1000) };
    } else {
      const date = new Date(raw);
      if (!Number.isNaN(date.getTime())) return { iso: date.toISOString().replace(/\.\d{3}Z$/, 'Z'), epoch: Math.floor(date.getTime() / 1000) };
    }
  }
  return { iso: FIXED_ISO, epoch: FIXED_EPOCH };
}

export function nowIso(): string {
  return trialNow().iso;
}

export function commitIdentity(): string {
  return `forge <forge@make.fun> ${trialNow().epoch} +0000`;
}

// ---------------------------------------------------------------- global ids

function b64url(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}

function unb64url(text: string): string {
  return Buffer.from(text, 'base64url').toString('utf8');
}

export function repoGlobalId(owner: string, name: string): string {
  return `R_${b64url(`${owner}/${name}`)}`;
}

export function issueGlobalId(owner: string, name: string, number: number): string {
  return `I_${b64url(`${owner}/${name}#${number}`)}`;
}

export function pullGlobalId(owner: string, name: string, number: number): string {
  return `P_${b64url(`${owner}/${name}!${number}`)}`;
}

export function commentGlobalId(owner: string, name: string, issueNumber: number, commentId: number): string {
  return `C_${b64url(`${owner}/${name}#${issueNumber}:${commentId}`)}`;
}

export type GlobalIdKind = 'repo' | 'issue' | 'pull' | 'comment';

/** Decode an opaque global id into its kind and coordinates, or null. */
export function decodeGlobalId(id: string): { kind: GlobalIdKind; owner: string; repo: string; number: number; commentId: number } | null {
  const prefix = id.slice(0, 2);
  const kind: GlobalIdKind | null = prefix === 'R_' ? 'repo' : prefix === 'I_' ? 'issue' : prefix === 'P_' ? 'pull' : prefix === 'C_' ? 'comment' : null;
  if (kind === null) return null;
  let text: string;
  try {
    text = unb64url(id.slice(2));
  } catch {
    return null;
  }
  const slash = text.indexOf('/');
  if (slash < 0) return null;
  const owner = text.slice(0, slash);
  const rest = text.slice(slash + 1);
  if (kind === 'repo') return { kind, owner, repo: rest, number: 0, commentId: 0 };
  if (kind === 'issue') {
    const hash = rest.indexOf('#');
    if (hash < 0) return null;
    return { kind, owner, repo: rest.slice(0, hash), number: Number(rest.slice(hash + 1)) || 0, commentId: 0 };
  }
  if (kind === 'pull') {
    const bang = rest.indexOf('!');
    if (bang < 0) return null;
    return { kind, owner, repo: rest.slice(0, bang), number: Number(rest.slice(bang + 1)) || 0, commentId: 0 };
  }
  const hash = rest.indexOf('#');
  const colon = rest.indexOf(':');
  if (hash < 0 || colon < 0) return null;
  return { kind, owner, repo: rest.slice(0, hash), number: Number(rest.slice(hash + 1, colon)) || 0, commentId: Number(rest.slice(colon + 1)) || 0 };
}

// ---------------------------------------------------------------- entities

export interface Label {
  name: string;
  color: string;
}

export interface Comment {
  id: number;
  globalId: string;
  body: string;
  createdAt: string;
}

export interface Issue {
  globalId: string;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  comments: Comment[];
  createdAt: string;
  updatedAt: string;
  seq: number;
}

export interface PullRequest {
  globalId: string;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  createdAt: string;
  updatedAt: string;
  seq: number;
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  seq: number;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  labels: Map<string, Label>;
  issues: Issue[];
  pulls: PullRequest[];
  nextIssue: number;
  nextPull: number;
  nextComment: number;
}

export const EMPTY_TREE_OID = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

export class Store {
  repos = new Map<string, Repo>();
  private nextRepoId = 5000;
  private nextSeq = 1;

  key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  viewerRepos(): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) if (repo.owner === VIEWER_LOGIN) out.push(repo);
    out.sort((a, b) => a.seq - b.seq);
    return out;
  }

  createRepo(owner: string, name: string, description: string, isPrivate: boolean): Repo {
    const now = nowIso();
    const repo: Repo = {
      id: this.nextRepoId,
      name,
      owner,
      description,
      private: isPrivate,
      defaultBranch: 'main',
      createdAt: now,
      updatedAt: now,
      seq: this.nextSeq,
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: [],
      pulls: [],
      nextIssue: 1,
      nextPull: 1,
      nextComment: 1,
    };
    this.nextRepoId += 1;
    this.nextSeq += 1;
    // The empty tree, so an empty repo still has a valid tree object to reference.
    repo.objects.set(EMPTY_TREE_OID, { type: 'tree', data: Buffer.alloc(0) });
    this.repos.set(this.key(owner, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.key(owner, name));
  }
}

// ---------------------------------------------------------------- git graph

/** Peel a tag chain to its commit, or return the oid itself when it is a commit. */
export function peelToCommit(repo: Repo, oid: string): string | null {
  let current = oid;
  for (let hops = 0; hops < 16; hops += 1) {
    const obj = repo.objects.get(current);
    if (obj === undefined) return null;
    if (obj.type === 'commit') return current;
    if (obj.type === 'tag') {
      current = parseTag(obj.data).object;
      continue;
    }
    return null;
  }
  return null;
}

/** All ancestors of `tip` (including `tip`), in BFS order. */
export function ancestorsOf(repo: Repo, tip: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const queue = [tip];
  while (queue.length > 0) {
    const oid = queue.shift() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    out.push(oid);
    for (const parent of parseCommit(obj.data).parents) queue.push(parent);
  }
  return out;
}

export function isAncestor(repo: Repo, ancestor: string, tip: string): boolean {
  if (ancestor === tip) return true;
  const seen = new Set<string>([tip]);
  const queue = [tip];
  while (queue.length > 0) {
    const oid = queue.shift() as string;
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) {
      if (parent === ancestor) return true;
      if (!seen.has(parent)) {
        seen.add(parent);
        queue.push(parent);
      }
    }
  }
  return false;
}

/** First common ancestor of a and b (BFS from b over a's ancestor set). */
export function mergeBase(repo: Repo, a: string, b: string): string | null {
  const setA = new Set(ancestorsOf(repo, a));
  const queue = [b];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const oid = queue.shift() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (setA.has(oid)) return oid;
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) queue.push(parent);
  }
  return null;
}

/** Flatten a tree into path -> {oid, mode}. */
export function flattenTree(repo: Repo, treeOid: string, prefix = ''): Map<string, { oid: string; mode: string }> {
  const out = new Map<string, { oid: string; mode: string }>();
  const walk = (oid: string, path: string): void => {
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'tree') return;
    for (const entry of parseTree(obj.data)) {
      const full = path === '' ? entry.name : `${path}/${entry.name}`;
      if (entry.mode === '40000') walk(entry.oid, full);
      else out.set(full, { oid: entry.oid, mode: entry.mode });
    }
  };
  walk(treeOid, prefix);
  return out;
}

/** The commit itself plus its tree (recursive) and blobs — parents NOT followed. */
export function collectCommitAndTree(repo: Repo, commitOid: string, out: Set<string>): void {
  const obj = repo.objects.get(commitOid);
  if (obj === undefined || obj.type !== 'commit') return;
  out.add(commitOid);
  const treeOid = parseCommit(obj.data).tree;
  const stack = [treeOid];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (out.has(oid)) continue;
    const tobj = repo.objects.get(oid);
    if (tobj === undefined) continue;
    out.add(oid);
    if (tobj.type === 'tree') for (const entry of parseTree(tobj.data)) stack.push(entry.oid);
  }
}

/** All objects reachable from a commit (commit + trees + blobs), by oid. */
export function reachableObjects(repo: Repo, commitOid: string, out: Set<string>): void {
  const stack: string[] = [commitOid];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (out.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (obj === undefined) continue;
    out.add(oid);
    if (obj.type === 'commit') {
      const info = parseCommit(obj.data);
      stack.push(info.tree);
      for (const parent of info.parents) stack.push(parent);
    } else if (obj.type === 'tree') {
      for (const entry of parseTree(obj.data)) stack.push(entry.oid);
    } else if (obj.type === 'tag') {
      stack.push(parseTag(obj.data).object);
    }
  }
}

/** Store an object, returning its oid. */
export function putObject(repo: Repo, type: GitObject['type'], data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

/** Create a commit object and store it. */
export function createCommit(repo: Repo, tree: string, parents: readonly string[], message: string): string {
  const data = buildCommit({ tree, parents, author: commitIdentity(), committer: commitIdentity(), message });
  return putObject(repo, 'commit', data);
}

/**
 * Set (or delete, when blobOid is null) one path in a tree, returning the new tree oid.
 * Intermediate directories are created as needed; empty directories are pruned.
 */
export function setPathInTree(repo: Repo, baseTreeOid: string | null, parts: readonly string[], blobOid: string | null): string {
  if (parts.length === 0) return baseTreeOid ?? EMPTY_TREE_OID;
  const obj = baseTreeOid === null ? undefined : repo.objects.get(baseTreeOid);
  const entries = obj !== undefined && obj.type === 'tree' ? parseTree(obj.data) : [];
  const [head, ...rest] = parts as [string, ...string[]];
  const idx = entries.findIndex((entry) => entry.name === head);
  if (rest.length === 0) {
    // Leaf.
    if (blobOid === null) {
      if (idx >= 0) entries.splice(idx, 1);
    } else if (idx >= 0) {
      entries[idx] = { mode: '100644', name: head, oid: blobOid };
    } else {
      entries.push({ mode: '100644', name: head, oid: blobOid });
    }
  } else {
    const childOid = idx >= 0 && entries[idx]?.mode === '40000' ? (entries[idx] as { oid: string }).oid : null;
    const newChild = setPathInTree(repo, childOid, rest, blobOid);
    const childObj = repo.objects.get(newChild);
    const childEmpty = newChild === EMPTY_TREE_OID || (childObj !== undefined && childObj.type === 'tree' && childObj.data.length === 0);
    if (childEmpty && blobOid === null) {
      if (idx >= 0) entries.splice(idx, 1);
    } else if (idx >= 0) {
      entries[idx] = { mode: '40000', name: head, oid: newChild };
    } else {
      entries.push({ mode: '40000', name: head, oid: newChild });
    }
  }
  if (entries.length === 0) return EMPTY_TREE_OID;
  return putObject(repo, 'tree', buildTree(entries));
}

/** Count lines in a blob's text (a trailing newline does not add a line). */
export function lineCount(data: Buffer): number {
  const text = data.toString('utf8');
  if (text === '') return 0;
  const lines = text.split('\n');
  return lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
}

/** Line-level added/deleted counts between two blobs (multiset difference). */
export function lineDiff(oldData: Buffer, newData: Buffer): { additions: number; deletions: number } {
  const count = (data: Buffer): Map<string, number> => {
    const map = new Map<string, number>();
    const text = data.toString('utf8');
    if (text === '') return map;
    const lines = text.split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    for (const line of lines) map.set(line, (map.get(line) ?? 0) + 1);
    return map;
  };
  const oldLines = count(oldData);
  const newLines = count(newData);
  let additions = 0;
  let deletions = 0;
  for (const [line, n] of newLines) additions += Math.max(0, n - (oldLines.get(line) ?? 0));
  for (const [line, n] of oldLines) deletions += Math.max(0, n - (newLines.get(line) ?? 0));
  return { additions, deletions };
}

export interface FileChange {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
}

/** Diff two commit tips (by tree) into per-file changes. */
export function diffTrees(repo: Repo, baseTip: string, headTip: string): FileChange[] {
  const baseObj = repo.objects.get(baseTip);
  const headObj = repo.objects.get(headTip);
  if (baseObj === undefined || headObj === undefined || baseObj.type !== 'commit' || headObj.type !== 'commit') return [];
  const baseFlat = flattenTree(repo, parseCommit(baseObj.data).tree);
  const headFlat = flattenTree(repo, parseCommit(headObj.data).tree);
  const paths = new Set([...baseFlat.keys(), ...headFlat.keys()]);
  const out: FileChange[] = [];
  for (const path of [...paths].sort()) {
    const base = baseFlat.get(path);
    const head = headFlat.get(path);
    if (base !== undefined && head === undefined) {
      const blob = repo.objects.get(base.oid);
      const deletions = blob !== undefined ? lineCount(blob.data) : 0;
      out.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions });
    } else if (base === undefined && head !== undefined) {
      const blob = repo.objects.get(head.oid);
      const additions = blob !== undefined ? lineCount(blob.data) : 0;
      out.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions });
    } else if (base !== undefined && head !== undefined && base.oid !== head.oid) {
      const oldBlob = repo.objects.get(base.oid);
      const newBlob = repo.objects.get(head.oid);
      const { additions, deletions } = lineDiff(oldBlob?.data ?? Buffer.alloc(0), newBlob?.data ?? Buffer.alloc(0));
      out.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
    }
  }
  return out;
}

/**
 * Three-way merge conflict test: for every path the head changed relative to the merge
 * base, the base tip must not have changed it differently.
 */
export function hasMergeConflict(repo: Repo, baseTip: string, headTip: string, mergeBaseOid: string | null): boolean {
  if (mergeBaseOid === null) return false;
  const baseObj = repo.objects.get(mergeBaseOid);
  const headObj = repo.objects.get(headTip);
  const tipObj = repo.objects.get(baseTip);
  if (baseObj === undefined || headObj === undefined || tipObj === undefined) return false;
  if (baseObj.type !== 'commit' || headObj.type !== 'commit' || tipObj.type !== 'commit') return false;
  const baseFlat = flattenTree(repo, parseCommit(baseObj.data).tree);
  const headFlat = flattenTree(repo, parseCommit(headObj.data).tree);
  const tipFlat = flattenTree(repo, parseCommit(tipObj.data).tree);
  const paths = new Set([...baseFlat.keys(), ...headFlat.keys()]);
  for (const path of paths) {
    const baseVal = baseFlat.get(path)?.oid ?? null;
    const headVal = headFlat.get(path)?.oid ?? null;
    if (headVal === baseVal) continue;
    const tipVal = tipFlat.get(path)?.oid ?? null;
    if (tipVal !== baseVal && tipVal !== headVal) return true;
  }
  return false;
}

// ---------------------------------------------------------------- fetch planning

export interface FetchPlan {
  /** Objects to send, in send order (commits, trees, blobs). */
  objects: GitObject[];
  /** New shallow boundaries (commits whose parents were cut off). */
  shallow: string[];
  /** Old boundaries that are no longer shallow. */
  unshallow: string[];
  /** Haves that are ancestors of a want. */
  acks: string[];
  nak: boolean;
}

export function planFetch(
  repo: Repo,
  wants: readonly string[],
  haves: readonly string[],
  shallowBoundaries: readonly string[],
  depth: number | null,
): FetchPlan {
  const haveSet = new Set(haves);
  const shallowSet = new Set(shallowBoundaries);
  // Resolve wants to commits (peel tags); remember tag objects to send as well.
  const tagObjects = new Set<string>();
  const wantCommits: string[] = [];
  for (const want of wants) {
    const obj = repo.objects.get(want);
    if (obj === undefined) throw new Error(`want ${want} not found`);
    if (obj.type === 'tag') {
      tagObjects.add(want);
      const peeled = peelToCommit(repo, want);
      if (peeled !== null) wantCommits.push(peeled);
    } else if (obj.type === 'commit') {
      wantCommits.push(want);
    }
  }
  // Full ancestry of the wants (for ACKs): no depth limit, no stops. Skipped when
  // there are no haves — a fresh clone's ancestry walk over a long history is pure cost.
  const fullAncestors = new Set<string>();
  if (haves.length > 0) {
    for (const tip of wantCommits) {
      for (const anc of ancestorsOf(repo, tip)) fullAncestors.add(anc);
    }
  }
  const acks = haves.filter((have) => fullAncestors.has(have));
  // Walk with generation numbers. A commit the client already holds (a have or a
  // shallow boundary) is never re-sent, but with a depth it does not stop the walk
  // either: deepen extends BEYOND the boundary it starts from, so the boundary's
  // parents are exactly what the fetch must deliver. Without a depth, a held commit
  // is a wall: everything below it is already held.
  const gen = new Map<string, number>();
  const queue: Array<{ oid: string; g: number }> = wantCommits.map((oid) => ({ oid, g: 0 }));
  const sent = new Set<string>();
  const visited = new Set<string>();
  while (queue.length > 0) {
    const { oid, g } = queue.shift() as { oid: string; g: number };
    if (visited.has(oid)) continue;
    visited.add(oid);
    const held = haveSet.has(oid) || shallowSet.has(oid);
    if (!held && (depth === null || g < depth)) {
      sent.add(oid);
      gen.set(oid, g);
    }
    const expand = depth !== null ? g + 1 < depth : !held;
    if (!expand) continue;
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) {
      if (!visited.has(parent)) queue.push({ oid: parent, g: g + 1 });
    }
  }
  // New shallow boundaries: sent commits at the depth cutoff that still have parents.
  const shallow: string[] = [];
  if (depth !== null) {
    for (const oid of sent) {
      if ((gen.get(oid) ?? 0) !== depth - 1) continue;
      const obj = repo.objects.get(oid);
      if (obj !== undefined && obj.type === 'commit' && parseCommit(obj.data).parents.length > 0) shallow.push(oid);
    }
  }
  // No longer shallow: an old boundary whose parents are all known after this fetch
  // (sent now, or already held).
  const unshallow = shallowBoundaries.filter((boundary) => {
    const obj = repo.objects.get(boundary);
    if (obj === undefined || obj.type !== 'commit') return false;
    const parents = parseCommit(obj.data).parents;
    return parents.length === 0 || parents.every((parent) => sent.has(parent) || haveSet.has(parent));
  });
  // Objects to send: the sent commits themselves plus their trees and blobs — never
  // their parents (a depth-1 fetch sends the tip commit only). Everything the client
  // already holds (haves + old shallow boundaries, with their full ancestry) is
  // subtracted, so an incremental fetch sends only new objects.
  const wanted = new Set<string>();
  for (const oid of sent) collectCommitAndTree(repo, oid, wanted);
  for (const tag of tagObjects) {
    wanted.add(tag);
    const peeled = peelToCommit(repo, tag);
    if (peeled !== null) collectCommitAndTree(repo, peeled, wanted);
  }
  const held = new Set<string>();
  if (depth === null) {
    // A complete clone holds the haves and their whole ancestry.
    for (const oid of [...haves, ...shallowBoundaries]) {
      const peeled = peelToCommit(repo, oid);
      if (peeled !== null) reachableObjects(repo, peeled, held);
      else if (repo.objects.has(oid)) held.add(oid);
    }
  } else {
    // A shallow clone holds a boundary commit and its own tree, but NOT its
    // ancestors — those ancestors are exactly what a deepen must deliver.
    for (const oid of [...haves, ...shallowBoundaries]) {
      const peeled = peelToCommit(repo, oid);
      if (peeled !== null) collectCommitAndTree(repo, peeled, held);
      else if (repo.objects.has(oid)) held.add(oid);
    }
  }
  const sendOids = [...wanted].filter((oid) => !held.has(oid));
  const objects: GitObject[] = [];
  const byType = (type: GitObject['type']): GitObject[] => {
    const out: GitObject[] = [];
    for (const oid of sendOids) {
      const obj = repo.objects.get(oid);
      if (obj !== undefined && obj.type === type) out.push(obj);
    }
    return out;
  };
  objects.push(...byType('commit'), ...byType('tag'), ...byType('tree'), ...byType('blob'));
  return { objects, shallow, unshallow, acks, nak: acks.length === 0 };
}

/** Resolve a ref name (branch, full ref, or oid) to a commit oid, or null. */
export function resolveRef(repo: Repo, ref: string): string | null {
  if (isObjectId(ref)) return repo.objects.has(ref) ? ref : null;
  const candidates = ref.startsWith('refs/') ? [ref] : [`refs/heads/${ref}`, `refs/tags/${ref}`];
  for (const candidate of candidates) {
    const oid = repo.refs.get(candidate);
    if (oid !== undefined) {
      const peeled = peelToCommit(repo, oid);
      return peeled ?? oid;
    }
  }
  return null;
}

/** The default branch's tip commit oid, or null when unborn. */
export function defaultTip(repo: Repo): string | null {
  const oid = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (oid === undefined) return null;
  return peelToCommit(repo, oid);
}

export function isValidRepoName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name) && !name.endsWith('.git');
}
