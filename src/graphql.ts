// graphql.ts — GitHub GraphQL v4 for the documents gh and github-mcp-server send.
// A small recursive-descent parser for the query language subset the suite uses
// (operations, variables, aliases, arguments, input objects, inline fragments)
// plus an executor over the same store as REST. Unknown fields answer HTTP 200
// with an errors array naming the field; an unknown repository is data.repository
// = null with no errors; a JSON array body answers batched results in order.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  VIEWER_LOGIN,
  nowIso,
  decodeGlobalId,
  repoGlobalId,
  commentGlobalId,
  type Repo,
  type Issue,
  type PullRequest,
} from './store.ts';
import {
  createIssueRecord,
  createPullRecord,
  squashMerge,
  pullMergeable,
} from './rest.ts';
import {
  sendJson,
  sendError,
  readBody,
  parseJsonBody,
  requireAuth,
  type ForgeCtx,
} from './util.ts';
import { diffTrees } from './store.ts';

// ---------------------------------------------------------------- parser

type Value =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: Value[] }
  | { kind: 'object'; fields: Array<{ name: string; value: Value }> };

interface FieldNode {
  kind: 'field';
  name: string;
  alias: string | null;
  args: Array<{ name: string; value: Value }>;
  selections: SelectionNode[] | null;
}

interface FragmentNode {
  kind: 'fragment';
  typeName: string;
  selections: SelectionNode[];
}

type SelectionNode = FieldNode | FragmentNode;

interface Operation {
  kind: 'query' | 'mutation';
  name: string | null;
  selections: SelectionNode[];
}

interface Token {
  kind: 'punct' | 'name' | 'int' | 'float' | 'string';
  value: string;
}

function tokenize(input: string): Token[] {
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
    if (ch === '.' && input.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('{}():!=$[]@'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < input.length && input[j] !== '"') {
        if (input[j] === '\\' && j + 1 < input.length) {
          const esc = input[j + 1] as string;
          if (esc === 'n') out += '\n';
          else if (esc === 't') out += '\t';
          else if (esc === 'r') out += '\r';
          else if (esc === '"') out += '"';
          else if (esc === '\\') out += '\\';
          else if (esc === '/') out += '/';
          else out += esc;
          j += 2;
        } else {
          out += input[j] as string;
          j += 1;
        }
      }
      if (j >= input.length) throw new Error('unterminated string in GraphQL query');
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      while (j < input.length && /[0-9.]/.test(input[j] as string)) j += 1;
      const text = input.slice(i, j);
      tokens.push({ kind: text.includes('.') ? 'float' : 'int', value: text });
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let j = i;
      while (j < input.length && /[_A-Za-z0-9]/.test(input[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: input.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL query`);
  }
  return tokens;
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const token = this.tokens[this.pos];
    if (token === undefined) throw new Error('unexpected end of GraphQL query');
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected ${value} in GraphQL query, got ${token.value}`);
  }

  private eatPunct(value: string): boolean {
    const token = this.peek();
    if (token !== undefined && token.kind === 'punct' && token.value === value) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  private expectName(what = 'a name'): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error(`expected ${what} in GraphQL query, got ${token.value}`);
    return token.value;
  }

  parseDocument(): Operation[] {
    const operations: Operation[] = [];
    while (this.peek() !== undefined) {
      operations.push(this.parseOperation());
    }
    if (operations.length === 0) throw new Error('empty GraphQL document');
    return operations;
  }

  private parseOperation(): Operation {
    let kind: 'query' | 'mutation' = 'query';
    const first = this.peek();
    if (first !== undefined && first.kind === 'name' && (first.value === 'query' || first.value === 'mutation')) {
      kind = this.next().value as 'query' | 'mutation';
    }
    let name: string | null = null;
    const maybeName = this.peek();
    if (maybeName !== undefined && maybeName.kind === 'name') {
      name = this.next().value;
    }
    // Variable definitions: ($x: Type = default, ...) — skipped, values come from `variables`.
    if (this.eatPunct('(')) {
      let depth = 1;
      while (depth > 0) {
        const token = this.next();
        if (token.kind === 'punct' && token.value === '(') depth += 1;
        else if (token.kind === 'punct' && token.value === ')') depth -= 1;
      }
    }
    const selections = this.parseSelectionSet();
    return { kind, name, selections };
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!(this.peek() !== undefined && this.peek()?.kind === 'punct' && this.peek()?.value === '}')) {
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): SelectionNode {
    const token = this.peek();
    if (token !== undefined && token.kind === 'punct' && token.value === '...') {
      this.next();
      const next = this.peek();
      if (next !== undefined && next.kind === 'name' && next.value === 'on') {
        this.next();
        const typeName = this.expectName('a type name after ... on');
        return { kind: 'fragment', typeName, selections: this.parseSelectionSet() };
      }
      throw new Error('named fragments are not supported');
    }
    const name = this.expectName('a field name');
    let alias: string | null = null;
    let fieldName = name;
    if (this.eatPunct(':')) {
      alias = name;
      fieldName = this.expectName('a field name after an alias');
    }
    const args: Array<{ name: string; value: Value }> = [];
    if (this.eatPunct('(')) {
      while (!(this.peek() !== undefined && this.peek()?.kind === 'punct' && this.peek()?.value === ')')) {
        const argName = this.expectName('an argument name');
        this.expectPunct(':');
        args.push({ name: argName, value: this.parseValue() });
      }
      this.expectPunct(')');
    }
    let selections: SelectionNode[] | null = null;
    const next = this.peek();
    if (next !== undefined && next.kind === 'punct' && next.value === '{') {
      selections = this.parseSelectionSet();
    }
    return { kind: 'field', name: fieldName, alias, args, selections };
  }

  private parseValue(): Value {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') {
      return { kind: 'variable', name: this.expectName('a variable name') };
    }
    if (token.kind === 'punct' && token.value === '[') {
      const values: Value[] = [];
      while (!(this.peek() !== undefined && this.peek()?.kind === 'punct' && this.peek()?.value === ']')) {
        values.push(this.parseValue());
      }
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: Value }> = [];
      while (!(this.peek() !== undefined && this.peek()?.kind === 'punct' && this.peek()?.value === '}')) {
        const name = this.expectName('an input field name');
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: Number(token.value) };
    if (token.kind === 'float') return { kind: 'float', value: Number(token.value) };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error(`unexpected value ${token.value} in GraphQL query`);
  }
}

// ---------------------------------------------------------------- schema

const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'url', 'createdAt', 'updatedAt', 'author', 'labels', 'comments'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'files', 'headRef', 'baseRef', 'createdAt', 'author'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'private', 'createdAt', 'url'],
  User: ['login', 'id', 'name'],
  SearchType: [],
};

const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
};

// ---------------------------------------------------------------- executor

interface ExecCtx {
  store: ForgeCtx['store'];
  variables: Record<string, unknown>;
  errors: Array<{ message: string }>;
}

type AnyObj = Record<string, unknown> & { __typename: string };

function resolveValue(value: Value, variables: Record<string, unknown>): unknown {
  switch (value.kind) {
    case 'variable':
      return variables[value.name] ?? null;
    case 'string':
      return value.value;
    case 'int':
    case 'float':
      return value.value;
    case 'boolean':
      return value.value;
    case 'null':
      return null;
    case 'enum':
      return value.value;
    case 'list':
      return value.values.map((entry) => resolveValue(entry, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of value.fields) out[field.name] = resolveValue(field.value, variables);
      return out;
    }
  }
}

function argValue(field: FieldNode, name: string, ctx: ExecCtx): unknown {
  const arg = field.args.find((entry) => entry.name === name);
  if (arg === undefined) return undefined;
  return resolveValue(arg.value, ctx.variables);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function encodeCursor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: unknown): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  try {
    const text = Buffer.from(cursor, 'base64url').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match === null ? null : Number(match[1]);
  } catch {
    return null;
  }
}

function repoObject(repo: Repo): AnyObj {
  return {
    __typename: 'Repository',
    __repo: repo,
    id: repoGlobalId(repo.owner, repo.name),
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`,
  };
}

function issueObject(repo: Repo, issue: Issue): AnyObj {
  return {
    __typename: 'Issue',
    __repo: repo,
    __issue: issue,
    id: issue.globalId,
    number: issue.number,
    title: issue.title,
    state: issue.state === 'open' ? 'OPEN' : 'CLOSED',
    body: issue.body,
  };
}

function pullObject(repo: Repo, pull: PullRequest): AnyObj {
  return {
    __typename: 'PullRequest',
    __repo: repo,
    __pull: pull,
    id: pull.globalId,
    number: pull.number,
    title: pull.title,
    state: pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED',
    merged: pull.merged,
    headRefName: pull.headRef,
    baseRefName: pull.baseRef,
    mergeable: pullMergeable(repo, pull) ? 'MERGEABLE' : 'CONFLICTING',
  };
}

function userObject(): AnyObj {
  return { __typename: 'User', login: VIEWER_LOGIN };
}

/** Execute one field against an object; returns null when the field errored. */
function executeField(parent: AnyObj, parentType: string, field: FieldNode, ctx: ExecCtx): unknown {
  const known = TYPE_FIELDS[parentType];
  if (parentType === 'Query' || parentType === 'Mutation') {
    // Root fields are validated by name below.
  } else if (known !== undefined && !known.includes(field.name)) {
    ctx.errors.push({ message: `Cannot query field "${field.name}" on type "${parentType}".` });
    return null;
  }
  switch (parentType) {
    case 'Query':
      return executeQueryField(field, ctx);
    case 'Mutation':
      return executeMutationField(field, ctx);
    case 'CreateIssuePayload':
    case 'CloseIssuePayload':
      if (field.name === 'issue') return parent.issue;
      break;
    case 'CreatePullRequestPayload':
    case 'MergePullRequestPayload':
      if (field.name === 'pullRequest') return parent.pullRequest;
      break;
    case 'AddCommentPayload':
      if (field.name === 'commentEdge') return parent.commentEdge;
      break;
    case 'IssueCommentEdge':
      if (field.name === 'node') return parent.node;
      break;
    case 'IssueComment':
      if (field.name === 'id' || field.name === 'body') return parent[field.name];
      break;
    case 'User':
      if (field.name === 'login') return parent.login;
      break;
    case 'Repository':
      return executeRepositoryField(parent, field, ctx);
    case 'Issue':
      if (['id', 'number', 'title', 'state', 'body'].includes(field.name)) return parent[field.name];
      break;
    case 'IssueConnection':
      if (field.name === 'nodes') return parent.nodes;
      if (field.name === 'pageInfo') return parent.pageInfo;
      break;
    case 'PageInfo':
      if (field.name === 'hasNextPage') return parent.hasNextPage;
      if (field.name === 'endCursor') return parent.endCursor;
      break;
    case 'PullRequest':
      if (['id', 'number', 'title', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable'].includes(field.name)) {
        return parent[field.name];
      }
      if (field.name === 'files') {
        const repo = parent.__repo as Repo;
        const pull = parent.__pull as PullRequest;
        const first = argValue(field, 'first', ctx);
        const changes = diffTrees(repo, pull.baseSha, pull.headSha);
        const nodes = changes.map((change) => ({ __typename: 'PullRequestChangedFile', path: change.filename }));
        const limited = typeof first === 'number' ? nodes.slice(0, first) : nodes;
        return { __typename: 'PullRequestChangedFileConnection', nodes: limited };
      }
      break;
    case 'PullRequestConnection':
      if (field.name === 'nodes') return parent.nodes;
      break;
    case 'PullRequestChangedFileConnection':
      if (field.name === 'nodes') return parent.nodes;
      break;
    case 'PullRequestChangedFile':
      if (field.name === 'path') return parent.path;
      break;
    case 'Ref':
      if (field.name === 'name') return parent.name;
      break;
    case '__Type':
      if (field.name === 'name') return parent.name;
      if (field.name === 'kind') return parent.kind;
      if (field.name === 'fields') return parent.fields;
      if (field.name === 'enumValues') return parent.enumValues;
      break;
    case '__Field':
      if (field.name === 'name') return parent.name;
      break;
    case '__EnumValue':
      if (field.name === 'name') return parent.name;
      break;
    default:
      break;
  }
  ctx.errors.push({ message: `Cannot query field "${field.name}" on type "${parentType}".` });
  return null;
}

function executeQueryField(field: FieldNode, ctx: ExecCtx): unknown {
  if (field.name === 'viewer') return userObject();
  if (field.name === 'repository') {
    const owner = argValue(field, 'owner', ctx);
    const name = argValue(field, 'name', ctx);
    if (typeof owner !== 'string' || typeof name !== 'string') return null;
    const repo = ctx.store.getRepo(owner, name);
    if (repo === undefined || repo.owner !== owner) return null;
    return repoObject(repo);
  }
  if (field.name === 'node') {
    const id = argValue(field, 'id', ctx);
    if (typeof id !== 'string') return null;
    const decoded = decodeGlobalId(id);
    if (decoded === null) return null;
    const repo = ctx.store.getRepo(decoded.owner, decoded.repo);
    if (repo === undefined) return null;
    if (decoded.kind === 'repo') return repoObject(repo);
    if (decoded.kind === 'issue') {
      const issue = repo.issues.find((entry) => entry.number === decoded.number);
      return issue === undefined ? null : issueObject(repo, issue);
    }
    if (decoded.kind === 'pull') {
      const pull = repo.pulls.find((entry) => entry.number === decoded.number);
      return pull === undefined ? null : pullObject(repo, pull);
    }
    return null;
  }
  if (field.name === '__type') {
    const name = argValue(field, 'name', ctx);
    if (typeof name !== 'string') return null;
    const fields = TYPE_FIELDS[name];
    const enums = ENUM_VALUES[name];
    if (fields === undefined && enums === undefined) return null;
    return {
      __typename: '__Type',
      name,
      kind: enums !== undefined ? 'ENUM' : 'OBJECT',
      fields: (fields ?? []).map((entry) => ({ __typename: '__Field', name: entry })),
      enumValues: (enums ?? []).map((entry) => ({ __typename: '__EnumValue', name: entry })),
    };
  }
  ctx.errors.push({ message: `Cannot query field "${field.name}" on type "Query".` });
  return null;
}

function executeMutationField(field: FieldNode, ctx: ExecCtx): unknown {
  const input = argValue(field, 'input', ctx);
  if (!isRecord(input)) {
    ctx.errors.push({ message: `Mutation ${field.name} needs an input object.` });
    return null;
  }
  if (field.name === 'createIssue') {
    const repoId = input.repositoryId;
    if (typeof repoId !== 'string') return null;
    const decoded = decodeGlobalId(repoId);
    if (decoded === null || decoded.kind !== 'repo') return null;
    const repo = ctx.store.getRepo(decoded.owner, decoded.repo);
    if (repo === undefined) return null;
    const title = typeof input.title === 'string' ? input.title : '';
    const body = typeof input.body === 'string' ? input.body : '';
    const issue = createIssueRecord(repo, title, body, []);
    return { __typename: 'CreateIssuePayload', issue: issueObject(repo, issue) };
  }
  if (field.name === 'closeIssue') {
    const issueId = input.issueId;
    if (typeof issueId !== 'string') return null;
    const decoded = decodeGlobalId(issueId);
    if (decoded === null || decoded.kind !== 'issue') return null;
    const repo = ctx.store.getRepo(decoded.owner, decoded.repo);
    if (repo === undefined) return null;
    const issue = repo.issues.find((entry) => entry.number === decoded.number);
    if (issue === undefined) return null;
    issue.state = 'closed';
    issue.updatedAt = nowIso();
    return { __typename: 'CloseIssuePayload', issue: issueObject(repo, issue) };
  }
  if (field.name === 'createPullRequest') {
    const repoId = input.repositoryId;
    if (typeof repoId !== 'string') return null;
    const decoded = decodeGlobalId(repoId);
    if (decoded === null || decoded.kind !== 'repo') return null;
    const repo = ctx.store.getRepo(decoded.owner, decoded.repo);
    if (repo === undefined) return null;
    const title = typeof input.title === 'string' ? input.title : '';
    const baseRefName = typeof input.baseRefName === 'string' ? input.baseRefName : '';
    const headRefName = typeof input.headRefName === 'string' ? input.headRefName : '';
    const pull = createPullRecord(repo, title, '', headRefName, baseRefName);
    if (pull === null) return null;
    return { __typename: 'CreatePullRequestPayload', pullRequest: pullObject(repo, pull) };
  }
  if (field.name === 'mergePullRequest') {
    const pullRequestId = input.pullRequestId;
    if (typeof pullRequestId !== 'string') return null;
    const decoded = decodeGlobalId(pullRequestId);
    if (decoded === null || decoded.kind !== 'pull') return null;
    const repo = ctx.store.getRepo(decoded.owner, decoded.repo);
    if (repo === undefined) return null;
    const pull = repo.pulls.find((entry) => entry.number === decoded.number);
    if (pull === undefined) return null;
    const sha = squashMerge(repo, pull);
    if (sha === null) {
      ctx.errors.push({ message: `Pull request #${pull.number} cannot be merged (conflict or already closed).` });
      return null;
    }
    return { __typename: 'MergePullRequestPayload', pullRequest: pullObject(repo, pull) };
  }
  if (field.name === 'addComment') {
    const subjectId = input.subjectId;
    if (typeof subjectId !== 'string') return null;
    const decoded = decodeGlobalId(subjectId);
    if (decoded === null || decoded.kind !== 'issue') return null;
    const repo = ctx.store.getRepo(decoded.owner, decoded.repo);
    if (repo === undefined) return null;
    const issue = repo.issues.find((entry) => entry.number === decoded.number);
    if (issue === undefined) return null;
    const body = typeof input.body === 'string' ? input.body : '';
    const commentId = repo.nextComment;
    const comment = {
      id: commentId,
      globalId: commentGlobalId(repo.owner, repo.name, issue.number, commentId),
      body,
      createdAt: nowIso(),
    };
    repo.nextComment += 1;
    issue.comments.push(comment);
    return {
      __typename: 'AddCommentPayload',
      commentEdge: { __typename: 'IssueCommentEdge', node: { __typename: 'IssueComment', id: comment.globalId, body } },
    };
  }
  ctx.errors.push({ message: `Cannot query field "${field.name}" on type "Mutation".` });
  return null;
}

function executeRepositoryField(parent: AnyObj, field: FieldNode, ctx: ExecCtx): unknown {
  const repo = parent.__repo as Repo;
  switch (field.name) {
    case 'id':
    case 'databaseId':
    case 'name':
    case 'nameWithOwner':
      return parent[field.name];
    case 'owner':
      return userObject();
    case 'defaultBranchRef': {
      const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      if (tip === undefined) return null;
      return { __typename: 'Ref', name: repo.defaultBranch };
    }
    case 'viewerPermission':
      return 'ADMIN';
    case 'hasIssuesEnabled':
      return true;
    case 'issue': {
      const number = argValue(field, 'number', ctx);
      if (typeof number !== 'number') return null;
      const issue = repo.issues.find((entry) => entry.number === number);
      return issue === undefined ? null : issueObject(repo, issue);
    }
    case 'issues': {
      const first = argValue(field, 'first', ctx);
      const states = argValue(field, 'states', ctx);
      const orderBy = argValue(field, 'orderBy', ctx);
      const after = argValue(field, 'after', ctx);
      let issues = [...repo.issues];
      if (Array.isArray(states)) {
        const wanted = new Set(states.map((entry) => String(entry)));
        issues = issues.filter((issue) => wanted.has(issue.state === 'open' ? 'OPEN' : 'CLOSED'));
      }
      let direction = 'ASC';
      if (isRecord(orderBy) && typeof orderBy.direction === 'string') direction = orderBy.direction;
      issues.sort((a, b) => (direction === 'DESC' ? b.number - a.number : a.number - b.number));
      const cursor = decodeCursor(after);
      if (cursor !== null) {
        issues = issues.filter((issue) => (direction === 'DESC' ? issue.number < cursor : issue.number > cursor));
      }
      const limit = typeof first === 'number' ? first : issues.length;
      const page = issues.slice(0, limit);
      const hasNextPage = issues.length > page.length;
      const endCursor = page.length > 0 ? encodeCursor(page[page.length - 1]?.number as number) : null;
      return {
        __typename: 'IssueConnection',
        nodes: page.map((issue) => issueObject(repo, issue)),
        pageInfo: { __typename: 'PageInfo', hasNextPage, endCursor },
      };
    }
    case 'pullRequests': {
      const first = argValue(field, 'first', ctx);
      const pulls = repo.pulls.filter((pull) => pull.state === 'open');
      const limited = typeof first === 'number' ? pulls.slice(0, first) : pulls;
      return {
        __typename: 'PullRequestConnection',
        nodes: limited.map((pull) => pullObject(repo, pull)),
      };
    }
    case 'pullRequest': {
      const number = argValue(field, 'number', ctx);
      if (typeof number !== 'number') return null;
      const pull = repo.pulls.find((entry) => entry.number === number);
      return pull === undefined ? null : pullObject(repo, pull);
    }
    default:
      break;
  }
  ctx.errors.push({ message: `Cannot query field "${field.name}" on type "Repository".` });
  return null;
}

/** Execute a selection set against an object; null when a child errored. */
function executeSelections(parent: AnyObj, parentType: string, selections: SelectionNode[], ctx: ExecCtx): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'fragment') {
      if (selection.typeName !== parentType) continue;
      const nested = executeSelections(parent, parentType, selection.selections, ctx);
      if (nested !== null) Object.assign(out, nested);
      continue;
    }
    const value = executeField(parent, parentType, selection, ctx);
    const key = selection.alias ?? selection.name;
    if (value !== null && selection.selections !== null && isRecord(value) && typeof (value as AnyObj).__typename === 'string') {
      out[key] = executeSelections(value as AnyObj, (value as AnyObj).__typename as string, selection.selections, ctx);
      continue;
    }
    if (value !== null && selection.selections !== null && isRecord(value) && (value as AnyObj).__typename === undefined) {
      // A payload object ({issue: ...}) whose nested object carries __typename.
      out[key] = executePayloadSelections(value as Record<string, unknown>, selection.selections, ctx);
      continue;
    }
    out[key] = value;
  }
  return out;
}

/** Execute selections inside a mutation payload (fields are plain values or objects). */
function executePayloadSelections(payload: Record<string, unknown>, selections: SelectionNode[], ctx: ExecCtx): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'fragment') continue;
    const key = selection.alias ?? selection.name;
    const value = payload[selection.name];
    if (value === undefined) {
      ctx.errors.push({ message: `Cannot query field "${selection.name}" on this payload.` });
      out[key] = null;
      continue;
    }
    if (value !== null && selection.selections !== null && isRecord(value) && typeof (value as AnyObj).__typename === 'string') {
      out[key] = executeSelections(value as AnyObj, (value as AnyObj).__typename as string, selection.selections, ctx);
      continue;
    }
    if (value !== null && selection.selections !== null && isRecord(value)) {
      out[key] = executePayloadSelections(value as Record<string, unknown>, selection.selections, ctx);
      continue;
    }
    out[key] = value;
  }
  return out;
}

function executeOperation(operation: Operation, ctx: ExecCtx): { data: Record<string, unknown>; errors: Array<{ message: string }> } {
  const rootType = operation.kind === 'mutation' ? 'Mutation' : 'Query';
  const root: AnyObj = { __typename: rootType };
  const data = executeSelections(root, rootType, operation.selections, ctx) ?? {};
  return { data, errors: ctx.errors };
}

function executeDocument(query: string, variables: Record<string, unknown>, ctx: ExecCtx): { data: Record<string, unknown> | null; errors: Array<{ message: string }> } {
  const operations = new Parser(tokenize(query)).parseDocument();
  const operation = operations[0] as Operation;
  return executeOperation(operation, ctx);
}

// ---------------------------------------------------------------- handler

export async function handleGraphQL(req: IncomingMessage, res: ServerResponse, ctx: ForgeCtx): Promise<boolean> {
  if (req.method !== 'POST') {
    sendError(res, ctx, 405, 'Method Not Allowed');
    return true;
  }
  if (!requireAuth(req, res, ctx)) return true;
  const raw = await readBody(req);
  const parsed = parseJsonBody(raw);
  if (parsed === undefined) {
    sendError(res, ctx, 400, 'Invalid JSON body');
    return true;
  }
  const runOne = (entry: unknown): Record<string, unknown> => {
    const execCtx: ExecCtx = { store: ctx.store, variables: {}, errors: [] };
    if (!isRecord(entry) || typeof entry.query !== 'string') {
      return { data: null, errors: [{ message: 'A GraphQL request needs a query string.' }] };
    }
    if (isRecord(entry.variables)) execCtx.variables = entry.variables as Record<string, unknown>;
    try {
      return executeDocument(entry.query, execCtx.variables, execCtx);
    } catch (err) {
      return { data: null, errors: [{ message: err instanceof Error ? err.message : 'GraphQL execution failed' }] };
    }
  };
  if (Array.isArray(parsed)) {
    sendJson(res, ctx, 200, parsed.map(runOne));
    return true;
  }
  sendJson(res, ctx, 200, runOne(parsed));
  return true;
}
