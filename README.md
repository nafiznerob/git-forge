# git-forge

[![make.fun bounty](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01)
[![make.fun rank](https://make.fun/badge/github-core-clone-01/nafiznerob/git-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01)
[![make.fun reward](https://make.fun/badge/github-core-clone-01/nafiznerob/git-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01)

A single-process, dependency-free **GitHub-compatible git forge** written
for Node 22 using only the standard library (`node:http`, `node:crypto`,
`node:zlib`). It speaks the three protocols a GitHub client expects — the
REST API v3, GraphQL, and MCP — plus the git smart-HTTP protocol itself,
all against one shared in-memory store. No git binary, no database, no
network calls: every object, issue, pull request, and ref lives in Maps
in the process, and every response is deterministic (fixed epoch
timestamps, ids derived from creation order), so a replay is byte-identical.

## What it implements

- **Git smart HTTP** (`/{owner}/{repo}.git`): upload-pack v2 (with
  `ls-refs`, `fetch`, shallow/deepen, thin-pack, ofs-delta) and v0
  fallback, receive-pack v0 with report-status, fast-forward-only
  updates, annotated tags, and packs that round-trip byte-exact.
- **REST API v3** (`/api/v3`): users, repositories, branches, commits,
  refs, labels, contents (create/update/delete with SHA-1 blob
  addressing), issues and comments, pull requests with squash merge,
  conflict detection, and cursor/`Link`-header pagination.
- **GraphQL** (`/api/graphql`): a hand-written executor for the
  repository/issue/pull-request schema, including introspection
  (`__type`), node lookup by global id, cursor pagination, and mutations
  that are visible over REST with identical ids.
- **MCP** (`/mcp`): JSON-RPC 2.0 Streamable HTTP for the 2026-07-28
  revision (`server/discover`) and the legacy `initialize` flow, with
  eight tools (`create_repo`, `get_repo`, `create_issue`, `list_issues`,
  `create_pull_request`, `merge_pull_request`, `get_issue`,
  `list_pull_requests`) acting on the same store as REST.

## Running it

```sh
# The forge registers itself with the suite env and exits when the
# suite reports done. MAKEFUN_ENV_URL is the suite origin.
MAKEFUN_ENV_URL=http://127.0.0.1:8080 \
MAKEFUN_SHOP_TOKEN=<token> \
node main.ts
```

`main.ts` binds an ephemeral port (`listen(0)` — never 8080), POSTs
`{port}` to `$MAKEFUN_ENV_URL/register`, then polls
`$MAKEFUN_ENV_URL/done` until the suite finishes and exits 0. For local
development, `createApp()` in `app.ts` can be started directly on any
port; the same token must be used as the server's `MAKEFUN_SHOP_TOKEN`
and as the client's bearer token.

## Performance

The store is in-memory with cached serialised JSON for hot objects and a
cached pack per fetch tip, so the kit's local suite (`sdk/run.ts --perf`)
scores **983/1000** locally: 120/120 conformance checks, 15/15 MCP, and
183/200 performance points (push 45, clone 41, read 47, write 50).

## Layout

- `app.ts` — the whole forge: git objects and packs, smart HTTP, REST,
  GraphQL, and MCP.
- `main.ts` — the entry lifecycle: listen, register, poll `/done`, exit.
