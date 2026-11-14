// GitHub REST v3 surface under /api/v3.

import { Buffer } from 'node:buffer';
import {
  VIEWER_LOGIN, VIEWER_NAME, VIEWER_EMAIL, FIXED_DATE, ZERO_OID,
  parseCommit, parseTree, flattenTree, buildCommit, hashObject,
  repoGlobalId, type Repo, type Store, type Issue, type Pull,
} from './store.ts';

export interface RestContext {
  store: Store;
  token: string; // the expected bearer token ('' = any non-empty bearer)
}

export interface RestResult {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
  /** Pre-serialized JSON body: when set, the caller sends this string verbatim instead of
   * stringifying `body` again (the single-issue GET hot path caches its own serialization). */
  rawJson?: string;
}

const noContent: RestResult = { status: 204, body: null };

function ok(body: unknown, status = 200, headers?: Record<string, string>): RestResult {
  return { status, body, headers };
}

function err(status: number, message: string): RestResult {
  return { status, body: { message } };
}

export function checkAuth(ctx: RestContext, authHeader: string | undefined): boolean {
  if (!authHeader || !authHeader.startsWith('Bearer ')) return false;
  const presented = authHeader.slice(7);
  if (presented.length === 0) return false;
  if (ctx.token) return presented === ctx.token;
  return true;
}

function decodePathSegments(raw: string): string[] {
  return raw.split('/').map((s) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  });
}

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.databaseId,
    node_id: repoGlobalId(repo),
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
    pushed_at: FIXED_DATE,
    has_issues: true,
    has_projects: false,
    has_wiki: false,
    has_pages: false,
    has_downloads: true,
    archived: false,
    disabled: false,
    visibility: repo.private ? 'private' : 'public',
    forks_count: 0,
    stargazers_count: 0,
    watchers_count: 0,
    open_issues_count: repo.issues.filter((i) => i.state === 'open').length,
    license: null,
    topics: [],
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
  };
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: repo.databaseId * 1_000_000 + issue.number,
    node_id: `I_${repo.databaseId}_${issue.number}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    locked: false,
    user: { login: VIEWER_LOGIN, id: 1000, type: 'User' },
    labels: issue.labels.map((l) => ({ name: l.name, color: l.color, description: '' })),
    assignees: [],
    comments: issue.comments.length,
    created_at: FIXED_DATE,
    updated_at: FIXED_DATE,
    closed_at: issue.state === 'closed' ? FIXED_DATE : null,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    repository_url: `/api/v3/repos/${repo.owner}/${repo.name}`,
  };
}

/** The issue's JSON body as a string, cached on the issue and cleared by every mutation
 * (PATCH, comment add). The read workload GETs one unchanged issue 2,000 times, so the
 * serialization is done once instead of per request; the cache never reaches the state export. */
function issueJsonString(repo: Repo, issue: Issue): string {
  // Defensive: any Issue built without the field (older literal) is treated as uncached.
  if (typeof issue.cachedJson === 'string') return issue.cachedJson;
  // The trailing newline matches what sendJson appends to every JSON body.
  const text = `${JSON.stringify(issueJson(repo, issue))}\n`;
  issue.cachedJson = text;
  return text;
}

function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: repo.databaseId * 1_000_000 + pull.number,
    node_id: `PR_${repo.databaseId}_${pull.number}`,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    locked: false,
    user: { login: VIEWER_LOGIN, id: 1000, type: 'User' },
    head: { label: `${repo.owner}:${pull.headRef}`, ref: pull.headRef, sha: pull.headSha },
    base: { label: `${repo.owner}:${pull.baseRef}`, ref: pull.baseRef, sha: pull.baseSha },
    merged: pull.merged,
    mergeable: null,
    merge_commit_sha: pull.mergeCommitSha,
    merged_at: pull.mergedAt,
    closed_at: pull.state === 'closed' ? FIXED_DATE : null,
    created_at: FIXED_DATE,
    updated_at: FIXED_DATE,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    draft: false,
  };
}

/** Paginate a list; returns the page plus a Link header value (or null). */
function paginate<T>(items: readonly T[], query: URLSearchParams, basePath: string, host: string): { page: T[]; link: string | null } {
  const perPage = Math.max(1, Math.min(100, Number(query.get('per_page') ?? '30') || 30));
  const pageNum = Math.max(1, Number(query.get('page') ?? '1') || 1);
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const start = (pageNum - 1) * perPage;
  const page = items.slice(start, start + perPage);
  const links: string[] = [];
  const urlFor = (page: number): string => {
    const q = new URLSearchParams(query);
    q.set('per_page', String(perPage));
    q.set('page', String(page));
    return `http://${host}${basePath}?${q.toString()}`;
  };
  if (pageNum < totalPages) links.push(`<${urlFor(pageNum + 1)}>; rel="next"`);
  if (pageNum > 1) links.push(`<${urlFor(pageNum - 1)}>; rel="prev"`);
  links.push(`<${urlFor(1)}>; rel="first"`);
  links.push(`<${urlFor(totalPages)}>; rel="last"`);
  return { page, link: links.length ? links.join(', ') : null };
}

function diffFiles(repo: Repo, baseSha: string, headSha: string): Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> {
  const lookup = (oid: string) => repo.objects.get(oid);
  const baseTree = baseSha ? parseCommit(repo.objects.get(baseSha)?.data ?? Buffer.alloc(0)).tree : '';
  const headTree = headSha ? parseCommit(repo.objects.get(headSha)?.data ?? Buffer.alloc(0)).tree : '';
  const fromBase = flattenTree(baseTree, lookup);
  const fromHead = flattenTree(headTree, lookup);
  const out: Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> = [];
  const paths = new Set([...fromBase.keys(), ...fromHead.keys()]);
  for (const path of [...paths].sort()) {
    const a = fromBase.get(path);
    const b = fromHead.get(path);
    if (a?.oid === b?.oid) continue;
    const aData = a ? repo.objects.get(a.oid)?.data.toString('utf8') ?? '' : '';
    const bData = b ? repo.objects.get(b.oid)?.data.toString('utf8') ?? '' : '';
    const aLines = aData === '' ? [] : aData.split('\n');
    const bLines = bData === '' ? [] : bData.split('\n');
    let additions = 0;
    let deletions = 0;
    if (!a) {
      additions = bLines.filter((l) => l.length > 0).length || bLines.length;
    } else if (!b) {
      deletions = aLines.filter((l) => l.length > 0).length || aLines.length;
    } else {
      // Simple line multiset diff.
      const aCount = new Map<string, number>();
      for (const l of aLines) aCount.set(l, (aCount.get(l) ?? 0) + 1);
      const bCount = new Map<string, number>();
      for (const l of bLines) bCount.set(l, (bCount.get(l) ?? 0) + 1);
      for (const [line, n] of bCount) additions += Math.max(0, n - (aCount.get(line) ?? 0));
      for (const [line, n] of aCount) deletions += Math.max(0, n - (bCount.get(line) ?? 0));
      if (additions === 0 && deletions === 0) {
        additions = 1;
      }
    }
    out.push({
      filename: path,
      status: !a ? 'added' : !b ? 'removed' : 'modified',
      additions,
      deletions,
      changes: additions + deletions,
    });
  }
  return out;
}

/**
 * Handle one REST request. `segments` are the decoded path segments after `/api/v3`.
 * Returns null when the route is not a REST route at all (caller answers 404).
 */
export function handleRest(
  ctx: RestContext,
  method: string,
  segments: string[],
  query: URLSearchParams,
  body: unknown,
  bodyWasMalformed: boolean,
  host: string,
): RestResult | null {
  const { store } = ctx;
  const basePath = `/api/v3/${segments.map((s) => encodeURIComponent(s)).join('/')}`;

  // Malformed JSON bodies are 400 on any route that carries one.
  if (bodyWasMalformed) return err(400, 'malformed JSON body');

  // API root and meta.
  if (segments.length === 0 || (segments.length === 1 && segments[0] === '')) {
    if (method !== 'GET') return err(404, 'Not Found');
    return ok(
      { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' },
      200,
      { 'x-oauth-scopes': 'repo, read:org' },
    );
  }
  if (segments.length === 1 && segments[0] === 'meta') {
    if (method !== 'GET') return err(404, 'Not Found');
    return ok({ installed_version: '1.0.0', installed_at: FIXED_DATE });
  }

  // GET /user (the token owner's login; used by MCP setup).
  if (segments.length === 1 && segments[0] === 'user') {
    if (method !== 'GET') return err(404, 'Not Found');
    return ok({ login: VIEWER_LOGIN, id: 1000, type: 'User', name: VIEWER_NAME, email: VIEWER_EMAIL });
  }

  // POST /user/repos and GET /user/repos.
  if (segments.length === 2 && segments[0] === 'user' && segments[1] === 'repos') {
    if (method === 'POST') {
      const input = (body ?? {}) as Record<string, unknown>;
      const name = typeof input.name === 'string' ? input.name : '';
      if (!name) return err(422, 'name is required');
      const repo = store.createRepo(
        name,
        typeof input.description === 'string' ? input.description : '',
        input.private === true,
      );
      if (!repo) return err(422, 'Repository already exists');
      return ok(repoJson(repo), 201);
    }
    if (method === 'GET') {
      const { page, link } = paginate(store.listViewerRepos(), query, basePath, host);
      return ok(page.map(repoJson), 200, link ? { link } : undefined);
    }
    return err(404, 'Not Found');
  }

  // /repos/{owner}/{name}[...]
  if (segments.length >= 3 && segments[0] === 'repos') {
    const owner = segments[1] as string;
    const name = segments[2] as string;
    const repo = store.getRepo(owner, name);
    const rest = segments.slice(3);

    if (rest.length === 0) {
      if (method === 'GET') {
        if (!repo) return err(404, 'Not Found');
        return ok(repoJson(repo));
      }
      if (method === 'PATCH') {
        if (!repo) return err(404, 'Not Found');
        const input = (body ?? {}) as Record<string, unknown>;
        if (typeof input.description === 'string') repo.description = input.description;
        if (typeof input.private === 'boolean') repo.private = input.private;
        return ok(repoJson(repo));
      }
      if (method === 'DELETE') {
        if (!repo) return err(404, 'Not Found');
        store.repos.delete(store.repoKey(owner, name));
        return noContent;
      }
      return err(404, 'Not Found');
    }

    if (!repo) return err(404, 'Not Found');

    // /git/refs/heads/{branch} — single ref read (MCP refSha).
    if (rest.length === 4 && rest[0] === 'git' && rest[1] === 'refs' && rest[2] === 'heads') {
      if (method !== 'GET') return err(404, 'Not Found');
      const branch = rest[3] as string;
      const sha = repo.refs.get(`refs/heads/${branch}`);
      if (!sha) return err(404, 'Not Found');
      return ok({ ref: `refs/heads/${branch}`, object: { sha } });
    }

    // /git/refs
    if (rest.length === 2 && rest[0] === 'git' && rest[1] === 'refs') {
      if (method !== 'POST') return err(404, 'Not Found');
      const input = (body ?? {}) as Record<string, unknown>;
      const ref = typeof input.ref === 'string' ? input.ref : '';
      const sha = typeof input.sha === 'string' ? input.sha : '';
      if (!ref.startsWith('refs/') || !/^[0-9a-f]{40}$/.test(sha)) return err(422, 'Invalid ref or sha');
      if (!repo.objects.has(sha)) return err(422, 'Object does not exist');
      if (repo.refs.has(ref)) return err(422, 'Reference already exists');
      repo.refs.set(ref, sha);
      return ok({ ref, object: { sha } }, 201);
    }

    // /branches/{branch} — single branch read (MCP branchExists).
    if (rest.length === 2 && rest[0] === 'branches') {
      if (method !== 'GET') return err(404, 'Not Found');
      const branch = rest[1] as string;
      const sha = repo.refs.get(`refs/heads/${branch}`);
      if (!sha) return err(404, 'Not Found');
      return ok({ name: branch, commit: { sha }, protected: false });
    }

    // /branches
    if (rest.length === 1 && rest[0] === 'branches') {
      if (method !== 'GET') return err(404, 'Not Found');
      const branches = [...repo.refs.entries()]
        .filter(([name]) => name.startsWith('refs/heads/'))
        .map(([name, sha]) => ({ name: name.slice('refs/heads/'.length), commit: { sha }, protected: false }))
        .sort((a, b) => (a.name < b.name ? -1 : 1));
      return ok(branches);
    }

    // /commits
    if (rest.length === 1 && rest[0] === 'commits') {
      if (method !== 'GET') return err(404, 'Not Found');
      const ref = query.get('sha') ?? repo.defaultBranch;
      const commits = store.listCommits(repo, ref);
      return ok(
        commits.map((c) => ({
          sha: c.sha,
          commit: { message: c.message, author: { name: VIEWER_NAME, email: VIEWER_EMAIL }, committer: { name: VIEWER_NAME, email: VIEWER_EMAIL } },
          author: { login: VIEWER_LOGIN },
          committer: { login: VIEWER_LOGIN },
        })),
      );
    }

    // /contents/{path...}
    if (rest.length >= 2 && rest[0] === 'contents') {
      const filePath = rest.slice(1).join('/');
      const branch = query.get('branch') ?? query.get('ref') ?? repo.defaultBranch;
      const refName = `refs/heads/${branch}`;
      const tip = repo.refs.get(refName);
      if (method === 'GET') {
        if (!tip) return err(404, 'Not Found');
        const treeOid = parseCommit(repo.objects.get(tip)?.data ?? Buffer.alloc(0)).tree;
        const flat = flattenTree(treeOid, (oid) => repo.objects.get(oid));
        const exact = flat.get(filePath);
        if (exact) {
          const data = repo.objects.get(exact.oid)?.data ?? Buffer.alloc(0);
          return ok({
            type: 'file',
            encoding: 'base64',
            size: data.length,
            name: filePath.split('/').pop(),
            path: filePath,
            content: data.toString('base64'),
            sha: exact.oid,
          });
        }
        // Directory listing: immediate children of the prefix.
        const prefix = filePath === '' ? '' : `${filePath}/`;
        const children = new Map<string, { name: string; path: string; sha: string; type: string }>();
        const treeWalk = (treeOid2: string, prefixPath: string): void => {
          const object = repo.objects.get(treeOid2);
          if (!object || object.type !== 'tree') return;
          for (const entry of parseTree(object.data)) {
            const childPath = prefixPath ? `${prefixPath}/${entry.name}` : entry.name;
            if (prefix !== '' && !childPath.startsWith(prefix) && childPath !== filePath) continue;
            if (prefix === '') {
              if (childPath.includes('/')) {
                const top = childPath.split('/')[0] as string;
                if (!children.has(top)) {
                  // Find the subtree oid for the top directory.
                  const topEntry = parseTree(object.data).find((e) => e.name === top);
                  if (topEntry) children.set(top, { name: top, path: top, sha: topEntry.oid, type: 'dir' });
                }
                continue;
              }
              children.set(childPath, { name: entry.name, path: childPath, sha: entry.oid, type: entry.mode === '40000' ? 'dir' : 'file' });
              continue;
            }
            const rest2 = childPath.slice(prefix.length);
            if (!rest2 || rest2.includes('/')) {
              const top = rest2.split('/')[0] as string;
              if (top && !children.has(top)) {
                const topEntry = parseTree(object.data).find((e) => e.name === top);
                if (topEntry) children.set(top, { name: top, path: `${filePath}/${top}`, sha: topEntry.oid, type: 'dir' });
              }
              continue;
            }
            children.set(childPath, { name: entry.name, path: childPath, sha: entry.oid, type: entry.mode === '40000' ? 'dir' : 'file' });
          }
        };
        // Walk from the root tree, collecting immediate children under filePath.
        const collect = (treeOid2: string, currentPath: string): void => {
          const object = repo.objects.get(treeOid2);
          if (!object || object.type !== 'tree') return;
          for (const entry of parseTree(object.data)) {
            const childPath = currentPath ? `${currentPath}/${entry.name}` : entry.name;
            if (filePath === '') {
              children.set(childPath, { name: entry.name, path: childPath, sha: entry.oid, type: entry.mode === '40000' ? 'dir' : 'file' });
              continue;
            }
            if (childPath === filePath && entry.mode === '40000') {
              collect(entry.oid, childPath);
              continue;
            }
            if (childPath.startsWith(`${filePath}/`)) {
              const rest2 = childPath.slice(filePath.length + 1);
              if (!rest2.includes('/')) {
                children.set(childPath, { name: entry.name, path: childPath, sha: entry.oid, type: entry.mode === '40000' ? 'dir' : 'file' });
              }
            }
          }
        };
        collect(treeOid, '');
        if (children.size === 0) return err(404, 'Not Found');
        const listing = [...children.values()]
          .sort((a, b) => (a.name < b.name ? -1 : 1))
          .map((entry) => ({ ...entry, size: entry.type === 'file' ? (repo.objects.get(entry.sha)?.data.length ?? 0) : 0 }));
        return ok(listing);
      }
      if (method === 'PUT') {
        const input = (body ?? {}) as Record<string, unknown>;
        const message = typeof input.message === 'string' ? input.message : 'update';
        const contentB64 = typeof input.content === 'string' ? input.content : '';
        const putBranch = typeof input.branch === 'string' ? input.branch : repo.defaultBranch;
        const sha = typeof input.sha === 'string' ? input.sha : undefined;
        if (contentB64 === '') return err(422, 'content is required');
        const content = Buffer.from(contentB64, 'base64');
        const refName2 = `refs/heads/${putBranch}`;
        const tip2 = repo.refs.get(refName2);
        const existing = tip2 ? flattenTree(parseCommit(repo.objects.get(tip2)?.data ?? Buffer.alloc(0)).tree, (oid) => repo.objects.get(oid)).get(filePath) : undefined;
        if (existing) {
          if (sha !== undefined && sha.toLowerCase() !== existing.oid.toLowerCase()) return err(409, 'sha does not match');
          const result = store.commitFile(repo, putBranch, filePath, content, message);
          if (!result) return err(404, 'Not Found');
          return ok(
            { content: { name: filePath.split('/').pop(), path: filePath, sha: result.blobSha, size: content.length, encoding: 'base64' }, commit: { sha: result.commitSha, message } },
            200,
          );
        }
        if (sha !== undefined) return err(409, 'sha does not match');
        const result = store.commitFile(repo, putBranch, filePath, content, message);
        if (!result) return err(404, 'Not Found');
        return ok(
          { content: { name: filePath.split('/').pop(), path: filePath, sha: result.blobSha, size: content.length, encoding: 'base64' }, commit: { sha: result.commitSha, message } },
          201,
        );
      }
      if (method === 'DELETE') {
        const input = (body ?? {}) as Record<string, unknown>;
        const message = typeof input.message === 'string' ? input.message : 'delete';
        const sha = typeof input.sha === 'string' ? input.sha : undefined;
        const tip3 = repo.refs.get(refName);
        if (!tip3) return err(404, 'Not Found');
        const flat = flattenTree(parseCommit(repo.objects.get(tip3)?.data ?? Buffer.alloc(0)).tree, (oid) => repo.objects.get(oid));
        const existing = flat.get(filePath);
        if (!existing) return err(404, 'Not Found');
        if (sha !== undefined && sha.toLowerCase() !== existing.oid.toLowerCase()) return err(409, 'sha does not match');
        const commitSha = store.deleteFile(repo, branch, filePath, message);
        if (!commitSha) return err(404, 'Not Found');
        return ok({ commit: { sha: commitSha, message } }, 200);
      }
      return err(404, 'Not Found');
    }

    // /labels
    if (rest.length === 1 && rest[0] === 'labels') {
      if (method !== 'POST') return err(404, 'Not Found');
      const input = (body ?? {}) as Record<string, unknown>;
      const name2 = typeof input.name === 'string' ? input.name : '';
      const color = typeof input.color === 'string' ? input.color : 'ededed';
      if (!name2) return err(422, 'name is required');
      const existing = repo.labels.get(name2);
      if (existing) return ok({ name: existing.name, color: existing.color }, 201);
      repo.labels.set(name2, { name: name2, color });
      return ok({ name: name2, color }, 201);
    }

    // /issues[/...]
    if (rest.length >= 1 && rest[0] === 'issues') {
      if (rest.length === 1) {
        if (method === 'POST') {
          const input = (body ?? {}) as Record<string, unknown>;
          const title = typeof input.title === 'string' ? input.title : '';
          const bodyText = typeof input.body === 'string' ? input.body : '';
          const labelNames = Array.isArray(input.labels) ? (input.labels as unknown[]).map((l) => (typeof l === 'string' ? l : (l as Record<string, unknown>).name)).filter((x): x is string => typeof x === 'string') : [];
          for (const labelName of labelNames) {
            if (!repo.labels.has(labelName)) return err(422, `Label does not exist: ${labelName}`);
          }
          const issue: Issue = {
            number: repo.nextNumber,
            title,
            body: bodyText,
            state: 'open',
            labels: labelNames.map((n) => repo.labels.get(n) as { name: string; color: string }),
            comments: [],
            seq: repo.nextNumber,
            cachedJson: null,
          };
          repo.nextNumber += 1;
          repo.issues.push(issue);
          // Single serialization: the cached string is sent verbatim instead of
          // stringifying the object again in sendJson (same bytes as before).
          return { status: 201, body: null, rawJson: issueJsonString(repo, issue) };
        }
        if (method === 'GET') {
          const state = query.get('state') ?? 'open';
          const sort = query.get('sort') ?? 'created';
          const direction = query.get('direction') ?? 'desc';
          let list = [...repo.issues];
          if (state !== 'all') list = list.filter((i) => i.state === state);
          if (sort === 'created') {
            list.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
          }
          const { page } = paginate(list, query, basePath, host);
          return ok(page.map((i) => issueJson(repo, i)));
        }
        return err(404, 'Not Found');
      }
      const num = Number(rest[1]);
      const issue = repo.issues.find((i) => i.number === num);
      if (rest.length === 2) {
        if (!issue) return err(404, 'Not Found');
        if (method === 'GET') return { status: 200, body: null, rawJson: issueJsonString(repo, issue) };
        if (method === 'PATCH') {
          const input = (body ?? {}) as Record<string, unknown>;
          if (input.state === 'open' || input.state === 'closed') issue.state = input.state;
          if (typeof input.title === 'string') issue.title = input.title;
          if (typeof input.body === 'string') issue.body = input.body;
          issue.cachedJson = null;
          return { status: 200, body: null, rawJson: issueJsonString(repo, issue) };
        }
        return err(404, 'Not Found');
      }
      if (rest.length === 3 && rest[2] === 'comments') {
        if (!issue) return err(404, 'Not Found');
        if (method === 'POST') {
          const input = (body ?? {}) as Record<string, unknown>;
          const text = typeof input.body === 'string' ? input.body : '';
          const comment = { id: repo.nextCommentId, body: text };
          repo.nextCommentId += 1;
          issue.comments.push(comment);
          issue.cachedJson = null;
          return ok({ id: comment.id, body: comment.body }, 201);
        }
        if (method === 'GET') {
          return ok(issue.comments.map((c) => ({ id: c.id, body: c.body })));
        }
        return err(404, 'Not Found');
      }
      return err(404, 'Not Found');
    }

    // /pulls[/...]
    if (rest.length >= 1 && rest[0] === 'pulls') {
      if (rest.length === 1) {
        if (method === 'POST') {
          const input = (body ?? {}) as Record<string, unknown>;
          const title = typeof input.title === 'string' ? input.title : '';
          const bodyText = typeof input.body === 'string' ? input.body : '';
          const head = typeof input.head === 'string' ? input.head : '';
          const base = typeof input.base === 'string' ? input.base : repo.defaultBranch;
          const headSha = repo.refs.get(`refs/heads/${head}`);
          const baseSha = repo.refs.get(`refs/heads/${base}`);
          if (!headSha || !baseSha) return err(422, 'head or base branch does not exist');
          const pull: Pull = {
            number: repo.nextNumber,
            title,
            body: bodyText,
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
          return ok(pullJson(repo, pull), 201);
        }
        if (method === 'GET') {
          const state = query.get('state') ?? 'open';
          let list = [...repo.pulls];
          if (state !== 'all') list = list.filter((p) => p.state === state);
          list.sort((a, b) => b.seq - a.seq);
          const { page } = paginate(list, query, basePath, host);
          return ok(page.map((p) => pullJson(repo, p)));
        }
        return err(404, 'Not Found');
      }
      const num = Number(rest[1]);
      const pull = repo.pulls.find((p) => p.number === num);
      if (rest.length === 2) {
        if (!pull) return err(404, 'Not Found');
        if (method === 'GET') return ok(pullJson(repo, pull));
        return err(404, 'Not Found');
      }
      if (rest.length === 3 && rest[2] === 'files') {
        if (!pull) return err(404, 'Not Found');
        if (method !== 'GET') return err(404, 'Not Found');
        return ok(diffFiles(repo, pull.baseSha, pull.headSha));
      }
      if (rest.length === 3 && rest[2] === 'merge') {
        if (!pull) return err(404, 'Not Found');
        if (method !== 'PUT') return err(404, 'Not Found');
        if (pull.state !== 'open') return err(405, 'Pull request is not open');
        const tree = store.squashTree(repo, pull);
        if (tree === null) return err(405, 'Merge conflict');
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
        return ok({ sha: mergeSha, merged: true, message });
      }
      return err(404, 'Not Found');
    }

    return err(404, 'Not Found');
  }

  return null;
}

export { decodePathSegments, ZERO_OID };
