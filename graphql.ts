// A small GraphQL executor for exactly the documents gh / github-mcp-server send:
// queries, mutations, variables, aliases, inline fragments, batched operations.
// Unknown fields answer HTTP 200 with an `errors` array (never an HTTP error).

import { Buffer } from 'node:buffer';
import {
  VIEWER_LOGIN, FIXED_DATE,
  parseCommit, flattenTree, buildCommit, hashObject,
  repoGlobalId, issueGlobalId, pullGlobalId, commentGlobalId, decodeGlobalId,
  type Repo, type Store, type Issue, type Pull,
} from './store.ts';

// -------------------------------------------------------------------------------------------
// Tokenizer + parser
// -------------------------------------------------------------------------------------------

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'punct'; value: string }
  | { kind: 'eof' };

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) {
          const esc = src[j + 1] as string;
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          j += 2;
        } else {
          out += src[j] as string;
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch) && (ch !== '-' || /[0-9]/.test(src[i + 1] ?? ''))) {
      let j = i;
      let isFloat = false;
      if (src[j] === '-') j += 1;
      while (j < src.length && /[0-9]/.test(src[j] as string)) j += 1;
      if (src[j] === '.') {
        isFloat = true;
        j += 1;
        while (j < src.length && /[0-9]/.test(src[j] as string)) j += 1;
      }
      if (src[j] === 'e' || src[j] === 'E') {
        isFloat = true;
        j += 1;
        if (src[j] === '+' || src[j] === '-') j += 1;
        while (j < src.length && /[0-9]/.test(src[j] as string)) j += 1;
      }
      const num = Number(src.slice(i, j));
      tokens.push(isFloat ? { kind: 'float', value: num } : { kind: 'int', value: num });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: src.slice(i, j) });
      i = j;
      continue;
    }
    if (src.startsWith('...', i)) {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('{}():[]!=$@&|'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    i += 1; // skip anything else
  }
  tokens.push({ kind: 'eof' });
  return tokens;
}

export type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

export interface Selection {
  alias: string | null;
  name: string;
  args: Array<{ name: string; value: ValueNode }>;
  selections: Selection[] | null;
  fragmentType: string | null; // for inline fragments: the type condition
  isFragment: boolean;
}

export interface Operation {
  operationType: 'query' | 'mutation' | 'subscription';
  name: string | null;
  selections: Selection[];
}

class Parser {
  private tokens: Token[];
  private pos = 0;

  constructor(src: string) {
    this.tokens = tokenize(src);
  }

  private peek(): Token {
    return this.tokens[this.pos] as Token;
  }

  private next(): Token {
    const token = this.tokens[this.pos] as Token;
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected ${value}`);
  }

  private expectName(value?: string): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error('expected name');
    if (value !== undefined && token.value !== value) throw new Error(`expected ${value}`);
    return token.value;
  }

  parseDocument(): Operation[] {
    const operations: Operation[] = [];
    while (this.peek().kind !== 'eof') {
      operations.push(this.parseOperation());
    }
    return operations;
  }

  private parseOperation(): Operation {
    let operationType: Operation['operationType'] = 'query';
    let name: string | null = null;
    const token = this.peek();
    if (token.kind === 'punct' && token.value === '{') {
      return { operationType: 'query', name: null, selections: this.parseSelectionSet() };
    }
    if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation' || token.value === 'subscription')) {
      operationType = token.value as Operation['operationType'];
      this.next();
      const nextToken = this.peek();
      if (nextToken.kind === 'name') name = this.next().value as string;
    } else if (token.kind === 'name') {
      // A fragment definition or something unknown: skip to the next operation.
      throw new Error(`unsupported top-level ${token.value}`);
    }
    // Variable definitions.
    if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '(') {
      this.skipBalanced('(', ')');
    }
    // Directives.
    while (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '@') {
      this.next();
      this.expectName();
      if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '(') this.skipBalanced('(', ')');
    }
    return { operationType, name, selections: this.parseSelectionSet() };
  }

  private skipBalanced(open: string, close: string): void {
    this.expectPunct(open);
    let depth = 1;
    while (depth > 0) {
      const token = this.next();
      if (token.kind === 'eof') throw new Error('unbalanced');
      if (token.kind === 'punct' && token.value === open) depth += 1;
      if (token.kind === 'punct' && token.value === close) depth -= 1;
    }
  }

  private parseSelectionSet(): Selection[] {
    this.expectPunct('{');
    const selections: Selection[] = [];
    while (!(this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '}')) {
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): Selection {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === '...') {
      this.next();
      let fragmentType: string | null = null;
      const nextToken = this.peek();
      if (nextToken.kind === 'name' && nextToken.value === 'on') {
        this.next();
        fragmentType = this.expectName();
      } else if (nextToken.kind === 'name') {
        // Named fragment spread: not used by the suite; treat as an empty fragment.
        this.next();
      }
      // Directives on the fragment.
      while (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '@') {
        this.next();
        this.expectName();
        if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '(') this.skipBalanced('(', ')');
      }
      const selections = this.parseSelectionSet();
      return { alias: null, name: '', args: [], selections, fragmentType, isFragment: true };
    }
    let alias: string | null = null;
    let name = this.expectName();
    if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === ':') {
      this.next();
      alias = name;
      name = this.expectName();
    }
    const args: Array<{ name: string; value: ValueNode }> = [];
    if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '(') {
      this.next();
      while (!(this.peek().kind === 'punct' && (this.peek() as { value: string }).value === ')')) {
        const argName = this.expectName();
        this.expectPunct(':');
        args.push({ name: argName, value: this.parseValue() });
      }
      this.expectPunct(')');
    }
    // Directives.
    while (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '@') {
      this.next();
      this.expectName();
      if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '(') this.skipBalanced('(', ')');
    }
    let selections: Selection[] | null = null;
    if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '{') {
      selections = this.parseSelectionSet();
    }
    return { alias, name, args, selections, fragmentType: null, isFragment: false };
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') {
      return { kind: 'variable', name: this.expectName() };
    }
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: token.value };
    if (token.kind === 'float') return { kind: 'float', value: token.value };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (!(this.peek().kind === 'punct' && (this.peek() as { value: string }).value === ']')) {
        values.push(this.parseValue());
      }
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!(this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '}')) {
        const fieldName = this.expectName();
        this.expectPunct(':');
        fields.push({ name: fieldName, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    throw new Error(`unexpected value token ${JSON.stringify(token)}`);
  }
}

function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name] ?? null;
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((v) => resolveValue(v, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = resolveValue(field.value, variables);
      return out;
    }
  }
}

function argValue(sel: Selection, name: string, variables: Record<string, unknown>): unknown {
  const arg = sel.args.find((a) => a.name === name);
  if (!arg) return undefined;
  return resolveValue(arg.value, variables);
}

// -------------------------------------------------------------------------------------------
// Schema metadata (for __type introspection)
// -------------------------------------------------------------------------------------------

const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', '__type', '__schema'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest'],
  Issue: ['id', 'number', 'title', 'state', 'body', 'labels', 'comments', 'createdAt', 'updatedAt', 'url'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRef', 'baseRef', 'files', 'mergedAt', 'mergeCommit'],
  User: ['login', 'id', 'name', 'email'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFileConnection: ['nodes', 'edges', 'pageInfo'],
  PullRequestChangedFile: ['path', 'filename', 'additions', 'deletions', 'changes', 'status'],
  IssueComment: ['id', 'body', 'author'],
  IssueCommentEdge: ['node', 'cursor'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'endCursor', 'startCursor'],
  Ref: ['name'],
  __Type: ['name', 'fields', 'enumValues', 'kind', 'description'],
  __Field: ['name', 'description', 'args', 'type'],
  __EnumValue: ['name', 'description'],
  __InputValue: ['name', 'description', 'type'],
};

const TYPE_ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
};

// -------------------------------------------------------------------------------------------
// Execution
// -------------------------------------------------------------------------------------------

interface Ctx {
  store: Store;
  variables: Record<string, unknown>;
  errors: Array<{ message: string }>;
}

function mergeableOf(store: Store, repo: Repo, pull: Pull): string {
  if (pull.state !== 'open') return 'UNKNOWN';
  const tree = store.squashTree(repo, pull);
  return tree === null ? 'CONFLICTING' : 'MERGEABLE';
}

function diffPaths(store: Store, repo: Repo, pull: Pull): string[] {
  const lookup = (oid: string) => repo.objects.get(oid);
  const baseTree = pull.baseSha ? parseCommit(repo.objects.get(pull.baseSha)?.data ?? Buffer.alloc(0)).tree : '';
  const headTree = pull.headSha ? parseCommit(repo.objects.get(pull.headSha)?.data ?? Buffer.alloc(0)).tree : '';
  const fromBase = flattenTree(baseTree, lookup);
  const fromHead = flattenTree(headTree, lookup);
  const paths = new Set([...fromBase.keys(), ...fromHead.keys()]);
  const out: string[] = [];
  for (const path of [...paths].sort()) {
    if ((fromBase.get(path)?.oid ?? null) !== (fromHead.get(path)?.oid ?? null)) out.push(path);
  }
  return out;
}

function issueState(issue: Issue): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullState(pull: Pull): string {
  if (pull.state === 'open') return 'OPEN';
  return pull.merged ? 'MERGED' : 'CLOSED';
}

function resolveIssueFields(ctx: Ctx, repo: Repo, issue: Issue, selections: Selection[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of selections) {
    const key = sel.alias ?? sel.name;
    switch (sel.name) {
      case 'id':
        out[key] = issueGlobalId(repo, issue.number);
        break;
      case 'number':
        out[key] = issue.number;
        break;
      case 'title':
        out[key] = issue.title;
        break;
      case 'body':
        out[key] = issue.body;
        break;
      case 'state':
        out[key] = issueState(issue);
        break;
      case 'labels':
        out[key] = issue.labels.map((l) => ({ name: l.name, color: l.color }));
        break;
      case 'createdAt':
      case 'updatedAt':
        out[key] = FIXED_DATE;
        break;
      case 'url':
        out[key] = `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`;
        break;
      default:
        ctx.errors.push({ message: `Cannot query field "${sel.name}" on type "Issue".` });
        out[key] = null;
    }
  }
  return out;
}

function resolvePullFields(ctx: Ctx, repo: Repo, pull: Pull, selections: Selection[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of selections) {
    const key = sel.alias ?? sel.name;
    switch (sel.name) {
      case 'id':
        out[key] = pullGlobalId(repo, pull.number);
        break;
      case 'number':
        out[key] = pull.number;
        break;
      case 'title':
        out[key] = pull.title;
        break;
      case 'body':
        out[key] = pull.body;
        break;
      case 'state':
        out[key] = pullState(pull);
        break;
      case 'merged':
        out[key] = pull.merged;
        break;
      case 'mergeable':
        out[key] = mergeableOf(ctx.store, repo, pull);
        break;
      case 'headRefName':
        out[key] = pull.headRef;
        break;
      case 'baseRefName':
        out[key] = pull.baseRef;
        break;
      case 'mergedAt':
        out[key] = pull.mergedAt;
        break;
      case 'mergeCommit':
        out[key] = pull.mergeCommitSha ? { oid: pull.mergeCommitSha } : null;
        break;
      case 'files': {
        const first = argValue(sel, 'first', ctx.variables);
        const paths = diffPaths(ctx.store, repo, pull);
        const limited = typeof first === 'number' ? paths.slice(0, first) : paths;
        const nodes = limited.map((path) => ({ path, filename: path }));
        out[key] = resolveConnectionFields(ctx, nodes, sel.selections ?? [], 'PullRequestChangedFile');
        break;
      }
      default:
        ctx.errors.push({ message: `Cannot query field "${sel.name}" on type "PullRequest".` });
        out[key] = null;
    }
  }
  return out;
}

function resolveConnectionFields(ctx: Ctx, nodes: Array<Record<string, unknown>>, selections: Selection[], nodeType: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of selections) {
    const key = sel.alias ?? sel.name;
    if (sel.name === 'nodes') {
      out[key] = nodes.map((node) => resolveNodeFields(ctx, node, nodeType, sel.selections ?? []));
    } else if (sel.name === 'edges') {
      out[key] = nodes.map((node, i) => ({
        cursor: Buffer.from(`cursor:${i}`, 'utf8').toString('base64'),
        node: resolveNodeFields(ctx, node, nodeType, sel.selections?.find((s) => s.name === 'node')?.selections ?? []),
      }));
    } else if (sel.name === 'pageInfo') {
      out[key] = resolvePageInfo(ctx, nodes, sel.selections ?? []);
    } else if (sel.name === 'totalCount') {
      out[key] = nodes.length;
    } else {
      ctx.errors.push({ message: `Cannot query field "${sel.name}" on type "${nodeType}Connection".` });
      out[key] = null;
    }
  }
  return out;
}

function resolveNodeFields(ctx: Ctx, node: Record<string, unknown>, nodeType: string, selections: Selection[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const known = TYPE_FIELDS[nodeType] ?? [];
  for (const sel of selections) {
    const key = sel.alias ?? sel.name;
    if (known.includes(sel.name) && sel.name in node) {
      out[key] = node[sel.name];
    } else if (sel.name === 'path' || sel.name === 'filename') {
      out[key] = node.path ?? node.filename ?? null;
    } else {
      ctx.errors.push({ message: `Cannot query field "${sel.name}" on type "${nodeType}".` });
      out[key] = null;
    }
  }
  return out;
}

function resolvePageInfo(ctx: Ctx, nodes: Array<Record<string, unknown>>, selections: Selection[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of selections) {
    const key = sel.alias ?? sel.name;
    switch (sel.name) {
      case 'hasNextPage':
        out[key] = false;
        break;
      case 'hasPreviousPage':
        out[key] = false;
        break;
      case 'endCursor':
        out[key] = nodes.length ? Buffer.from(`cursor:${nodes.length - 1}`, 'utf8').toString('base64') : null;
        break;
      case 'startCursor':
        out[key] = nodes.length ? Buffer.from('cursor:0', 'utf8').toString('base64') : null;
        break;
      default:
        ctx.errors.push({ message: `Cannot query field "${sel.name}" on type "PageInfo".` });
        out[key] = null;
    }
  }
  return out;
}

function resolveRepositoryFields(ctx: Ctx, repo: Repo, selections: Selection[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of selections) {
    const key = sel.alias ?? sel.name;
    switch (sel.name) {
      case 'id':
        out[key] = repoGlobalId(repo);
        break;
      case 'databaseId':
        out[key] = repo.databaseId;
        break;
      case 'name':
        out[key] = repo.name;
        break;
      case 'nameWithOwner':
        out[key] = `${repo.owner}/${repo.name}`;
        break;
      case 'owner':
        out[key] = resolveUserFields(ctx, sel.selections ?? []);
        break;
      case 'defaultBranchRef':
        out[key] = { name: repo.defaultBranch };
        break;
      case 'viewerPermission':
        out[key] = 'ADMIN';
        break;
      case 'hasIssuesEnabled':
        out[key] = true;
        break;
      case 'issue': {
        const number = argValue(sel, 'number', ctx.variables);
        const issue = typeof number === 'number' ? repo.issues.find((i) => i.number === number) : undefined;
        out[key] = issue ? resolveIssueFields(ctx, repo, issue, sel.selections ?? []) : null;
        break;
      }
      case 'issues': {
        const first = argValue(sel, 'first', ctx.variables) as number | undefined;
        const after = argValue(sel, 'after', ctx.variables) as string | null | undefined;
        const states = argValue(sel, 'states', ctx.variables) as string[] | undefined;
        const orderBy = argValue(sel, 'orderBy', ctx.variables) as { field?: string; direction?: string } | undefined;
        let list = [...repo.issues];
        if (Array.isArray(states) && states.length > 0) {
          const wanted = new Set(states.map((s) => String(s).toLowerCase()));
          list = list.filter((i) => wanted.has(i.state));
        }
        const direction = orderBy?.direction ?? 'DESC';
        list.sort((a, b) => (direction === 'ASC' ? a.number - b.number : b.number - a.number));
        let startIndex = 0;
        if (typeof after === 'string' && after.length > 0) {
          try {
            const decoded = Buffer.from(after, 'base64').toString('utf8');
            const afterNumber = Number(decoded.split(':')[1]);
            if (Number.isFinite(afterNumber)) {
              const idx = list.findIndex((i) => i.number === afterNumber);
              if (idx >= 0) startIndex = idx + 1;
            }
          } catch {
            // fall through with startIndex 0
          }
        }
        const sliced = typeof first === 'number' ? list.slice(startIndex, startIndex + first) : list.slice(startIndex);
        const hasNextPage = startIndex + sliced.length < list.length;
        const endCursor = sliced.length > 0 ? Buffer.from(`cursor:${(sliced[sliced.length - 1] as Issue).number}`, 'utf8').toString('base64') : null;
        const nodes = sliced.map((issue) => resolveIssueFields(ctx, repo, issue, (sel.selections ?? []).find((s) => s.name === 'nodes')?.selections ?? []));
        const conn: Record<string, unknown> = {};
        for (const sub of sel.selections ?? []) {
          const subKey = sub.alias ?? sub.name;
          if (sub.name === 'nodes') conn[subKey] = nodes;
          else if (sub.name === 'pageInfo') {
            const info: Record<string, unknown> = {};
            for (const field of sub.selections ?? []) {
              const fieldKey = field.alias ?? field.name;
              if (field.name === 'hasNextPage') info[fieldKey] = hasNextPage;
              else if (field.name === 'endCursor') info[fieldKey] = endCursor;
              else if (field.name === 'hasPreviousPage') info[fieldKey] = startIndex > 0;
              else if (field.name === 'startCursor') info[fieldKey] = sliced.length > 0 ? Buffer.from(`cursor:${(sliced[0] as Issue).number}`, 'utf8').toString('base64') : null;
              else info[fieldKey] = null;
            }
            conn[subKey] = info;
          } else if (sub.name === 'totalCount') {
            conn[subKey] = list.length;
          } else {
            ctx.errors.push({ message: `Cannot query field "${sub.name}" on type "IssueConnection".` });
            conn[subKey] = null;
          }
        }
        out[key] = conn;
        break;
      }
      case 'pullRequests': {
        const first = argValue(sel, 'first', ctx.variables) as number | undefined;
        let list = [...repo.pulls].sort((a, b) => b.number - a.number);
        if (typeof first === 'number') list = list.slice(0, first);
        const nodes = list.map((pull) => resolvePullFields(ctx, repo, pull, (sel.selections ?? []).find((s) => s.name === 'nodes')?.selections ?? []));
        const conn: Record<string, unknown> = {};
        for (const sub of sel.selections ?? []) {
          const subKey = sub.alias ?? sub.name;
          if (sub.name === 'nodes') conn[subKey] = nodes;
          else if (sub.name === 'pageInfo') conn[subKey] = { hasNextPage: false, endCursor: null };
          else if (sub.name === 'totalCount') conn[subKey] = list.length;
          else conn[subKey] = null;
        }
        out[key] = conn;
        break;
      }
      case 'pullRequest': {
        const number = argValue(sel, 'number', ctx.variables);
        const pull = typeof number === 'number' ? repo.pulls.find((p) => p.number === number) : undefined;
        out[key] = pull ? resolvePullFields(ctx, repo, pull, sel.selections ?? []) : null;
        break;
      }
      default:
        ctx.errors.push({ message: `Cannot query field "${sel.name}" on type "Repository".` });
        out[key] = null;
    }
  }
  return out;
}

function resolveUserFields(ctx: Ctx, selections: Selection[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of selections) {
    const key = sel.alias ?? sel.name;
    switch (sel.name) {
      case 'login':
        out[key] = VIEWER_LOGIN;
        break;
      case 'id':
        out[key] = 1000;
        break;
      case 'name':
        out[key] = 'ada iversen';
        break;
      case 'email':
        out[key] = `${VIEWER_LOGIN}@example.invalid`;
        break;
      default:
        ctx.errors.push({ message: `Cannot query field "${sel.name}" on type "User".` });
        out[key] = null;
    }
  }
  return out;
}

function resolveTypeFields(ctx: Ctx, typeName: string, selections: Selection[]): Record<string, unknown> | null {
  const fields = TYPE_FIELDS[typeName];
  const enumValues = TYPE_ENUM_VALUES[typeName];
  if (!fields && !enumValues) return null;
  const out: Record<string, unknown> = {};
  for (const sel of selections) {
    const key = sel.alias ?? sel.name;
    if (sel.name === 'fields') {
      out[key] = (fields ?? []).map((name) => ({ name }));
    } else if (sel.name === 'enumValues') {
      out[key] = (enumValues ?? []).map((name) => ({ name }));
    } else if (sel.name === 'name') {
      out[key] = typeName;
    } else if (sel.name === 'kind') {
      out[key] = enumValues ? 'ENUM' : 'OBJECT';
    } else {
      out[key] = null;
    }
  }
  return out;
}

function resolveNode(ctx: Ctx, id: string, selections: Selection[]): Record<string, unknown> | null {
  const decoded = decodeGlobalId(id);
  if (!decoded) return null;
  if (decoded.kind === 'Repository') {
    const repo = [...ctx.store.repos.values()].find((r) => r.databaseId === decoded.databaseId);
    if (!repo) return null;
    const out: Record<string, unknown> = { id };
    for (const sel of selections) {
      if (sel.isFragment) {
        if (sel.fragmentType === 'Repository' || sel.fragmentType === null) {
          Object.assign(out, resolveRepositoryFields(ctx, repo, sel.selections ?? []));
        }
        continue;
      }
      const key = sel.alias ?? sel.name;
      if (sel.name === 'id') out[key] = id;
      else {
        ctx.errors.push({ message: `Cannot query field "${sel.name}" on type "Node".` });
        out[key] = null;
      }
    }
    return out;
  }
  if (decoded.kind === 'Issue') {
    const repo = [...ctx.store.repos.values()].find((r) => r.databaseId === decoded.databaseId);
    const issue = repo?.issues.find((i) => i.number === decoded.number);
    if (!repo || !issue) return null;
    const out: Record<string, unknown> = { id };
    for (const sel of selections) {
      if (sel.isFragment) {
        if (sel.fragmentType === 'Issue' || sel.fragmentType === null) {
          Object.assign(out, resolveIssueFields(ctx, repo, issue, sel.selections ?? []));
        }
        continue;
      }
      const key = sel.alias ?? sel.name;
      if (sel.name === 'id') out[key] = id;
      else out[key] = null;
    }
    return out;
  }
  return null;
}

function executeQuery(ctx: Ctx, op: Operation): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  for (const sel of op.selections) {
    if (sel.isFragment) continue;
    const key = sel.alias ?? sel.name;
    switch (sel.name) {
      case 'viewer':
        data[key] = resolveUserFields(ctx, sel.selections ?? []);
        break;
      case 'repository': {
        const owner = argValue(sel, 'owner', ctx.variables) as string | undefined;
        const name = argValue(sel, 'name', ctx.variables) as string | undefined;
        const repo = owner !== undefined && name !== undefined ? ctx.store.getRepo(owner, name) : undefined;
        data[key] = repo ? resolveRepositoryFields(ctx, repo, sel.selections ?? []) : null;
        break;
      }
      case 'node': {
        const id = argValue(sel, 'id', ctx.variables) as string | undefined;
        data[key] = typeof id === 'string' ? resolveNode(ctx, id, sel.selections ?? []) : null;
        break;
      }
      case '__type': {
        const name = argValue(sel, 'name', ctx.variables) as string | undefined;
        data[key] = typeof name === 'string' ? resolveTypeFields(ctx, name, sel.selections ?? []) : null;
        break;
      }
      case '__schema':
        data[key] = { queryType: { name: 'Query' }, mutationType: { name: 'Mutation' } };
        break;
      default:
        ctx.errors.push({ message: `Cannot query field "${sel.name}" on type "Query".` });
        data[key] = null;
    }
  }
  return data;
}

function findRepoByGlobalId(store: Store, id: string): Repo | null {
  const decoded = decodeGlobalId(id);
  if (!decoded || decoded.kind !== 'Repository') return null;
  return [...store.repos.values()].find((r) => r.databaseId === decoded.databaseId) ?? null;
}

function findIssueByGlobalId(store: Store, id: string): { repo: Repo; issue: Issue } | null {
  const decoded = decodeGlobalId(id);
  if (!decoded || decoded.kind !== 'Issue') return null;
  const repo = [...store.repos.values()].find((r) => r.databaseId === decoded.databaseId);
  const issue = repo?.issues.find((i) => i.number === decoded.number);
  if (!repo || !issue) return null;
  return { repo, issue };
}

function findPullByGlobalId(store: Store, id: string): { repo: Repo; pull: Pull } | null {
  const decoded = decodeGlobalId(id);
  if (!decoded || decoded.kind !== 'PullRequest') return null;
  const repo = [...store.repos.values()].find((r) => r.databaseId === decoded.databaseId);
  const pull = repo?.pulls.find((p) => p.number === decoded.number);
  if (!repo || !pull) return null;
  return { repo, pull };
}

function executeMutation(ctx: Ctx, op: Operation): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  for (const sel of op.selections) {
    if (sel.isFragment) continue;
    const key = sel.alias ?? sel.name;
    const input = argValue(sel, 'input', ctx.variables) as Record<string, unknown> | undefined;
    switch (sel.name) {
      case 'createIssue': {
        const repositoryId = typeof input?.repositoryId === 'string' ? input.repositoryId : '';
        const repo = findRepoByGlobalId(ctx.store, repositoryId);
        if (!repo) {
          ctx.errors.push({ message: 'Repository not found.' });
          data[key] = null;
          break;
        }
        const issue: Issue = {
          number: repo.nextNumber,
          title: typeof input?.title === 'string' ? input.title : '',
          body: typeof input?.body === 'string' ? input.body : '',
          state: 'open',
          labels: [],
          comments: [],
          seq: repo.nextNumber,
          cachedJson: null,
        };
        repo.nextNumber += 1;
        repo.issues.push(issue);
        const issueSel = sel.selections?.find((s) => s.name === 'issue');
        data[key] = {
          issue: issueSel ? resolveIssueFields(ctx, repo, issue, issueSel.selections ?? []) : { number: issue.number, id: issueGlobalId(repo, issue.number) },
        };
        break;
      }
      case 'closeIssue': {
        const issueId = typeof input?.issueId === 'string' ? input.issueId : '';
        const found = findIssueByGlobalId(ctx.store, issueId);
        if (!found) {
          ctx.errors.push({ message: 'Issue not found.' });
          data[key] = null;
          break;
        }
        found.issue.state = 'closed';
        found.issue.cachedJson = null;
        const issueSel = sel.selections?.find((s) => s.name === 'issue');
        data[key] = {
          issue: issueSel ? resolveIssueFields(ctx, found.repo, found.issue, issueSel.selections ?? []) : { number: found.issue.number, id: issueGlobalId(found.repo, found.issue.number), state: 'CLOSED' },
        };
        break;
      }
      case 'createPullRequest': {
        const repositoryId = typeof input?.repositoryId === 'string' ? input.repositoryId : '';
        const repo = findRepoByGlobalId(ctx.store, repositoryId);
        const headRefName = typeof input?.headRefName === 'string' ? input.headRefName : '';
        const baseRefName = typeof input?.baseRefName === 'string' ? input.baseRefName : repo?.defaultBranch ?? 'main';
        const title = typeof input?.title === 'string' ? input.title : '';
        const body = typeof input?.body === 'string' ? input.body : '';
        if (!repo) {
          ctx.errors.push({ message: 'Repository not found.' });
          data[key] = null;
          break;
        }
        const headSha = repo.refs.get(`refs/heads/${headRefName}`);
        const baseSha = repo.refs.get(`refs/heads/${baseRefName}`);
        if (!headSha || !baseSha) {
          ctx.errors.push({ message: 'Head or base branch not found.' });
          data[key] = null;
          break;
        }
        const pull: Pull = {
          number: repo.nextNumber,
          title,
          body,
          headRef: headRefName,
          baseRef: baseRefName,
          headSha,
          baseSha,
          state: 'open',
          merged: false,
          mergeCommitSha: null,
          mergedAt: null,
          seq: repo.nextNumber,
        };
        repo.nextNumber += 1;
        repo.pulls.push(pull);
        const pullSel = sel.selections?.find((s) => s.name === 'pullRequest');
        data[key] = {
          pullRequest: pullSel ? resolvePullFields(ctx, repo, pull, pullSel.selections ?? []) : { number: pull.number, id: pullGlobalId(repo, pull.number) },
        };
        break;
      }
      case 'mergePullRequest': {
        const pullRequestId = typeof input?.pullRequestId === 'string' ? input.pullRequestId : '';
        const found = findPullByGlobalId(ctx.store, pullRequestId);
        if (!found) {
          ctx.errors.push({ message: 'Pull request not found.' });
          data[key] = null;
          break;
        }
        const { repo, pull } = found;
        if (pull.state !== 'open') {
          ctx.errors.push({ message: 'Pull request is not open.' });
          data[key] = null;
          break;
        }
        const tree = ctx.store.squashTree(repo, pull);
        if (tree === null) {
          ctx.errors.push({ message: 'Merge conflict.' });
          data[key] = null;
          break;
        }
        const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`) as string;
        const message = `Merge pull request #${pull.number} from ${pull.headRef}`;
        const commitData = buildCommit(tree, [baseTip], message);
        const mergeSha = hashObject('commit', commitData);
        if (!repo.objects.has(mergeSha)) repo.objects.set(mergeSha, { type: 'commit', data: commitData });
        repo.refs.set(`refs/heads/${pull.baseRef}`, mergeSha);
        pull.state = 'closed';
        pull.merged = true;
        pull.mergeCommitSha = mergeSha;
        pull.mergedAt = FIXED_DATE;
        const pullSel = sel.selections?.find((s) => s.name === 'pullRequest');
        data[key] = {
          pullRequest: pullSel ? resolvePullFields(ctx, repo, pull, pullSel.selections ?? []) : { number: pull.number, merged: true },
        };
        break;
      }
      case 'addComment': {
        const subjectId = typeof input?.subjectId === 'string' ? input.subjectId : '';
        const body = typeof input?.body === 'string' ? input.body : '';
        const found = findIssueByGlobalId(ctx.store, subjectId);
        if (!found) {
          ctx.errors.push({ message: 'Subject not found.' });
          data[key] = null;
          break;
        }
        const comment = { id: found.repo.nextCommentId, body };
        found.repo.nextCommentId += 1;
        found.issue.comments.push(comment);
        found.issue.cachedJson = null;
        const edgeSel = sel.selections?.find((s) => s.name === 'commentEdge');
        const nodeSel = edgeSel?.selections?.find((s) => s.name === 'node');
        data[key] = {
          commentEdge: {
            node: nodeSel
              ? { id: commentGlobalId(found.repo, comment.id), body: comment.body }
              : { id: commentGlobalId(found.repo, comment.id), body: comment.body },
          },
        };
        break;
      }
      default:
        ctx.errors.push({ message: `Cannot query field "${sel.name}" on type "Mutation".` });
        data[key] = null;
    }
  }
  return data;
}

export interface GraphQLResult {
  status: number;
  body: unknown;
}

/** Execute one GraphQL request body (single operation or a batch array). */
export function handleGraphQL(store: Store, body: unknown): GraphQLResult {
  const runOne = (item: unknown): Record<string, unknown> => {
    const record = (item ?? {}) as Record<string, unknown>;
    const query = typeof record.query === 'string' ? record.query : '';
    const variables = (record.variables ?? {}) as Record<string, unknown>;
    const ctx: Ctx = { store, variables, errors: [] };
    let data: Record<string, unknown> | null = null;
    try {
      const parser = new Parser(query);
      const operations = parser.parseDocument();
      const op = operations[0];
      if (!op) {
        ctx.errors.push({ message: 'No operation provided.' });
      } else if (op.operationType === 'mutation') {
        data = executeMutation(ctx, op);
      } else {
        data = executeQuery(ctx, op);
      }
    } catch (err) {
      ctx.errors.push({ message: err instanceof Error ? err.message : 'parse error' });
      data = null;
    }
    const out: Record<string, unknown> = {};
    if (data !== null || ctx.errors.length === 0) out.data = data;
    if (ctx.errors.length > 0) out.errors = ctx.errors;
    if (data === null && ctx.errors.length === 0) out.data = null;
    return out;
  };
  if (Array.isArray(body)) {
    return { status: 200, body: body.map(runOne) };
  }
  return { status: 200, body: runOne(body) };
}
