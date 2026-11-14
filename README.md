# git-forge

A standalone GitHub-compatible git forge in one Node 22 TypeScript process,
stdlib only — no git binary, no external service, no UI.

## What it serves

- **Git smart HTTP** at `/{owner}/{repo}.git` — upload-pack protocol v2,
  receive-pack v0 (report-status, side-band-64k, delete-refs), fast-forward
  enforcement (`ng <ref> non-fast-forward` per refused ref).
- **REST v3** at `/api/v3` — repos, refs, branches, commits, contents,
  labels, issues, pulls (squash merge, conflict → 405).
- **GraphQL** at `/api/graphql` — repository / issues / pull requests,
  mutations, introspection, batched documents.
- **MCP** at `/mcp` — JSON-RPC 2.0 Streamable HTTP, revision 2026-07-28
  (`server/discover`) with the legacy `initialize` handshake as fallback;
  tools `create_repo`, `get_repo`, `create_issue`, `list_issues`,
  `create_pull_request`, `merge_pull_request`, all on the same store as REST.

## Run

```sh
MAKEFUN_SHOP_TOKEN=<token> node --experimental-strip-types main.ts
```

Without `MAKEFUN_ENV_URL` the process exits 1 (it has no env to register
with). With it set, it binds an ephemeral port, registers, serves the suite,
and exits 0 when the env says done. `GET /healthz` answers `{"ok":true}`.

## Determinism

State is fully deterministic: fixed commit timestamps and date strings,
per-repo counters for issue/PR numbers, no wall clock or randomness in stored
state — two runs on the same instance export byte-identical state.

## Layout

- `main.ts` — entrypoint lifecycle (bind, register, wait for done).
- `app.ts` — HTTP server, routing, auth, JSON bodies, request ids.
- `store.ts` — in-memory object store, refs, repos/issues/pulls model.
- `gitproto.ts` — pkt-lines, packfiles, upload-pack v2 / receive-pack v0.
- `rest.ts` — REST v3 handlers. `graphql.ts` — GraphQL executor.
  `mcp.ts` — MCP JSON-RPC endpoint.
