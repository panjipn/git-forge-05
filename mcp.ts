// Model Context Protocol over Streamable HTTP at /mcp (revision 2026-07-28,
// with the legacy initialize handshake as a fallback). Plain JSON responses.

import {
  VIEWER_LOGIN, FIXED_DATE, hashObject, buildCommit,
  type Repo, type Store, type Issue, type Pull,
} from './store.ts';

export const MCP_SERVER_NAME = 'git-forge';
export const MCP_SERVER_VERSION = '1.0.0';
export const MCP_SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required: string[];
  };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name' },
        description: { type: 'string', description: 'Repository description' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
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
    description: 'List issues in a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        state: { type: 'string', description: 'Issue state: open, closed, or all' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
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
    description: 'Merge a pull request with a squash commit onto its base branch.',
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

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.databaseId,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: 1000, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    created_at: FIXED_DATE,
    updated_at: FIXED_DATE,
    has_issues: true,
  };
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: repo.databaseId * 1_000_000 + issue.number,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((l) => ({ name: l.name, color: l.color })),
    comments: issue.comments.length,
    created_at: FIXED_DATE,
    updated_at: FIXED_DATE,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: repo.databaseId * 1_000_000 + pull.number,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    head: { label: `${repo.owner}:${pull.headRef}`, ref: pull.headRef, sha: pull.headSha },
    base: { label: `${repo.owner}:${pull.baseRef}`, ref: pull.baseRef, sha: pull.baseSha },
    merged: pull.merged,
    merge_commit_sha: pull.mergeCommitSha,
    merged_at: pull.mergedAt,
    created_at: FIXED_DATE,
    updated_at: FIXED_DATE,
  };
}

function toolResult(value: unknown): Record<string, unknown> {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return { content: [{ type: 'text', text }], structuredContent: value };
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function num(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return null;
}

export interface McpResult {
  status: number;
  body: unknown;
}

/** Handle one POST /mcp body (already parsed JSON, or null when unparsable). */
export function handleMcp(store: Store, body: unknown, rawIsJson: boolean): McpResult {
  if (!rawIsJson) {
    return {
      status: 400,
      body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
    };
  }
  const request = (body ?? {}) as Record<string, unknown>;
  const id = request.id === undefined ? null : request.id;
  const method = typeof request.method === 'string' ? request.method : '';
  const params = (request.params ?? {}) as Record<string, unknown>;

  const result = (value: unknown): McpResult => ({ status: 200, body: { jsonrpc: '2.0', id, result: value } });
  const error = (code: number, message: string): McpResult => ({ status: 200, body: { jsonrpc: '2.0', id, error: { code, message } } });

  // Notifications carry no id and get no JSON-RPC response.
  if (id === null && method.startsWith('notifications/')) {
    return { status: 202, body: null };
  }

  switch (method) {
    case 'server/discover': {
      return result({
        supportedVersions: MCP_SUPPORTED_VERSIONS,
        capabilities: { tools: {} },
        serverInfo: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
        _meta: {
          'io.modelcontextprotocol/serverInfo': { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
          'io.modelcontextprotocol/protocolVersion': MCP_SUPPORTED_VERSIONS[0],
        },
      });
    }
    case 'initialize': {
      const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const negotiated = MCP_SUPPORTED_VERSIONS.includes(offered) ? offered : '2025-11-25';
      return result({
        protocolVersion: negotiated,
        capabilities: { tools: {} },
        serverInfo: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
      });
    }
    case 'ping': {
      return result({});
    }
    case 'tools/list': {
      return result({ tools: TOOLS });
    }
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      const tool = TOOLS.find((t) => t.name === name);
      if (!tool) {
        return error(-32602, `Unknown tool: ${name}`);
      }
      const missing = tool.inputSchema.required.filter((key) => args[key] === undefined || args[key] === null || args[key] === '');
      if (missing.length > 0) {
        return result(toolError(`Missing required argument(s): ${missing.join(', ')}`));
      }
      return result(callTool(store, tool.name, args));
    }
    default:
      return error(-32601, `Method not found: ${method}`);
  }
}

function callTool(store: Store, name: string, args: Record<string, unknown>): Record<string, unknown> {
  switch (name) {
    case 'create_repo': {
      const repoName = str(args.name);
      if (repoName === null) return toolError('Missing required argument: name');
      const repo = store.createRepo(
        repoName,
        typeof args.description === 'string' ? args.description : '',
        args.private === true,
      );
      if (!repo) return toolError(`Repository already exists: ${repoName}`);
      return toolResult(repoJson(repo));
    }
    case 'get_repo': {
      const owner = str(args.owner);
      const repoName = str(args.repo);
      if (owner === null || repoName === null) return toolError('Missing required argument: owner or repo');
      const repo = store.getRepo(owner, repoName);
      if (!repo) return toolError(`Repository not found: ${owner}/${repoName}`);
      return toolResult(repoJson(repo));
    }
    case 'create_issue': {
      const owner = str(args.owner);
      const repoName = str(args.repo);
      const title = str(args.title);
      if (owner === null || repoName === null || title === null) return toolError('Missing required argument: owner, repo, or title');
      const repo = store.getRepo(owner, repoName);
      if (!repo) return toolError(`Repository not found: ${owner}/${repoName}`);
      const issue: Issue = {
        number: repo.nextNumber,
        title,
        body: typeof args.body === 'string' ? args.body : '',
        state: 'open',
        labels: [],
        comments: [],
        seq: repo.nextNumber,
        cachedJson: null,
      };
      repo.nextNumber += 1;
      repo.issues.push(issue);
      return toolResult(issueJson(repo, issue));
    }
    case 'list_issues': {
      const owner = str(args.owner);
      const repoName = str(args.repo);
      if (owner === null || repoName === null) return toolError('Missing required argument: owner or repo');
      const repo = store.getRepo(owner, repoName);
      if (!repo) return toolError(`Repository not found: ${owner}/${repoName}`);
      const state = typeof args.state === 'string' ? args.state.toLowerCase() : 'open';
      const list = state === 'all' ? [...repo.issues] : repo.issues.filter((i) => i.state === state);
      const issues = list.map((i) => issueJson(repo, i));
      return toolResult({ issues });
    }
    case 'create_pull_request': {
      const owner = str(args.owner);
      const repoName = str(args.repo);
      const title = str(args.title);
      const head = str(args.head);
      const base = str(args.base);
      if (owner === null || repoName === null || title === null || head === null || base === null) {
        return toolError('Missing required argument: owner, repo, title, head, or base');
      }
      const repo = store.getRepo(owner, repoName);
      if (!repo) return toolError(`Repository not found: ${owner}/${repoName}`);
      const headSha = repo.refs.get(`refs/heads/${head}`);
      const baseSha = repo.refs.get(`refs/heads/${base}`);
      if (!headSha || !baseSha) return toolError('Head or base branch not found');
      const pull: Pull = {
        number: repo.nextNumber,
        title,
        body: typeof args.body === 'string' ? args.body : '',
        headRef: head,
        baseRef: base,
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
      return toolResult(pullJson(repo, pull));
    }
    case 'merge_pull_request': {
      const owner = str(args.owner);
      const repoName = str(args.repo);
      const pullNumber = num(args.pull_number);
      if (owner === null || repoName === null || pullNumber === null) return toolError('Missing required argument: owner, repo, or pull_number');
      const repo = store.getRepo(owner, repoName);
      if (!repo) return toolError(`Repository not found: ${owner}/${repoName}`);
      const pull = repo.pulls.find((p) => p.number === pullNumber);
      if (!pull) return toolError(`Pull request not found: ${pullNumber}`);
      if (pull.state !== 'open') return toolError('Pull request is not open');
      const tree = store.squashTree(repo, pull);
      if (tree === null) return toolError('Merge conflict');
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
      return toolResult({ sha: mergeSha, merged: true, message, number: pull.number });
    }
    default:
      return toolError(`Unknown tool: ${name}`);
  }
}
