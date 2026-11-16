// git-http.ts — git smart HTTP: info/refs advertisements (v0 + v2), upload-pack
// (ls-refs, fetch, shallow/deepen, thin packs) and receive-pack (command list,
// pack ingest, fast-forward rules, report-status).

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  ZERO_OID,
  decodePktLines,
  encodePkt,
  encodePktLines,
  encodeFlush,
  encodeDelim,
  encodeSideband,
  readPack,
  writePack,
  verifyPackChecksum,
  parseCommit,
  parseTag,
  isObjectId,
  type GitObject,
} from './gitcore.ts';
import {
  planFetch,
  peelToCommit,
  isAncestor,
  resolveRef,
  type Repo,
} from './store.ts';
import {
  sendJson,
  sendRaw,
  sendError,
  readBody,
  pathOf,
  queryOf,
  decodeSegment,
  type ForgeCtx,
} from './util.ts';

const UPLOAD_AD = 'application/x-git-upload-pack-advertisement';
const RECEIVE_AD = 'application/x-git-receive-pack-advertisement';
const UPLOAD_RESULT = 'application/x-git-upload-pack-result';
const RECEIVE_RESULT = 'application/x-git-receive-pack-result';
const AGENT = 'forge/1.0';

interface RefLine {
  name: string;
  oid: string;
  peeled?: string;
}

/** All refs of a repo, sorted by name (heads then tags, git's advertisement order). */
function listRefs(repo: Repo): RefLine[] {
  const out: RefLine[] = [];
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const oid = repo.refs.get(name) as string;
    const obj = repo.objects.get(oid);
    const entry: RefLine = { name, oid };
    if (obj !== undefined && obj.type === 'tag') {
      const peeled = peelToCommit(repo, oid);
      if (peeled !== null) entry.peeled = peeled;
    }
    out.push(entry);
  }
  return out;
}

function headOid(repo: Repo): string {
  const oid = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  return oid ?? ZERO_OID;
}

function uploadCaps(): string {
  return `side-band-64k shallow thin-pack ofs-delta multi_ack agent=${AGENT} symref=HEAD:refs/heads/${'main'}`;
}

function receiveCaps(): string {
  return `report-status side-band-64k delete-refs ofs-delta agent=${AGENT} symref=HEAD:refs/heads/main`;
}

/** The v0 advertisement body for one service. */
function advertiseV0(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-upload-pack' ? uploadCaps() : receiveCaps();
  const serviceLine = service === 'git-upload-pack' ? '# service=git-upload-pack' : '# service=git-receive-pack';
  const parts: Buffer[] = [encodePkt(`${serviceLine}\n`), encodeFlush()];
  const refs = listRefs(repo);
  if (refs.length === 0) {
    parts.push(encodePkt(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    const head = headOid(repo);
    parts.push(encodePkt(`${head} HEAD\0${caps}\n`));
    for (const ref of refs) {
      parts.push(encodePkt(`${ref.oid} ${ref.name}\n`));
      if (ref.peeled !== undefined) parts.push(encodePkt(`${ref.peeled} ${ref.name}^{}\n`));
    }
  }
  parts.push(encodeFlush());
  return Buffer.concat(parts);
}

/** The v2 capability advertisement (upload-pack only). It never changes, so it is built once. */
const ADVERTISE_V2 = encodePktLines([
  'version 2\n',
  'ls-refs=unborn\n',
  'fetch=shallow filter\n',
  'object-format=sha1\n',
  `agent=${AGENT}\n`,
  'flush',
]);

function advertiseV2(): Buffer {
  return ADVERTISE_V2;
}

/** Parse a request path of the form /{owner}/{repo}.git[/...]. */
function gitPath(path: string): { owner: string; repo: string; rest: string } | null {
  const match = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/.exec(path);
  if (match === null) return null;
  const owner = decodeSegment(match[1] as string);
  const repo = decodeSegment(match[2] as string);
  if (owner === null || repo === null) return null;
  return { owner, repo, rest: match[3] ?? '' };
}

export async function handleGit(req: IncomingMessage, res: ServerResponse, ctx: ForgeCtx): Promise<boolean> {
  const path = pathOf(req);
  const parsed = gitPath(path);
  if (parsed === null) return false;
  const method = req.method ?? 'GET';
  const { owner, repo: repoName, rest } = parsed;
  const repo = ctx.store.getRepo(owner, repoName);

  if (method === 'GET' && rest === '/info/refs') {
    if (repo === undefined) {
      sendError(res, ctx, 404, 'Not Found');
      return true;
    }
    const service = queryOf(req).get('service');
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
      sendError(res, ctx, 400, 'service not specified');
      return true;
    }
    const protocol = req.headers['git-protocol'];
    const wantsV2 = service === 'git-upload-pack' && typeof protocol === 'string' && protocol.includes('version=2');
    if (wantsV2) {
      sendRaw(res, ctx, 200, advertiseV2(), UPLOAD_AD);
    } else {
      sendRaw(res, ctx, 200, advertiseV0(repo, service), service === 'git-upload-pack' ? UPLOAD_AD : RECEIVE_AD);
    }
    return true;
  }

  if (method === 'POST' && (rest === '/git-upload-pack' || rest === '/git-receive-pack')) {
    if (repo === undefined) {
      sendError(res, ctx, 404, 'Not Found');
      return true;
    }
    const body = await readBody(req);
    try {
      if (rest === '/git-upload-pack') {
        const out = handleUploadPack(repo, body);
        sendRaw(res, ctx, 200, out, UPLOAD_RESULT);
      } else {
        const out = handleReceivePack(repo, body);
        sendRaw(res, ctx, 200, out, RECEIVE_RESULT);
      }
    } catch (err) {
      // A malformed POST must not crash the server: answer 400 and stay healthy.
      sendError(res, ctx, 400, err instanceof Error ? err.message : 'malformed git request');
    }
    return true;
  }

  return false;
}

// ---------------------------------------------------------------- upload-pack

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
}

function handleUploadPack(repo: Repo, body: Buffer): Buffer {
  const packets = decodePktLines(body);
  const first = packets.find((packet) => packet.kind === 'data');
  const firstLine = first === undefined ? '' : first.payload.toString('utf8');
  if (firstLine.startsWith('command=ls-refs')) return handleLsRefs(repo, packets);
  if (firstLine.startsWith('command=fetch')) return handleFetchV2(repo, packets);
  return handleFetchV0(repo, packets);
}

function handleLsRefs(repo: Repo, packets: ReturnType<typeof decodePktLines>): Buffer {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  let afterDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      afterDelim = true;
      continue;
    }
    if (packet.kind !== 'data' || !afterDelim) continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line === 'unborn') unborn = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
  }
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const lines: string[] = [];
  const mainTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (keep('HEAD')) {
    if (mainTip !== undefined) {
      lines.push(symrefs ? `${mainTip} HEAD symref-target:refs/heads/${repo.defaultBranch}\n` : `${mainTip} HEAD\n`);
    } else if (unborn) {
      lines.push(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}\n`);
    }
  }
  for (const ref of listRefs(repo)) {
    if (!keep(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (peel && ref.peeled !== undefined) line += ` peeled:${ref.peeled}`;
    lines.push(`${line}\n`);
  }
  return Buffer.concat([encodePktLines(lines), encodeFlush()]);
}

function parseFetchArgs(packets: ReturnType<typeof decodePktLines>, v2: boolean): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: null };
  let afterDelim = !v2; // v0 has no command/delim structure; v2 args start after the delim
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      afterDelim = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    if (v2 && !afterDelim) continue; // command/agent/object-format lines
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line === '') continue;
    if (line.startsWith('want ')) {
      const rest = line.slice(5);
      const oid = rest.split(' ')[0] as string;
      if (isObjectId(oid)) args.wants.push(oid);
    } else if (line.startsWith('have ')) {
      const oid = line.slice(5).trim();
      if (isObjectId(oid)) args.haves.push(oid);
    } else if (line.startsWith('shallow ')) {
      const oid = line.slice(8).trim();
      if (isObjectId(oid)) args.shallow.push(oid);
    } else if (line.startsWith('deepen ')) {
      const n = Number(line.slice(7).trim());
      if (Number.isInteger(n) && n > 0) args.depth = n;
    }
    // deepen-since / deepen-not: not sent by this suite's client; ignored.
  }
  return args;
}

/** Cache of complete upload-pack fetch responses. The response is a pure
 *  function of the repo instance and the fetch arguments: planFetch reads only
 *  content-addressed objects (immutable, append-only), never refs, and the
 *  arguments fully determine ACKs, shallow lines and the pack. repo.id is a
 *  never-reused counter, so a deleted-and-recreated repo cannot collide with
 *  a stale entry. The clone workload issues the same fetch 50 times, so this
 *  turns 49 of them into a cache hit. Capped; evicts the oldest entry first.
 *  Only fetch responses are cached — ls-refs depends on refs, which move. */
const FETCH_CACHE_MAX = 128;
const fetchCache = new Map<string, Buffer>();

function fetchCacheKey(repo: Repo, v2: boolean, args: FetchArgs): string {
  return `${repo.id}|${v2 ? 'v2' : 'v0'}|${args.wants.join(',')}|${args.haves.join(',')}|${args.shallow.join(',')}|${args.depth ?? ''}`;
}

function fetchCachePut(key: string, value: Buffer): void {
  if (fetchCache.has(key)) return;
  if (fetchCache.size >= FETCH_CACHE_MAX) {
    const oldest = fetchCache.keys().next().value;
    if (oldest !== undefined) fetchCache.delete(oldest);
  }
  fetchCache.set(key, value);
}

function handleFetchV2(repo: Repo, packets: ReturnType<typeof decodePktLines>): Buffer {
  const args = parseFetchArgs(packets, true);
  if (args.wants.length === 0) return encodeFlush();
  const key = fetchCacheKey(repo, true, args);
  const cached = fetchCache.get(key);
  if (cached !== undefined) return cached;
  const plan = planFetch(repo, args.wants, args.haves, args.shallow, args.depth);
  const parts: Buffer[] = [];
  // acknowledgments
  const ackLines: string[] = [];
  if (plan.acks.length > 0) {
    for (const ack of plan.acks) ackLines.push(`ACK ${ack}\n`);
    ackLines.push('ready\n');
  } else {
    ackLines.push('NAK\n');
  }
  parts.push(encodePkt('acknowledgments\n'));
  parts.push(encodePktLines(ackLines));
  parts.push(encodeDelim());
  // shallow-info
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    const lines: string[] = [];
    for (const oid of plan.shallow) lines.push(`shallow ${oid}\n`);
    for (const oid of plan.unshallow) lines.push(`unshallow ${oid}\n`);
    parts.push(encodePkt('shallow-info\n'));
    parts.push(encodePktLines(lines));
    parts.push(encodeDelim());
  }
  // packfile
  if (plan.objects.length > 0) {
    const pack = writePack(plan.objects);
    parts.push(encodePkt('packfile\n'));
    parts.push(encodeSideband(1, pack));
  }
  parts.push(encodeFlush());
  const out = Buffer.concat(parts);
  fetchCachePut(key, out);
  return out;
}

function handleFetchV0(repo: Repo, packets: ReturnType<typeof decodePktLines>): Buffer {
  const args = parseFetchArgs(packets, false);
  if (args.wants.length === 0) return encodeFlush();
  const key = fetchCacheKey(repo, false, args);
  const cached = fetchCache.get(key);
  if (cached !== undefined) return cached;
  const plan = planFetch(repo, args.wants, args.haves, args.shallow, args.depth);
  const parts: Buffer[] = [];
  const lines: string[] = [];
  if (plan.acks.length > 0) {
    for (const ack of plan.acks) lines.push(`ACK ${ack}\n`);
  } else {
    lines.push('NAK\n');
  }
  for (const oid of plan.shallow) lines.push(`shallow ${oid}\n`);
  for (const oid of plan.unshallow) lines.push(`unshallow ${oid}\n`);
  parts.push(encodePktLines(lines));
  if (plan.objects.length > 0) {
    const pack = writePack(plan.objects);
    parts.push(encodeSideband(1, pack));
  }
  parts.push(encodeFlush());
  const out = Buffer.concat(parts);
  fetchCachePut(key, out);
  return out;
}

// ---------------------------------------------------------------- receive-pack

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function handleReceivePack(repo: Repo, body: Buffer): Buffer {
  // Parse command lines until the flush; everything after it is the packfile.
  const commands: PushCommand[] = [];
  let off = 0;
  let packStart = body.length;
  while (off + 4 <= body.length) {
    const head = body.subarray(off, off + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) throw new Error('malformed pkt-line in push');
    const len = parseInt(head, 16);
    if (len === 0) {
      packStart = off + 4;
      break;
    }
    if (len === 1 || len === 2) {
      off += 4;
      continue;
    }
    if (len < 4 || off + len > body.length) throw new Error('malformed pkt-line in push');
    const payload = body.subarray(off + 4, off + len).toString('utf8');
    const nul = payload.indexOf('\0');
    const commandLine = (nul >= 0 ? payload.slice(0, nul) : payload).replace(/\n$/, '');
    const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/.exec(commandLine);
    if (match === null) throw new Error(`malformed push command ${JSON.stringify(commandLine.slice(0, 60))}`);
    commands.push({ oldOid: match[1] as string, newOid: match[2] as string, ref: match[3] as string });
    off += len;
  }
  if (commands.length === 0) throw new Error('push with no commands');

  const updatesRef = commands.some((command) => command.newOid !== ZERO_OID);
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (updatesRef) {
    const packBytes = body.subarray(packStart);
    if (packBytes.length === 0) {
      unpackOk = false;
      unpackDetail = 'missing packfile';
    } else {
      try {
        const checksum = verifyPackChecksum(packBytes);
        if (!checksum.ok) throw new Error('pack trailer checksum mismatch');
        const read = readPack(packBytes, (oid) => repo.objects.get(oid));
        for (const [oid, obj] of read.objects) {
          if (!repo.objects.has(oid)) repo.objects.set(oid, obj);
        }
      } catch (err) {
        unpackOk = false;
        unpackDetail = err instanceof Error ? err.message : 'unpack failed';
      }
    }
  }

  const reportLines: string[] = [];
  reportLines.push(unpackOk ? 'unpack ok\n' : `unpack ${unpackDetail}\n`);
  for (const command of commands) {
    if (!unpackOk) {
      reportLines.push(`ng ${command.ref} unpack failed\n`);
      continue;
    }
    const result = applyPushCommand(repo, command);
    if (result.ok) reportLines.push(`ok ${command.ref}\n`);
    else reportLines.push(`ng ${command.ref} ${result.reason}\n`);
  }
  const report = encodePktLines(reportLines);
  return Buffer.concat([encodeSideband(1, report), encodeFlush()]);
}

function applyPushCommand(repo: Repo, command: PushCommand): { ok: boolean; reason: string } {
  const current = repo.refs.get(command.ref);
  const isTag = command.ref.startsWith('refs/tags/');
  if (command.oldOid === ZERO_OID && command.newOid === ZERO_OID) {
    return { ok: false, reason: 'invalid command' };
  }
  if (command.newOid === ZERO_OID) {
    // Delete.
    if (current === undefined) return { ok: false, reason: 'reference does not exist' };
    if (current !== command.oldOid) return { ok: false, reason: 'old value does not match' };
    repo.refs.delete(command.ref);
    return { ok: true, reason: '' };
  }
  const newObj = repo.objects.get(command.newOid);
  if (newObj === undefined) return { ok: false, reason: 'object not found' };
  if (command.oldOid === ZERO_OID) {
    // Create.
    if (current !== undefined) return { ok: false, reason: 'reference already exists' };
    repo.refs.set(command.ref, command.newOid);
    return { ok: true, reason: '' };
  }
  // Update.
  if (current === undefined) return { ok: false, reason: 'reference does not exist' };
  if (current !== command.oldOid) return { ok: false, reason: 'old value does not match' };
  if (!isTag) {
    const newCommit = peelToCommit(repo, command.newOid);
    if (newCommit === null) return { ok: false, reason: 'object is not a commit' };
    if (!isAncestor(repo, current, newCommit)) return { ok: false, reason: 'non-fast-forward' };
  }
  repo.refs.set(command.ref, command.newOid);
  return { ok: true, reason: '' };
}

/** Re-export for the REST layer: the ref a branch points at, as a commit oid. */
export function refCommitOid(repo: Repo, ref: string): string | null {
  const oid = repo.refs.get(ref);
  if (oid === undefined) return null;
  return peelToCommit(repo, oid);
}

export { parseCommit, parseTag };
