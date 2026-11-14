// The forge's HTTP server: routing, auth, JSON bodies and the request-id header.
// Surfaces: GET /healthz, /api/v3/* (REST), POST /api/graphql, POST /mcp,
// /{owner}/{repo}.git/* (git smart HTTP). Everything else is a JSON 404.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store, VIEWER_LOGIN } from './store.ts';
import { handleRest, checkAuth, decodePathSegments, type RestContext } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleInfoRefs, handleUploadPack, handleReceivePack } from './gitproto.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const MAX_BODY_BYTES = 64 * 1024 * 1024;

const store = new Store();
const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
const restContext: RestContext = { store, token: TOKEN };

function sendJson(res: ServerResponse, status: number, body: unknown, requestId: string, headers: Record<string, string> = {}): void {
  const text = body === null ? '' : `${JSON.stringify(body)}\n`;
  const all: Record<string, string> = {
    'content-type': JSON_TYPE,
    'x-github-request-id': requestId,
    ...headers,
  };
  if (body !== null) all['content-length'] = String(Buffer.byteLength(text));
  res.writeHead(status, all);
  res.end(text);
}

function sendBuffer(res: ServerResponse, status: number, contentType: string, body: Buffer, requestId: string): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': String(body.length),
    'x-github-request-id': requestId,
  });
  res.end(body);
}

/** One URL parse per request: pathname and query come from the same object.
 * Manual split — `new URL` costs ~10x more and we only need the raw path plus
 * the query string. Paths needing normalization ('/./', '/../', '//') fall back
 * to `new URL` so routing behaviour is unchanged. */
function urlOf(req: IncomingMessage): { path: string; query: URLSearchParams } {
  const raw = req.url ?? '/';
  const q = raw.indexOf('?');
  const path = q < 0 ? raw : raw.slice(0, q);
  if (path.includes('/./') || path.includes('/../') || path.includes('//')) {
    try {
      const url = new URL(raw, 'http://entry');
      return { path: url.pathname, query: url.searchParams };
    } catch {
      return { path: '/', query: new URLSearchParams() };
    }
  }
  return { path, query: q < 0 ? new URLSearchParams() : new URLSearchParams(raw.slice(q + 1)) };
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const lenHeader = req.headers['content-length'];
    const expected = typeof lenHeader === 'string' ? Number(lenHeader) : NaN;
    const done = (): void => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    };
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error('body too large'));
        return;
      }
      chunks.push(chunk);
      // Fast path: the body is complete as soon as content-length bytes have
      // arrived — no need to wait for the 'end' event's extra event-loop turn.
      if (Number.isFinite(expected) && total >= expected) done();
    });
    req.on('end', done);
    req.on('error', reject);
  });
}

function parseJsonBody(raw: Buffer): { value: unknown; malformed: boolean } {
  if (raw.length === 0) return { value: undefined, malformed: false };
  try {
    return { value: JSON.parse(raw.toString('utf8')), malformed: false };
  } catch {
    return { value: undefined, malformed: true };
  }
}

const OWNER_REPO = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const requestId = store.nextRequestId();
      try {
        const method = req.method ?? 'GET';
        const { path, query } = urlOf(req);
        const host = req.headers.host ?? '127.0.0.1';

        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true }, requestId);
          return;
        }

        // Git smart HTTP: /{owner}/{repo}.git/...
        const gitMatch = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/.exec(path);
        if (gitMatch) {
          const owner = decodeURIComponent(gitMatch[1] as string);
          const repoName = decodeURIComponent(gitMatch[2] as string);
          const suffix = gitMatch[3] ?? '';
          if (!OWNER_REPO.test(owner) || !OWNER_REPO.test(repoName)) {
            sendJson(res, 404, { message: 'Not Found' }, requestId);
            return;
          }
          if (method === 'GET' && suffix === '/info/refs') {
            const service = query.get('service');
            if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
              sendJson(res, 400, { message: 'service is required' }, requestId);
              return;
            }
            const gitProtocol = req.headers['git-protocol'] ?? null;
            const answer = handleInfoRefs(store, owner, repoName, service, gitProtocol);
            sendBuffer(res, answer.status, answer.contentType, answer.body, requestId);
            return;
          }
          if (method === 'POST' && suffix === '/git-upload-pack') {
            const body = await readBody(req);
            const gitProtocol = req.headers['git-protocol'] ?? null;
            const answer = handleUploadPack(store, owner, repoName, body, gitProtocol);
            sendBuffer(res, answer.status, answer.contentType, answer.body, requestId);
            return;
          }
          if (method === 'POST' && suffix === '/git-receive-pack') {
            const body = await readBody(req);
            const answer = handleReceivePack(store, owner, repoName, body);
            sendBuffer(res, answer.status, answer.contentType, answer.body, requestId);
            return;
          }
          sendJson(res, 404, { message: 'Not Found' }, requestId);
          return;
        }

        // MCP.
        if (path === '/mcp') {
          if (method !== 'POST') {
            sendJson(res, 404, { message: 'Not Found' }, requestId);
            return;
          }
          if (!checkAuth(restContext, req.headers.authorization)) {
            sendJson(res, 401, { message: 'Requires authentication' }, requestId);
            return;
          }
          const raw = await readBody(req);
          const parsed = parseJsonBody(raw);
          const answer = handleMcp(store, parsed.value, !parsed.malformed);
          if (answer.body === null) {
            res.writeHead(answer.status, { 'x-github-request-id': requestId });
            res.end();
            return;
          }
          sendJson(res, answer.status, answer.body, requestId);
          return;
        }

        // GraphQL.
        if (path === '/api/graphql') {
          if (method !== 'POST') {
            sendJson(res, 404, { message: 'Not Found' }, requestId);
            return;
          }
          if (!checkAuth(restContext, req.headers.authorization)) {
            sendJson(res, 401, { message: 'Requires authentication' }, requestId);
            return;
          }
          const raw = await readBody(req);
          const parsed = parseJsonBody(raw);
          if (parsed.malformed) {
            sendJson(res, 400, { message: 'malformed JSON body' }, requestId);
            return;
          }
          const answer = handleGraphQL(store, parsed.value);
          sendJson(res, answer.status, answer.body, requestId);
          return;
        }

        // REST v3.
        if (path === '/api/v3' || path.startsWith('/api/v3/')) {
          if (!checkAuth(restContext, req.headers.authorization)) {
            sendJson(res, 401, { message: 'Requires authentication' }, requestId);
            return;
          }
          const raw = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);
          const parsed = parseJsonBody(raw);
          const restPath = path === '/api/v3' ? '' : path.slice('/api/v3/'.length);
          const segments = restPath === '' ? [] : decodePathSegments(restPath);
          const result = handleRest(restContext, method, segments, query, parsed.value, parsed.malformed, host);
          if (result === null) {
            sendJson(res, 404, { message: 'Not Found' }, requestId);
            return;
          }
          if (result.status === 204) {
            res.writeHead(204, { 'x-github-request-id': requestId, ...(result.headers ?? {}) });
            res.end();
            return;
          }
          if (result.rawJson !== undefined) {
            res.writeHead(result.status, {
              'content-type': JSON_TYPE,
              'content-length': String(Buffer.byteLength(result.rawJson)),
              'x-github-request-id': requestId,
              ...(result.headers ?? {}),
            });
            res.end(result.rawJson);
            return;
          }
          sendJson(res, result.status, result.body, requestId, result.headers ?? {});
          return;
        }

        sendJson(res, 404, { message: 'Not Found' }, requestId);
      } catch (err) {
        if (!res.headersSent) {
          sendJson(res, 500, { message: err instanceof Error ? err.message : 'internal error' }, requestId);
        } else {
          res.destroy();
        }
      }
    })();
  });
}

export { VIEWER_LOGIN };
