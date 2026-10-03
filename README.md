# pi-docs-sync

Pi extension that mirrors **official documentation published as `llms.txt` / `llms-full.txt`** into a local, structured folder tree — with differential (ETag / Last-Modified / sha256) syncing, background TTL refresh, and zero-latency local `docs_search` / `docs_read` tools for the agent.

Born from [RFC pi-skills#41](https://github.com/raffaelenatale/pi-skills/issues/41): *configure once, download optimally, then let every session consult the official docs locally and refresh them asynchronously when due.*

## Why

- Web-fetching docs every turn is slow, token-hungry and rate-limited; model memory goes stale.
- `llms.txt` (llmstxt.org) gives agents a curated Markdown index; `llms-full.txt` gives the whole corpus in one file.
- This extension turns that into an **offline, diff-updated local mirror** the agent is routed to automatically.

## Install

```bash
# from a local checkout
pi install /path/to/pi-docs-sync

# or per-invocation, to try it
pi -e /path/to/pi-docs-sync/extensions/docs-sync/index.ts
```

## Configure once per workspace: `.pi/docs.json`

```json
{
  "version": 1,
  "storage": "global",
  "defaultTtlHours": 168,
  "sources": {
    "ty":       { "url": "https://docs.astral.sh/ty/",   "ttlHours": 168 },
    "fastmcp":  { "url": "https://gofastmcp.com/",       "ttlHours": 72 },
    "pydantic": { "url": "https://docs.pydantic.dev/latest/", "exclude": ["**/blog/**"] }
  }
}
```

- `url` may be the docs base (the extension probes `<base>/llms-full.txt` then `<base>/llms.txt`) or a direct link to either file.
- `ttlHours` controls the async background re-check. Default 168 h (7 days).
- `include` / `exclude` are globs matched on the URL path (`*` stays in-segment, `**` crosses).
- `allowExternal: true` also mirrors pages the index references on other hosts (default: same host only).
- `storage`: `global` (default) mirrors into `~/.pi/agent/docs-mirror/<source>/` shared by all workspaces; `workspace` mirrors into `.pi/docs-mirror/` (e.g. to commit docs into the repo).
- A global config at `~/.pi/agent/docs.json` is merged under the workspace one (workspace wins by name).

## What happens at sync

1. **Discovery** — probes `llms-full.txt` first (single-file mode, sharded into `sections/*.md` outside code fences), else `llms.txt` (tree mode).
2. **Tree mode** — parses every `- [Title](url): desc` link, resolves relative/redirected URLs, filters, and downloads each page into `<sourceRoot>/<host>/<path>.md` (decoded, sanitized, traversal-refused, `.html`→`.md`, trailing slash→`index.md`, collisions deduped).
3. **Differential** — every request carries `If-None-Match` / `If-Modified-Since`; `304` costs bytes≈0. Bodies are written only when the sha256 changed; pages dropped from the index are pruned; every page is tracked in an atomic `manifest.json` (validators, hashes, sizes, redirects, skips).
4. **Politeness** — max 5 concurrent requests, per-request timeout, size caps, descriptive User-Agent.

## When it refreshes

- On `session_start` (and every 10 min while the session lives) each source whose `lastChecked + ttl` has expired is synced **in the background** — never blocking a turn. A quiet status-line entry tracks it, and a notification reports fresh pages.
- Failed syncs retry after ~1 h instead of the full TTL. Everything is abortable on session shutdown.

## What the agent gets

| Tool | Purpose |
| --- | --- |
| `docs_list` | Configured sources: mode, pages, size, freshness, disk path. |
| `docs_search` | Multi-term AND search with line-numbered snippets across the mirror (local, no network). |
| `docs_read` | Read a page (or line range) by path from search results, or by `query` to land on the best page. |
| `docs_sync` | Force a differential sync now (network I/O, reports `+fetched ~unchanged -removed`). |

Plus a system-prompt section listing the mirrored sources so the model prefers `docs_search` / `docs_read` over web fetches for those libraries.

## `/docs` command

```
/docs                     status of all sources
/docs add <name> <url> [ttlHours]
/docs remove <name>
/docs sync [name]
/docs list
/docs path [name]
```

## Development

```bash
npm install
npm test        # node --test tests/  (36 tests, incl. e2e sync against a local HTTP server)
npm run typecheck
```

No runtime dependencies: only Pi host-provided packages (`peerDependencies: "*"`).

## Prior art

- `@m4ss/pi-llms-txt` — caches the single `llms.txt` file (40 KB cap, 24 h TTL); no page tree, no diffing, no workspace config.
- `langchain-ai/mcpdoc`, `llms-txt-mcp` — MCP servers querying llms.txt online; no local mirror, no async TTL refresh.
- Cursor `@Docs` — proprietary cloud crawl + embeddings; not local Markdown.
- DevDocs/Dash — human-facing HTML/docsets, not agent-facing Markdown.
