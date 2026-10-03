# pi-docs-sync

[![CI](https://github.com/raffaelenatale/pi-docs-sync/actions/workflows/ci.yml/badge.svg)](https://github.com/raffaelenatale/pi-docs-sync/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![Node](https://img.shields.io/node/v/%40raffaelenatale/pi-docs-sync)

A [Pi coding agent](https://github.com/earendil-works/pi) extension that mirrors **official documentation published as [`llms.txt`](https://llmstxt.org) / `llms-full.txt`** into a local, structured folder tree — then keeps it fresh with differential (ETag / `Last-Modified` / sha256) syncing on a background TTL, and routes the agent to it with zero-latency local search and read tools.

Configure once, download optimally, and every session afterwards consults the official docs **offline** — refreshing them asynchronously only when they are due.

```text
.pi/docs.json ──▶ discover llms-full.txt / llms.txt ──▶ differential fetch (304 ≈ 0 bytes)
                     │                                        │
                     ▼                                        ▼
             structured mirror                         manifest.json (validators,
        <host>/<path>.md (+ sections/)                 hashes, redirects, sizes)
                     │                                        │
                     ▼                                        ▼
        docs_search / docs_read (local)          async TTL refresh (background)
```

## Why

- **Web-fetching docs every turn** is slow, token-hungry, rate-limited, and pollutes context with HTML boilerplate.
- **Model memory goes stale** for fast-moving frameworks.
- The [`llms.txt` convention](https://llmstxt.org) gives agents a curated Markdown index (`llms.txt`) and often the entire corpus in one file (`llms-full.txt`) — this extension turns that into an offline, diff-updated local mirror the agent is routed to automatically.

## Install

**From npm (recommended):**

```bash
pi install npm:@raffaelenatale/pi-docs-sync
pi install npm:@raffaelenatale/pi-docs-sync@0.1.1   # pinned
```

**From GitHub Packages** (requires a GitHub classic PAT with `read:packages`):

```ini
# ~/.npmrc
@raffaelenatale:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=YOUR_GITHUB_CLASSIC_PAT
```

```bash
pi install npm:@raffaelenatale/pi-docs-sync@0.1.1
```

**Straight from this repo (no registry needed):**

```bash
pi install git:github.com/raffaelenatale/pi-docs-sync            # tracks main
pi install git:github.com/raffaelenatale/pi-docs-sync@v0.1.1     # pinned to a tag
```

`pi install` without `--local` writes the package to `~/.pi/agent/settings.json`, so the extension loads in **every** workspace. Reconcile with `pi update --extensions`, remove with `pi remove <source>`.

**Try it for one invocation, without installing:**

```bash
pi -e npm:@raffaelenatale/pi-docs-sync
```

**Local checkout (development):** `pi install /path/to/pi-docs-sync` loads from the working tree without copying — edit and `/reload`.

No runtime dependencies — only Pi's host-provided packages.

> Releases are published automatically by [`.github/workflows/publish.yml`](.github/workflows/publish.yml) when a `vX.Y.Z` GitHub Release is created: verification (version/tag match, tarball whitelist, typecheck + tests) → npmjs.org via **OIDC Trusted Publishing** (no token; requires a one-time Trusted Publisher config on npmjs.com: package → Settings → publisher GitHub Actions, repo `raffaelenatale/pi-docs-sync`, workflow `publish.yml`) → GitHub Packages via `GITHUB_TOKEN`.
>
> This follows the npm security direction after the [GAT bypass-2FA deprecation](https://github.blog/changelog/2026-07-08-npm-install-time-security-and-gat-bypass2fa-deprecation/): no long-lived publish tokens; local publishes use `npm publish --otp`, CI uses OIDC.

## Quick start

Add a `.pi/docs.json` in your workspace:

```json
{
	"version": 1,
	"storage": "global",
	"defaultTtlHours": 168,
	"sources": {
		"ty": { "url": "https://docs.astral.sh/ty/" },
		"fastmcp": { "url": "https://gofastmcp.com/", "ttlHours": 72 }
	}
}
```

Start Pi. On `session_start` the extension probes each URL for `llms-full.txt` / `llms.txt`, mirrors the docs in the background, and from then on the model sees a system-prompt note pointing it at the local tools:

```
ty — tree · 20 pages · 374.0 KiB · TTL 168h · checked 5m ago
```

Or configure interactively:

```text
/docs add fastapi https://fastapi.tiangolo.com/ 168
/docs sync
```

## Configuration reference

`.pi/docs.json` (workspace) is merged over `~/.pi/agent/docs.json` (global); workspace entries win by name.

| Field | Where | Default | Meaning |
| --- | --- | --- | --- |
| `sources.<name>.url` | per source | — | Docs base URL (probes `<base>/llms-full.txt`, then `<base>/llms.txt`) or a direct link to either file. |
| `sources.<name>.ttlHours` | per source | `defaultTtlHours` | Hours between background re-checks. |
| `sources.<name>.include` / `.exclude` | per source | keep all | Globs matched on the URL path (`*` stays in-segment, `**` crosses segments). `exclude` wins. |
| `sources.<name>.allowExternal` | per source | `false` | Also mirror pages the index references on other hosts. |
| `defaultTtlHours` | root | `168` | TTL for sources without an explicit one. |
| `storage` | root | `"global"` | `global` → shared mirror in `~/.pi/agent/docs-mirror/<source>/`; `workspace` → `.pi/docs-mirror/` (e.g. to commit docs into the repo). |

Source names must be filesystem-safe: letters, digits, `.`, `_`, `-` (max 64 chars).

## What sync does

1. **Discovery** — probe `llms-full.txt` first: if found, the corpus is stored as `full.md` and sharded at `#`/`##` headings (code-fence aware) into `sections/NNN-slug.md` with an `index.json`. Otherwise parse `llms.txt`.
2. **Tree mode** — every `- [Title](url): description` link is resolved against the index URL, filtered, and downloaded into `<sourceRoot>/<host>/<path>.md`:
   - redirects are followed and the **final** URL determines the local path (external redirects fall back to the requested path and are flagged in the manifest);
   - percent-decoded, unicode-transliterated, sanitized segments; literal `..` traversal refused; `.html` → `.md`; trailing slash → `index.md`; collisions deduped (`-2`, `-3`, …);
   - max 5 concurrent requests, per-request timeout, per-page and polite User-Agent.
3. **Differential** — each request carries `If-None-Match` / `If-Modified-Since`; a `304` costs ≈0 bytes. Bodies are written only when their sha256 changed; pages dropped from the index are pruned from disk; everything is tracked in an atomically-written `manifest.json` (validators, hashes, sizes, redirects, skips).
4. **Refresh** — sources whose `lastChecked + ttl` expired sync in the background on `session_start` and every 10 minutes while the session lives — never blocking a turn. Failed syncs retry after ~1 h. All requests are abortable on session shutdown.

## Agent tools

| Tool | Params | Purpose |
| --- | --- | --- |
| `docs_list` | — | Configured sources: mode, pages, size, freshness, disk path. |
| `docs_search` | `query`, `source?`, `limit?` | Multi-term AND search (title boost, frequency scoring) across the mirror; returns line-numbered snippets. Local — no network. |
| `docs_read` | `source`, `path?`/`query?`, `offset?`, `limit?` | Read a page or line range by path from search results, or by `query` to land on the best-matching page; reports the continuation offset. |
| `docs_sync` | `source?` | Force a differential sync now; reports `+fetched ~unchanged -removed`. |

On top of the tools, each run's system prompt lists the mirrored sources so the model prefers `docs_search` / `docs_read` over web fetches for those libraries.

## `/docs` command

```text
/docs                                status of all sources
/docs add <name> <url> [ttlHours]    add a source and sync it immediately
/docs remove <name>                  remove from workspace config (mirror files kept)
/docs sync [name]                    force a differential sync
/docs list                           alias of status
/docs path [name]                    print the mirror path on disk
```

## How it compares

| | pi-docs-sync | `@m4ss/pi-llms-txt` | `mcpdoc` / MCP llms.txt servers | Cursor `@Docs` | DevDocs / Dash |
| --- | --- | --- | --- | --- | --- |
| Local structured mirror | ✅ | single cached file | ❌ (on-demand network) | ❌ (cloud) | HTML/docsets |
| Differential sync (ETag/hash) | ✅ | TTL-only | ❌ | n/a | manual |
| Background TTL refresh | ✅ | ❌ | ❌ | ❌ | ❌ |
| Workspace config + agent routing | ✅ | ❌ | partial | ❌ | ❌ |
| Works offline after first sync | ✅ | partial | ❌ | ❌ | ✅ (human-facing) |

## Development

```bash
npm install
npm test            # node --test — unit + e2e sync against a local HTTP server
npm run typecheck   # tsc --noEmit
```

```text
extensions/docs-sync/
├── index.ts      Extension entry: tools, /docs command, TTL timer, system-prompt note
├── config.ts     Workspace + global config load/merge/save
├── llms-txt.ts   llmstxt.org parser, link resolution, fence-aware section splitter
├── net.ts        Conditional GET, hashing, bounded concurrency, body-only probing
├── mirror.ts     Path mapping, manifest, differential sync engine
├── search.ts     Local multi-term search with snippets
└── types.ts
```

Requires Node ≥ 22.18 (TypeScript is executed directly by Pi's `jiti` loader; tests use Node's native type stripping).

## Limitations & ideas

- Sites without `llms.txt`/`llms-full.txt` are out of scope (a HTML-crawl fallback could be a future extension).
- Search is keyword-based (AND matching + frequency/title boosts) — fast and dependency-free; a BM25/embedding index could layer on top.
- No `robots.txt` handling yet; politeness comes from capped concurrency and conditional requests.

## License

[MIT](LICENSE)
