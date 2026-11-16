// mcp.ts — Model Context Protocol over streamable HTTP at POST /mcp.
// Modern era (2026-07-28): server/discover, no handshake, no session. The legacy
// initialize handshake is also answered, so an older client still connects.
// Tools act on the same store as REST, and their results carry both a text block
// (JSON) and structuredContent, so the suite reads them either way.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { VIEWER_LOGIN, nowIso, commentGlobalId } from './store.ts';
import {
  repoView,
  issueView,
  pullView,
  createIssueRecord,
  createPullRecord,
  squashMerge,
} from './rest.ts';
import {
  sendJson,
  sendEmpty,
  readBody,
  parseJsonBody,
  authOk,
  type ForgeCtx,
} from './util.ts';

const SERVER_NAME = 'forge';
const SERVER_VERSION = '1.0.0';
const PREFERRED_REVISION = '2026-07-28';

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** The six tools, in a fixed order; the array is built once and reused verbatim. */
const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name' },
        description: { type: 'string', description: 'Repository description' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
        owner: { type: 'string', description: 'Owner login (defaults to the token owner)' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Read one repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Issue title' },
        body: { type: 'string', description: 'Issue body' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        state: { type: 'string', description: 'open, closed or all' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Pull request title' },
        body: { type: 'string', description: 'Pull request body' },
        head: { type: 'string', description: 'Head branch name' },
        base: { type: 'string', description: 'Base branch name' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        pull_number: { type: 'integer', description: 'Pull request number' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

const TOOLS_JSON = JSON.stringify(TOOLS);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

interface RpcResponse {
  jsonrpc: '2.0';
  id: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

function rpcResult(id: unknown, result: unknown): RpcResponse {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id: unknown, code: number, message: string): RpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function toolResult(data: unknown): Record<string, unknown> {
  return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data, isError: false };
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function missingArgs(tool: ToolDef, args: Record<string, unknown>): string[] {
  const required = Array.isArray(tool.inputSchema.required) ? (tool.inputSchema.required as string[]) : [];
  return required.filter((name) => args[name] === undefined || args[name] === null || args[name] === '');
}

/** Run one tool; returns a tool result object (isError when it failed). */
function callTool(ctx: ForgeCtx, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const tool = TOOLS.find((entry) => entry.name === name);
  if (tool === undefined) return toolError(`unknown tool ${name}`);
  const missing = missingArgs(tool, args);
  if (missing.length > 0) return toolError(`missing required argument(s): ${missing.join(', ')}`);

  if (name === 'create_repo') {
    const repoName = String(args.name);
    if (ctx.store.getRepo(VIEWER_LOGIN, repoName) !== undefined) return toolError(`repository ${repoName} already exists`);
    const repo = ctx.store.createRepo(
      VIEWER_LOGIN,
      repoName,
      typeof args.description === 'string' ? args.description : '',
      args.private === true,
    );
    return toolResult(repoView(repo, ''));
  }
  if (name === 'get_repo') {
    const owner = String(args.owner);
    const repoName = String(args.repo);
    const repo = ctx.store.getRepo(owner, repoName);
    if (repo === undefined || repo.owner !== owner) return toolError(`repository ${owner}/${repoName} not found`);
    return toolResult(repoView(repo, ''));
  }
  if (name === 'create_issue') {
    const owner = String(args.owner);
    const repoName = String(args.repo);
    const repo = ctx.store.getRepo(owner, repoName);
    if (repo === undefined || repo.owner !== owner) return toolError(`repository ${owner}/${repoName} not found`);
    const issue = createIssueRecord(repo, String(args.title), typeof args.body === 'string' ? args.body : '', []);
    return toolResult(issueView(issue));
  }
  if (name === 'list_issues') {
    const owner = String(args.owner);
    const repoName = String(args.repo);
    const repo = ctx.store.getRepo(owner, repoName);
    if (repo === undefined || repo.owner !== owner) return toolError(`repository ${owner}/${repoName} not found`);
    const state = typeof args.state === 'string' ? args.state : 'open';
    let issues = [...repo.issues];
    if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
    else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
    return toolResult({ issues: issues.map(issueView) });
  }
  if (name === 'create_pull_request') {
    const owner = String(args.owner);
    const repoName = String(args.repo);
    const repo = ctx.store.getRepo(owner, repoName);
    if (repo === undefined || repo.owner !== owner) return toolError(`repository ${owner}/${repoName} not found`);
    const pull = createPullRecord(repo, String(args.title), typeof args.body === 'string' ? args.body : '', String(args.head), String(args.base));
    if (pull === null) return toolError('head or base branch does not exist');
    return toolResult(pullView(repo, pull));
  }
  if (name === 'merge_pull_request') {
    const owner = String(args.owner);
    const repoName = String(args.repo);
    const repo = ctx.store.getRepo(owner, repoName);
    if (repo === undefined || repo.owner !== owner) return toolError(`repository ${owner}/${repoName} not found`);
    const number = Number(args.pull_number);
    const pull = repo.pulls.find((entry) => entry.number === number);
    if (pull === undefined) return toolError(`pull request #${number} not found`);
    const sha = squashMerge(repo, pull);
    if (sha === null) return toolError(`pull request #${number} cannot be merged (conflict or already closed)`);
    return toolResult({ number: pull.number, merged: true, state: 'closed', sha });
  }
  return toolError(`unknown tool ${name}`);
}

export async function handleMcp(req: IncomingMessage, res: ServerResponse, ctx: ForgeCtx): Promise<boolean> {
  const method = req.method ?? 'POST';
  // The legacy client's close() DELETEs the endpoint: answer 200, ignore it.
  if (method === 'DELETE') {
    sendEmpty(res, ctx, 200);
    return true;
  }
  if (method !== 'POST') {
    sendJson(res, ctx, 405, { message: 'Method Not Allowed' });
    return true;
  }
  // Authentication is decided before any tool exists.
  if (!authOk(req, ctx)) {
    sendJson(res, ctx, 401, { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Unauthorized' } });
    return true;
  }
  const raw = await readBody(req);
  const parsed = parseJsonBody(raw);
  if (parsed === undefined) {
    // A body that is not JSON: HTTP 400 with JSON-RPC -32700.
    sendJson(res, ctx, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return true;
  }
  if (!isRecord(parsed) || typeof parsed.method !== 'string') {
    sendJson(res, ctx, 400, { jsonrpc: '2.0', id: isRecord(parsed) ? (parsed.id ?? null) : null, error: { code: -32600, message: 'Invalid Request' } });
    return true;
  }
  const id = parsed.id ?? null;
  const isNotification = parsed.id === undefined;
  const params = isRecord(parsed.params) ? parsed.params : {};
  const methodName = parsed.method;

  // Notifications (no id) get a 202 with no body.
  if (isNotification) {
    sendEmpty(res, ctx, 202);
    return true;
  }

  if (methodName === 'server/discover') {
    const serverInfo = { name: SERVER_NAME, version: SERVER_VERSION };
    sendJson(res, ctx, 200, rpcResult(id, {
      serverInfo,
      capabilities: { tools: {} },
      supportedVersions: [PREFERRED_REVISION],
      _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo },
    }));
    return true;
  }

  if (methodName === 'initialize') {
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : PREFERRED_REVISION;
    const negotiated = requested === PREFERRED_REVISION || requested === '2025-11-25' || requested === '2025-06-18' || requested === '2025-03-26' || requested === '2024-11-05'
      ? requested
      : '2025-11-25';
    sendJson(res, ctx, 200, rpcResult(id, {
      protocolVersion: negotiated,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    }));
    return true;
  }

  if (methodName === 'tools/list') {
    // The same tools array, byte for byte, on every call.
    const text = `{"jsonrpc":"2.0","id":${JSON.stringify(id)},"result":{"tools":${TOOLS_JSON}}}`;
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text), 'x-github-request-id': ctx.nextRequestId() });
    res.end(text);
    return true;
  }

  if (methodName === 'tools/call') {
    const toolName = typeof params.name === 'string' ? params.name : '';
    const args = isRecord(params.arguments) ? (params.arguments as Record<string, unknown>) : {};
    const tool = TOOLS.find((entry) => entry.name === toolName);
    if (tool === undefined) {
      sendJson(res, ctx, 200, rpcError(id, -32602, `unknown tool ${toolName}`));
      return true;
    }
    const missing = missingArgs(tool, args);
    if (missing.length > 0) {
      sendJson(res, ctx, 200, rpcError(id, -32602, `missing required argument(s): ${missing.join(', ')}`));
      return true;
    }
    const result = callTool(ctx, toolName, args);
    sendJson(res, ctx, 200, rpcResult(id, result));
    return true;
  }

  if (methodName === 'ping') {
    sendJson(res, ctx, 200, rpcResult(id, {}));
    return true;
  }

  sendJson(res, ctx, 200, rpcError(id, -32601, `method not found: ${methodName}`));
  return true;
}

export { nowIso, commentGlobalId };
