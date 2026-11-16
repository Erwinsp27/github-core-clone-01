// rest.ts — GitHub REST v3: repositories, branches, commits, contents, labels,
// issues, comments, pull requests, files and merges. Every reply is JSON with a
// non-empty X-GitHub-Request-Id; errors carry {"message": "..."}.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  VIEWER_LOGIN,
  VIEWER_ID,
  FORGE_VERSION,
  nowIso,
  repoGlobalId,
  issueGlobalId,
  pullGlobalId,
  commentGlobalId,
  decodeGlobalId,
  putObject,
  createCommit,
  setPathInTree,
  flattenTree,
  diffTrees,
  hasMergeConflict,
  mergeBase,
  resolveRef,
  defaultTip,
  isValidRepoName,
  EMPTY_TREE_OID,
  type Repo,
  type Issue,
  type PullRequest,
  type Label,
} from './store.ts';
import { parseCommit, parseTree, hashObject, isObjectId } from './gitcore.ts';
import {
  sendJson,
  sendEmpty,
  sendError,
  readBody,
  parseJsonBody,
  requireAuth,
  pathOf,
  queryOf,
  splitPath,
  decodeSegment,
  originOf,
  type ForgeCtx,
} from './util.ts';

// ---------------------------------------------------------------- views

export function repoView(repo: Repo, origin: string): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: repo.owner === VIEWER_LOGIN ? VIEWER_ID : 0, type: 'User' },
    private: repo.private,
    description: repo.description === '' ? null : repo.description,
    default_branch: repo.defaultBranch,
    html_url: `${origin}/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    has_issues: true,
    fork: false,
  };
}

export function labelView(label: Label): Record<string, unknown> {
  return { name: label.name, color: label.color };
}

export function issueView(issue: Issue): Record<string, unknown> {
  return {
    id: issue.globalId,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map(labelView),
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    comments: issue.comments.length,
  };
}

export function commentView(repo: Repo, issue: Issue, comment: { id: number; globalId: string; body: string; createdAt: string }): Record<string, unknown> {
  void repo;
  void issue;
  return {
    id: comment.id,
    node_id: comment.globalId,
    body: comment.body,
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    created_at: comment.createdAt,
    updated_at: comment.createdAt,
  };
}

export function pullMergeable(repo: Repo, pull: PullRequest): boolean {
  if (pull.state !== 'open') return false;
  const tips = pullTips(repo, pull);
  if (tips === null) return false;
  const base = mergeBase(repo, tips.headSha, tips.baseSha);
  return !hasMergeConflict(repo, tips.baseSha, tips.headSha, base);
}

/**
 * A pull request's head and base tips as the branches point at NOW (a merge moves
 * the base branch, so the snapshot taken at creation time goes stale).
 */
export function pullTips(repo: Repo, pull: PullRequest): { headSha: string; baseSha: string } | null {
  const headSha = repo.refs.get(`refs/heads/${pull.headRef}`);
  const baseSha = repo.refs.get(`refs/heads/${pull.baseRef}`);
  if (headSha === undefined || baseSha === undefined) return null;
  return { headSha, baseSha };
}

export function pullView(repo: Repo, pull: PullRequest): Record<string, unknown> {
  const tips = pullTips(repo, pull);
  const headSha = tips?.headSha ?? pull.headSha;
  const baseSha = tips?.baseSha ?? pull.baseSha;
  return {
    id: pull.globalId,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    mergeable: pullMergeable(repo, pull),
    head: { ref: pull.headRef, sha: headSha, label: `${repo.owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: baseSha, label: `${repo.owner}:${pull.baseRef}` },
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
  };
}

function branchView(repo: Repo, name: string, sha: string): Record<string, unknown> {
  void repo;
  return { name, commit: { sha }, protected: false };
}

function commitView(repo: Repo, sha: string): Record<string, unknown> | null {
  const obj = repo.objects.get(sha);
  if (obj === undefined || obj.type !== 'commit') return null;
  const info = parseCommit(obj.data);
  const authorDate = authorEpoch(info.author);
  const committerDate = authorEpoch(info.committer);
  return {
    sha,
    commit: {
      // GitHub's API answers the message without the commit object's trailing newline.
      message: info.message.replace(/\n$/, ''),
      author: { name: authorName(info.author), email: authorEmail(info.author), date: authorDate },
      committer: { name: authorName(info.committer), email: authorEmail(info.committer), date: committerDate },
    },
    parents: info.parents.map((parent) => ({ sha: parent })),
    author: { login: VIEWER_LOGIN },
    committer: { login: VIEWER_LOGIN },
  };
}

function authorEpoch(line: string): string {
  const match = / (\d+) \+0000$/.exec(line);
  if (match === null) return nowIso();
  return new Date(Number(match[1]) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function authorName(line: string): string {
  const lt = line.indexOf('<');
  return (lt > 0 ? line.slice(0, lt) : line).trim();
}

function authorEmail(line: string): string {
  const lt = line.indexOf('<');
  const gt = line.indexOf('>');
  if (lt < 0 || gt < 0) return '';
  return line.slice(lt + 1, gt);
}

// ---------------------------------------------------------------- helpers

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function bodyString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  return typeof value === 'string' ? value : '';
}

function bodyBoolean(body: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = body[key];
  return typeof value === 'boolean' ? value : fallback;
}

/** The repo for /repos/{owner}/{name}, or null when absent or foreign-owned. */
function resolveRepo(ctx: ForgeCtx, owner: string, name: string): Repo | null {
  const repo = ctx.store.getRepo(owner, name);
  if (repo === undefined || repo.owner !== owner) return null;
  return repo;
}

/** Paginate an array with per_page/page query params; returns the page and total pages. */
function paginate<T>(items: readonly T[], query: URLSearchParams): { page: T[]; pageNum: number; perPage: number; totalPages: number } {
  const perPageRaw = Number(query.get('per_page') ?? '30');
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(100, Math.trunc(perPageRaw)) : 30;
  const pageRaw = Number(query.get('page') ?? '1');
  const pageNum = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.trunc(pageRaw) : 1;
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const start = (pageNum - 1) * perPage;
  return { page: items.slice(start, start + perPage), pageNum, perPage, totalPages };
}

/** The Link header for a paginated list (absolute URLs on this origin). */
function linkHeader(req: IncomingMessage, basePath: string, query: URLSearchParams, pageNum: number, perPage: number, totalPages: number): string {
  const origin = originOf(req);
  const links: string[] = [];
  const build = (page: number): string => {
    const params = new URLSearchParams(query);
    params.set('per_page', String(perPage));
    params.set('page', String(page));
    return `${origin}${basePath}?${params.toString()}`;
  };
  if (pageNum < totalPages) links.push(`<${build(pageNum + 1)}>; rel="next"`);
  if (totalPages > 1) links.push(`<${build(totalPages)}>; rel="last"`);
  return links.join(', ');
}

/** The tree entry at `path` on a commit tip, or null. */
function treeEntryAt(repo: Repo, tip: string, path: string): { oid: string; mode: string } | null {
  const obj = repo.objects.get(tip);
  if (obj === undefined || obj.type !== 'commit') return null;
  const flat = flattenTree(repo, parseCommit(obj.data).tree);
  return flat.get(path) ?? null;
}

/** The subtree oid at `dir` on a commit tip, or null ('' means the root tree). */
function subtreeAt(repo: Repo, tip: string, dir: string): string | null {
  const obj = repo.objects.get(tip);
  if (obj === undefined || obj.type !== 'commit') return null;
  let treeOid = parseCommit(obj.data).tree;
  if (dir === '') return treeOid;
  for (const part of dir.split('/')) {
    const treeObj = repo.objects.get(treeOid);
    if (treeObj === undefined || treeObj.type !== 'tree') return null;
    const entry = parseTree(treeObj.data).find((candidate) => candidate.name === part && candidate.mode === '40000');
    if (entry === undefined) return null;
    treeOid = entry.oid;
  }
  return treeOid;
}

/** Commit one file change on a branch: blob + tree + commit, updating the ref. */
function commitFile(
  repo: Repo,
  branch: string,
  path: string,
  content: Buffer | null,
  message: string,
): { commitSha: string; blobSha: string | null } {
  const ref = `refs/heads/${branch}`;
  const tip = repo.refs.get(ref);
  const baseTree = tip === undefined ? null : (() => {
    const obj = repo.objects.get(tip);
    return obj !== undefined && obj.type === 'commit' ? parseCommit(obj.data).tree : null;
  })();
  const parents = tip === undefined ? [] : [tip];
  const blobSha = content === null ? null : putObject(repo, 'blob', content);
  const parts = path.split('/').filter((part) => part !== '');
  const newTree = setPathInTree(repo, baseTree, parts, blobSha);
  const commitSha = createCommit(repo, newTree, parents, message === '' ? `Update ${path}` : message);
  repo.refs.set(ref, commitSha);
  return { commitSha, blobSha };
}

// ---------------------------------------------------------------- router

export async function handleRest(req: IncomingMessage, res: ServerResponse, ctx: ForgeCtx): Promise<boolean> {
  const path = pathOf(req);
  if (path !== '/api/v3' && !path.startsWith('/api/v3/')) return false;
  const method = req.method ?? 'GET';
  const query = queryOf(req);

  // Public: the API root and meta.
  if (method === 'GET' && (path === '/api/v3' || path === '/api/v3/')) {
    sendJson(res, ctx, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
    return true;
  }
  if (method === 'GET' && path === '/api/v3/meta') {
    sendJson(res, ctx, 200, { installed_version: FORGE_VERSION });
    return true;
  }

  if (!requireAuth(req, res, ctx)) return true;

  const segments = splitPath(path); // ['api','v3',...]
  const rest = segments.slice(2);

  // GET /api/v3/user
  if (method === 'GET' && rest.length === 1 && rest[0] === 'user') {
    sendJson(res, ctx, 200, { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User', name: VIEWER_LOGIN });
    return true;
  }

  // /api/v3/user/repos
  if (rest.length === 2 && rest[0] === 'user' && rest[1] === 'repos') {
    if (method === 'POST') {
      const raw = await readBody(req);
      const parsed = parseJsonBody(raw);
      if (!isRecord(parsed)) {
        sendError(res, ctx, 400, 'Invalid JSON body');
        return true;
      }
      const name = bodyString(parsed, 'name');
      if (!isValidRepoName(name)) {
        sendError(res, ctx, 422, 'Invalid repository name');
        return true;
      }
      if (ctx.store.getRepo(VIEWER_LOGIN, name) !== undefined) {
        sendError(res, ctx, 422, 'Repository already exists');
        return true;
      }
      const repo = ctx.store.createRepo(VIEWER_LOGIN, name, bodyString(parsed, 'description'), bodyBoolean(parsed, 'private', false));
      sendJson(res, ctx, 201, repoView(repo, originOf(req)));
      return true;
    }
    if (method === 'GET') {
      const repos = ctx.store.viewerRepos();
      const { page, pageNum, perPage, totalPages } = paginate(repos, query);
      const headers: Record<string, string> = {};
      const link = linkHeader(req, '/api/v3/user/repos', query, pageNum, perPage, totalPages);
      if (link !== '') headers.link = link;
      sendJson(res, ctx, 200, page.map((repo) => repoView(repo, originOf(req))), headers);
      return true;
    }
    return true;
  }

  // /api/v3/repos/{owner}/{name}[/...]
  if (rest.length >= 3 && rest[0] === 'repos') {
    const owner = decodeSegment(rest[1] as string);
    const name = decodeSegment(rest[2] as string);
    if (owner === null || name === null) {
      sendError(res, ctx, 404, 'Not Found');
      return true;
    }
    const repo = resolveRepo(ctx, owner, name);
    if (repo === null) {
      sendError(res, ctx, 404, 'Not Found');
      return true;
    }
    return handleRepoRoute(req, res, ctx, repo, rest.slice(3), query);
  }

  sendError(res, ctx, 404, 'Not Found');
  return true;
}

async function handleRepoRoute(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ForgeCtx,
  repo: Repo,
  rest: string[],
  query: URLSearchParams,
): Promise<boolean> {
  const method = req.method ?? 'GET';
  const origin = originOf(req);

  // /repos/{o}/{r} itself
  if (rest.length === 0) {
    if (method === 'GET') {
      sendJson(res, ctx, 200, repoView(repo, origin));
      return true;
    }
    if (method === 'PATCH') {
      const raw = await readBody(req);
      const parsed = parseJsonBody(raw);
      if (isRecord(parsed)) {
        if (typeof parsed.description === 'string') repo.description = parsed.description;
        if (typeof parsed.default_branch === 'string' && repo.refs.has(`refs/heads/${parsed.default_branch}`)) {
          repo.defaultBranch = parsed.default_branch;
        }
        repo.updatedAt = nowIso();
      }
      sendJson(res, ctx, 200, repoView(repo, origin));
      return true;
    }
    if (method === 'DELETE') {
      ctx.store.deleteRepo(repo.owner, repo.name);
      sendEmpty(res, ctx, 204);
      return true;
    }
    return true;
  }

  const head = rest[0] as string;

  // git/refs
  if (head === 'git' && rest[1] === 'refs') {
    if (method === 'POST' && rest.length === 2) {
      const raw = await readBody(req);
      const parsed = parseJsonBody(raw);
      if (!isRecord(parsed)) {
        sendError(res, ctx, 400, 'Invalid JSON body');
        return true;
      }
      const ref = bodyString(parsed, 'ref');
      const sha = bodyString(parsed, 'sha');
      if (!ref.startsWith('refs/') || !isObjectId(sha) || repo.objects.get(sha) === undefined) {
        sendError(res, ctx, 422, 'Invalid ref or sha');
        return true;
      }
      if (repo.refs.has(ref)) {
        sendError(res, ctx, 422, 'Reference already exists');
        return true;
      }
      repo.refs.set(ref, sha);
      sendJson(res, ctx, 201, { ref, object: { sha, type: 'commit' } });
      return true;
    }
    if (method === 'GET' && rest.length === 4 && rest[2] === 'heads') {
      const branch = decodeSegment(rest[3] as string);
      if (branch === null) {
        sendError(res, ctx, 404, 'Not Found');
        return true;
      }
      const oid = repo.refs.get(`refs/heads/${branch}`);
      if (oid === undefined) {
        sendError(res, ctx, 404, 'Not Found');
        return true;
      }
      sendJson(res, ctx, 200, { ref: `refs/heads/${branch}`, object: { sha: oid, type: 'commit' } });
      return true;
    }
    return true;
  }

  // branches
  if (head === 'branches') {
    if (method === 'GET' && rest.length === 1) {
      const names = [...repo.refs.keys()].filter((ref) => ref.startsWith('refs/heads/')).map((ref) => ref.slice('refs/heads/'.length)).sort();
      const out: Record<string, unknown>[] = [];
      for (const branch of names) {
        const oid = repo.refs.get(`refs/heads/${branch}`) as string;
        out.push(branchView(repo, branch, oid));
      }
      sendJson(res, ctx, 200, out);
      return true;
    }
    if (method === 'GET' && rest.length === 2) {
      const branch = decodeSegment(rest[1] as string);
      if (branch === null) {
        sendError(res, ctx, 404, 'Not Found');
        return true;
      }
      const oid = repo.refs.get(`refs/heads/${branch}`);
      if (oid === undefined) {
        sendError(res, ctx, 404, 'Not Found');
        return true;
      }
      sendJson(res, ctx, 200, branchView(repo, branch, oid));
      return true;
    }
    return true;
  }

  // commits
  if (head === 'commits' && method === 'GET' && rest.length === 1) {
    const refParam = query.get('sha');
    const tip = refParam === null ? defaultTip(repo) : resolveRef(repo, refParam);
    if (tip === null) {
      sendJson(res, ctx, 200, []);
      return true;
    }
    const out: Record<string, unknown>[] = [];
    const seen = new Set<string>();
    const queue = [tip];
    while (queue.length > 0) {
      const oid = queue.shift() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const view = commitView(repo, oid);
      if (view !== null) out.push(view);
      const obj = repo.objects.get(oid);
      if (obj !== undefined && obj.type === 'commit') {
        for (const parent of parseCommit(obj.data).parents) queue.push(parent);
      }
    }
    const { page } = paginate(out, query);
    sendJson(res, ctx, 200, page);
    return true;
  }

  // contents
  if (head === 'contents') {
    const pathParts = rest.slice(1).map((segment) => decodeSegment(segment));
    if (pathParts.some((part) => part === null)) {
      sendError(res, ctx, 404, 'Not Found');
      return true;
    }
    const filePath = (pathParts as string[]).join('/');
    if (method === 'GET') {
      const refParam = query.get('ref');
      const tip = refParam === null ? defaultTip(repo) : resolveRef(repo, refParam);
      if (tip === null) {
        sendError(res, ctx, 404, 'Not Found');
        return true;
      }
      if (filePath === '') {
        sendJson(res, ctx, 200, listDirectory(repo, tip, ''));
        return true;
      }
      const entry = treeEntryAt(repo, tip, filePath);
      if (entry !== null) {
        const blob = repo.objects.get(entry.oid);
        const name = filePath.split('/').pop() as string;
        sendJson(res, ctx, 200, {
          type: 'file',
          encoding: 'base64',
          size: blob?.data.length ?? 0,
          name,
          path: filePath,
          content: (blob?.data ?? Buffer.alloc(0)).toString('base64'),
          sha: entry.oid,
        });
        return true;
      }
      const subtree = subtreeAt(repo, tip, filePath);
      if (subtree !== null) {
        sendJson(res, ctx, 200, listDirectory(repo, tip, filePath));
        return true;
      }
      sendError(res, ctx, 404, 'Not Found');
      return true;
    }
    if (method === 'PUT') {
      const raw = await readBody(req);
      const parsed = parseJsonBody(raw);
      if (!isRecord(parsed)) {
        sendError(res, ctx, 400, 'Invalid JSON body');
        return true;
      }
      const contentB64 = parsed.content;
      if (typeof contentB64 !== 'string') {
        sendError(res, ctx, 422, 'content must be base64');
        return true;
      }
      const message = bodyString(parsed, 'message');
      const branch = bodyString(parsed, 'branch') || repo.defaultBranch;
      const givenSha = typeof parsed.sha === 'string' ? parsed.sha : null;
      const tip = repo.refs.get(`refs/heads/${branch}`);
      const exists = tip !== undefined && treeEntryAt(repo, tip, filePath) !== null;
      if (givenSha !== null) {
        const current = tip === undefined ? null : treeEntryAt(repo, tip, filePath);
        if (current === null || current.oid !== givenSha) {
          sendError(res, ctx, 409, 'sha does not match the current file');
          return true;
        }
      } else if (exists) {
        sendError(res, ctx, 409, 'file already exists; pass its sha to update');
        return true;
      }
      const content = Buffer.from(contentB64, 'base64');
      const { commitSha, blobSha } = commitFile(repo, branch, filePath, content, message);
      const name = filePath.split('/').pop() as string;
      sendJson(res, ctx, exists ? 200 : 201, {
        content: { name, path: filePath, sha: blobSha, size: content.length, encoding: 'base64', content: contentB64 },
        commit: { sha: commitSha, message },
      });
      return true;
    }
    if (method === 'DELETE') {
      const raw = await readBody(req);
      const parsed = parseJsonBody(raw);
      if (!isRecord(parsed)) {
        sendError(res, ctx, 400, 'Invalid JSON body');
        return true;
      }
      const branch = bodyString(parsed, 'branch') || repo.defaultBranch;
      const givenSha = typeof parsed.sha === 'string' ? parsed.sha : null;
      const tip = repo.refs.get(`refs/heads/${branch}`);
      if (tip === undefined) {
        sendError(res, ctx, 404, 'Not Found');
        return true;
      }
      const current = treeEntryAt(repo, tip, filePath);
      if (current === null) {
        sendError(res, ctx, 404, 'Not Found');
        return true;
      }
      if (givenSha !== null && current.oid !== givenSha) {
        sendError(res, ctx, 409, 'sha does not match the current file');
        return true;
      }
      const message = bodyString(parsed, 'message');
      const { commitSha } = commitFile(repo, branch, filePath, null, message);
      sendJson(res, ctx, 200, { commit: { sha: commitSha }, content: null });
      return true;
    }
    return true;
  }

  // labels
  if (head === 'labels') {
    if (method === 'GET' && rest.length === 1) {
      sendJson(res, ctx, 200, [...repo.labels.values()].map(labelView));
      return true;
    }
    if (method === 'POST' && rest.length === 1) {
      const raw = await readBody(req);
      const parsed = parseJsonBody(raw);
      if (!isRecord(parsed)) {
        sendError(res, ctx, 400, 'Invalid JSON body');
        return true;
      }
      const name = bodyString(parsed, 'name');
      if (name === '') {
        sendError(res, ctx, 422, 'Label name is required');
        return true;
      }
      if (repo.labels.has(name)) {
        sendError(res, ctx, 422, 'Label already exists');
        return true;
      }
      const label: Label = { name, color: bodyString(parsed, 'color') || 'ededed' };
      repo.labels.set(name, label);
      sendJson(res, ctx, 201, labelView(label));
      return true;
    }
    return true;
  }

  // issues
  if (head === 'issues') {
    if (rest.length === 1) {
      if (method === 'POST') {
        const raw = await readBody(req);
        const parsed = parseJsonBody(raw);
        if (!isRecord(parsed)) {
          sendError(res, ctx, 400, 'Invalid JSON body');
          return true;
        }
        const title = bodyString(parsed, 'title');
        if (title === '') {
          sendError(res, ctx, 422, 'Title is required');
          return true;
        }
        const labelNames = Array.isArray(parsed.labels) ? parsed.labels.filter((entry): entry is string => typeof entry === 'string') : [];
        const labels: Label[] = [];
        for (const labelName of labelNames) {
          const label = repo.labels.get(labelName);
          if (label === undefined) {
            sendError(res, ctx, 422, `Label does not exist: ${labelName}`);
            return true;
          }
          labels.push(label);
        }
        const issue = createIssueRecord(repo, title, bodyString(parsed, 'body'), labels);
        sendJson(res, ctx, 201, issueView(issue));
        return true;
      }
      if (method === 'GET') {
        const state = query.get('state') ?? 'open';
        const sort = query.get('sort') ?? 'created';
        const direction = query.get('direction') ?? 'desc';
        let issues = [...repo.issues];
        if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
        else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
        if (sort === 'created') {
          issues.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
        }
        const { page } = paginate(issues, query);
        sendJson(res, ctx, 200, page.map(issueView));
        return true;
      }
      return true;
    }
    const number = Number(rest[1]);
    if (!Number.isInteger(number) || number < 1) {
      sendError(res, ctx, 404, 'Not Found');
      return true;
    }
    const issue = repo.issues.find((entry) => entry.number === number) ?? null;
    if (rest.length === 2) {
      if (issue === null) {
        sendError(res, ctx, 404, 'Not Found');
        return true;
      }
      if (method === 'GET') {
        sendJson(res, ctx, 200, issueView(issue));
        return true;
      }
      if (method === 'PATCH') {
        const raw = await readBody(req);
        const parsed = parseJsonBody(raw);
        if (isRecord(parsed)) {
          if (parsed.state === 'open' || parsed.state === 'closed') issue.state = parsed.state;
          if (typeof parsed.title === 'string' && parsed.title !== '') issue.title = parsed.title;
          if (typeof parsed.body === 'string') issue.body = parsed.body;
          issue.updatedAt = nowIso();
        }
        sendJson(res, ctx, 200, issueView(issue));
        return true;
      }
      return true;
    }
    if (rest.length === 3 && rest[2] === 'comments') {
      if (issue === null) {
        sendError(res, ctx, 404, 'Not Found');
        return true;
      }
      if (method === 'GET') {
        sendJson(res, ctx, 200, issue.comments.map((comment) => commentView(repo, issue, comment)));
        return true;
      }
      if (method === 'POST') {
        const raw = await readBody(req);
        const parsed = parseJsonBody(raw);
        if (!isRecord(parsed) || typeof parsed.body !== 'string' || parsed.body === '') {
          sendError(res, ctx, 422, 'Comment body is required');
          return true;
        }
        const comment = {
          id: repo.nextComment,
          globalId: commentGlobalId(repo.owner, repo.name, issue.number, repo.nextComment),
          body: parsed.body,
          createdAt: nowIso(),
        };
        repo.nextComment += 1;
        issue.comments.push(comment);
        sendJson(res, ctx, 201, commentView(repo, issue, comment));
        return true;
      }
      return true;
    }
    return true;
  }

  // pulls
  if (head === 'pulls') {
    if (rest.length === 1) {
      if (method === 'POST') {
        const raw = await readBody(req);
        const parsed = parseJsonBody(raw);
        if (!isRecord(parsed)) {
          sendError(res, ctx, 400, 'Invalid JSON body');
          return true;
        }
        const title = bodyString(parsed, 'title');
        const headRef = bodyString(parsed, 'head');
        const baseRef = bodyString(parsed, 'base');
        if (title === '' || headRef === '' || baseRef === '') {
          sendError(res, ctx, 422, 'title, head and base are required');
          return true;
        }
        const headSha = repo.refs.get(`refs/heads/${headRef}`);
        const baseSha = repo.refs.get(`refs/heads/${baseRef}`);
        if (headSha === undefined || baseSha === undefined) {
          sendError(res, ctx, 422, 'head or base branch does not exist');
          return true;
        }
        const duplicate = repo.pulls.find((pull) => pull.headRef === headRef && pull.state === 'open');
        if (duplicate !== undefined) {
          sendError(res, ctx, 422, 'A pull request already exists for this head branch');
          return true;
        }
        const now = nowIso();
        const pull: PullRequest = {
          globalId: pullGlobalId(repo.owner, repo.name, repo.nextPull),
          number: repo.nextPull,
          title,
          body: bodyString(parsed, 'body'),
          state: 'open',
          merged: false,
          mergedAt: null,
          mergeCommitSha: null,
          headRef,
          baseRef,
          headSha,
          baseSha,
          createdAt: now,
          updatedAt: now,
          seq: repo.nextPull,
        };
        repo.nextPull += 1;
        repo.pulls.push(pull);
        sendJson(res, ctx, 201, pullView(repo, pull));
        return true;
      }
      if (method === 'GET') {
        const state = query.get('state') ?? 'open';
        let pulls = [...repo.pulls];
        if (state === 'open') pulls = pulls.filter((pull) => pull.state === 'open');
        else if (state === 'closed') pulls = pulls.filter((pull) => pull.state === 'closed');
        pulls.sort((a, b) => a.seq - b.seq);
        const { page } = paginate(pulls, query);
        sendJson(res, ctx, 200, page.map((pull) => pullView(repo, pull)));
        return true;
      }
      return true;
    }
    const number = Number(rest[1]);
    if (!Number.isInteger(number) || number < 1) {
      sendError(res, ctx, 404, 'Not Found');
      return true;
    }
    const pull = repo.pulls.find((entry) => entry.number === number) ?? null;
    if (pull === null) {
      sendError(res, ctx, 404, 'Not Found');
      return true;
    }
    if (rest.length === 2 && method === 'GET') {
      sendJson(res, ctx, 200, pullView(repo, pull));
      return true;
    }
    if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
      const tips = pullTips(repo, pull);
      const changes = diffTrees(repo, tips?.baseSha ?? pull.baseSha, tips?.headSha ?? pull.headSha);
      sendJson(res, ctx, 200, changes);
      return true;
    }
    if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
      const raw = await readBody(req);
      const parsed = parseJsonBody(raw);
      const mergeMethod = isRecord(parsed) ? bodyString(parsed, 'merge_method') : '';
      if (pull.state !== 'open') {
        sendError(res, ctx, 405, 'Pull request is already closed');
        return true;
      }
      const tips = pullTips(repo, pull);
      if (tips === null) {
        sendError(res, ctx, 422, 'head or base branch not found');
        return true;
      }
      const base = mergeBase(repo, tips.headSha, tips.baseSha);
      if (hasMergeConflict(repo, tips.baseSha, tips.headSha, base)) {
        sendError(res, ctx, 405, 'Merge conflict');
        return true;
      }
      void mergeMethod; // squash is the only method this forge performs
      const headObj = repo.objects.get(tips.headSha);
      if (headObj === undefined || headObj.type !== 'commit') {
        sendError(res, ctx, 422, 'head commit not found');
        return true;
      }
      const headTree = parseCommit(headObj.data).tree;
      const message = `Merge pull request #${pull.number} from ${repo.owner}:${pull.headRef}`;
      const sha = createCommit(repo, headTree, [tips.baseSha], message);
      repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
      pull.headSha = tips.headSha;
      pull.baseSha = tips.baseSha;
      pull.state = 'closed';
      pull.merged = true;
      pull.mergedAt = nowIso();
      pull.mergeCommitSha = sha;
      pull.updatedAt = nowIso();
      sendJson(res, ctx, 200, { sha, merged: true, message: 'Pull request successfully merged' });
      return true;
    }
    return true;
  }

  sendError(res, ctx, 404, 'Not Found');
  return true;
}

function listDirectory(repo: Repo, tip: string, dir: string): Record<string, unknown>[] {
  const treeOid = subtreeAt(repo, tip, dir);
  if (treeOid === null) return [];
  const obj = repo.objects.get(treeOid);
  if (obj === undefined || obj.type !== 'tree') return [];
  const out: Record<string, unknown>[] = [];
  for (const entry of parseTree(obj.data)) {
    const path = dir === '' ? entry.name : `${dir}/${entry.name}`;
    if (entry.mode === '40000') {
      out.push({ type: 'dir', name: entry.name, path, sha: entry.oid });
    } else {
      const blob = repo.objects.get(entry.oid);
      out.push({ type: 'file', name: entry.name, path, sha: entry.oid, size: blob?.data.length ?? 0 });
    }
  }
  return out;
}

/** Create an issue record (shared with GraphQL/MCP). */
export function createIssueRecord(repo: Repo, title: string, body: string, labels: Label[]): Issue {
  const now = nowIso();
  const issue: Issue = {
    globalId: issueGlobalId(repo.owner, repo.name, repo.nextIssue),
    number: repo.nextIssue,
    title,
    body,
    state: 'open',
    labels,
    comments: [],
    createdAt: now,
    updatedAt: now,
    seq: repo.nextIssue,
  };
  repo.nextIssue += 1;
  repo.issues.push(issue);
  return issue;
}

/** Create a pull request record (shared with GraphQL/MCP). */
export function createPullRecord(repo: Repo, title: string, body: string, headRef: string, baseRef: string): PullRequest | null {
  const headSha = repo.refs.get(`refs/heads/${headRef}`);
  const baseSha = repo.refs.get(`refs/heads/${baseRef}`);
  if (headSha === undefined || baseSha === undefined) return null;
  const now = nowIso();
  const pull: PullRequest = {
    globalId: pullGlobalId(repo.owner, repo.name, repo.nextPull),
    number: repo.nextPull,
    title,
    body,
    state: 'open',
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    headRef,
    baseRef,
    headSha,
    baseSha,
    createdAt: now,
    updatedAt: now,
    seq: repo.nextPull,
  };
  repo.nextPull += 1;
  repo.pulls.push(pull);
  return pull;
}

/** Squash-merge an open pull request (shared with GraphQL/MCP). Returns null on conflict/closed. */
export function squashMerge(repo: Repo, pull: PullRequest): string | null {
  if (pull.state !== 'open') return null;
  const tips = pullTips(repo, pull);
  if (tips === null) return null;
  const base = mergeBase(repo, tips.headSha, tips.baseSha);
  if (hasMergeConflict(repo, tips.baseSha, tips.headSha, base)) return null;
  const headObj = repo.objects.get(tips.headSha);
  if (headObj === undefined || headObj.type !== 'commit') return null;
  const headTree = parseCommit(headObj.data).tree;
  const message = `Merge pull request #${pull.number} from ${repo.owner}:${pull.headRef}`;
  const sha = createCommit(repo, headTree, [tips.baseSha], message);
  repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
  pull.headSha = tips.headSha;
  pull.baseSha = tips.baseSha;
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = nowIso();
  pull.mergeCommitSha = sha;
  pull.updatedAt = nowIso();
  return sha;
}

export { hashObject, decodeGlobalId };
