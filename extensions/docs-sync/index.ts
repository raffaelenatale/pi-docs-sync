/**
 * pi-docs-sync — local structured mirror of official docs (llms.txt / llms-full.txt).
 *
 * - Config: `.pi/docs.json` in the workspace (+ optional global config in the agent dir).
 * - Sync: differential (ETag / Last-Modified / sha256), polite concurrency, atomic manifest.
 * - Refresh: async TTL checks on session start and on a background interval; never blocks turns.
 * - Routing: tools `docs_list` / `docs_search` / `docs_read` / `docs_sync` + system prompt note.
 * - Command: `/docs` (add | remove | list | sync | status | path).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	WORKSPACE_CONFIG_REL,
	effectiveTtlHours,
	isValidSourceName,
	mergeConfigs,
	readConfigFile,
	writeConfigFile,
} from "./config.ts";
import { isDue, mirrorRootFor, readManifest, sourceRootFor, syncSourceQueued } from "./mirror.ts";
import { searchMirror, searchSource } from "./search.ts";
import type { DocsConfig, DocsSourceConfig, SourceManifest, SyncResult } from "./types.ts";

const TIMER_INTERVAL_MS = 10 * 60_000;

interface SourceStatus {
	name: string;
	url: string;
	mode: "tree" | "full" | "never-synced";
	pages: number;
	bytes: number;
	stale: boolean;
	ttlHours: number;
	lastCheckedAt?: number;
	lastSyncAt?: number;
	lastError?: string;
	root: string;
}

interface Runtime {
	cwd: string;
	config: DocsConfig;
	globalConfig: DocsConfig | null;
	mirrorRoot: string;
	/** True once any source has a manifest (used for the system-prompt note). */
	hasMirrors: boolean;
}

function nowHoursAgo(ts: number | undefined): string {
	if (!ts) return "never";
	const minutes = Math.round((Date.now() - ts) / 60_000);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.round(minutes / 60);
	if (hours < 48) return `${hours}h ago`;
	return `${Math.round(hours / 24)}d ago`;
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function collectStatus(runtime: Runtime): SourceStatus[] {
	return Object.entries(runtime.config.sources).map(([name, cfg]) => {
		const sourceRoot = sourceRootFor(runtime.mirrorRoot, name);
		const manifest = readManifest(sourceRoot);
		const pages = Object.keys(manifest?.pages ?? {}).length;
		const bytes = manifest?.mode === "full" ? (manifest.bytes ?? 0) : Object.values(manifest?.pages ?? {}).reduce((sum, p) => sum + p.bytes, 0);
		return {
			name,
			url: cfg.url,
			mode: manifest?.mode ?? "never-synced",
			pages: manifest?.mode === "full" ? 1 : pages,
			bytes,
			stale: isDue(manifest, effectiveTtlHours(runtime.config, cfg)),
			ttlHours: effectiveTtlHours(runtime.config, cfg),
			lastCheckedAt: manifest?.lastCheckedAt,
			lastSyncAt: manifest?.lastSyncAt,
			lastError: manifest?.lastError,
			root: sourceRoot,
		};
	});
}

function formatStatusTable(status: readonly SourceStatus[]): string {
	if (status.length === 0) return "No documentation sources configured. Use `/docs add <name> <url>` or add them to .pi/docs.json.";
	return status
		.map((s) => {
			const head = `${s.name} — ${s.mode} · ${s.pages} ${s.mode === "full" ? "file" : "pages"} · ${formatBytes(s.bytes)} · TTL ${s.ttlHours}h · checked ${nowHoursAgo(s.lastCheckedAt)}${s.stale ? " (due)" : ""}`;
			return s.lastError ? `${head}\n  last error: ${s.lastError}` : head;
		})
		.join("\n");
}

function resolveSafe(sourceRoot: string, relPath: string): string | null {
	const absolute = path.resolve(sourceRoot, relPath);
	const root = path.resolve(sourceRoot);
	if (absolute !== root && !absolute.startsWith(root + path.sep)) return null;
	return absolute;
}

export default function docsSyncExtension(pi: ExtensionAPI) {
	let runtime: Runtime | null = null;
	let timer: ReturnType<typeof setInterval> | undefined;
	let syncAbort = new AbortController();

	const loadRuntime = (cwd: string): Runtime | null => {
		const workspaceConfig = readConfigFile(path.join(cwd, WORKSPACE_CONFIG_REL));
		const globalConfig = readConfigFile(path.join(getAgentDir(), "docs.json"));
		const config = mergeConfigs(globalConfig, workspaceConfig);
		if (Object.keys(config.sources).length === 0) return null;
		return { cwd, config, globalConfig, mirrorRoot: mirrorRootFor(config, cwd, getAgentDir()), hasMirrors: false };
	};

	// Re-read the config from disk so that edits to .pi/docs.json (or a file created
	// mid-session) take effect without `/reload`. Keeps the mirror flag across reloads.
	const refreshRuntime = (cwd: string): Runtime | null => {
		const hadMirrors = runtime?.hasMirrors ?? false;
		runtime = loadRuntime(cwd);
		if (runtime) runtime.hasMirrors = hadMirrors;
		return runtime;
	};

	const syncNow = async (names: readonly string[], opts: { force?: boolean; onProgress?: (message: string) => void } = {}): Promise<SyncResult[]> => {
		if (!runtime) return [];
		const results: SyncResult[] = [];
		for (const name of names) {
			const cfg = runtime.config.sources[name];
			if (!cfg) continue;
			results.push(
				await syncSourceQueued(name, cfg, runtime.config, sourceRootFor(runtime.mirrorRoot, name), {
					force: opts.force,
					signal: syncAbort.signal,
					onProgress: opts.onProgress,
				}),
			);
		}
		return results;
	};

	const dueSources = (): string[] => {
		if (!runtime) return [];
		return Object.entries(runtime.config.sources)
			.filter(([name, cfg]) => isDue(readManifest(sourceRootFor(runtime!.mirrorRoot, name)), effectiveTtlHours(runtime!.config, cfg)))
			.map(([name]) => name);
	};

	const queueDueSyncs = (ctx: { ui: { setStatus: (key: string, text: string | undefined) => void; notify: (message: string, level?: "info" | "warning" | "error") => void }; hasUI: boolean }): void => {
		if (!runtime) return;
		const due = dueSources();
		if (due.length === 0) return;
		ctx.ui.setStatus("docs-sync", `syncing ${due.join(", ")}…`);
		void syncNow(due, { force: false })
			.then((results) => {
				if (!runtime) return;
				runtime.hasMirrors = true;
				const fresh = results.filter((r) => r.fetched > 0);
				const failed = results.filter((r) => r.error);
				ctx.ui.setStatus(
					"docs-sync",
					`${Object.keys(runtime.config.sources).length} doc sources${failed.length > 0 ? ` · ${failed.length} sync error(s)` : ""}`,
				);
				if (fresh.length > 0 && ctx.hasUI) {
					const summary = fresh.map((r) => `${r.name}: ${r.fetched} page(s) updated`).join(", ");
					ctx.ui.notify(`pi-docs-sync background refresh — ${summary}`, "info");
				}
			})
			.catch(() => {
				/* surfaced via manifest.lastError */
			});
	};

	// --- Tools -----------------------------------------------------------------

	const docsListTool = defineTool({
		name: "docs_list",
		label: "Docs list",
		description:
			"List the locally mirrored official documentation sources configured for this workspace (pi-docs-sync). " +
			"Returns each source's name, mode, size, freshness and on-disk path. Call this before docs_search/docs_read to discover available sources.",
		parameters: Type.Object({}),
		promptSnippet: "List locally mirrored official docs sources (pi-docs-sync)",
		promptGuidelines: ["When the user's question concerns a library whose official docs are mirrored locally, prefer docs_search/docs_read over web fetches."],
		async execute(_id, _params, _signal, _onUpdate, ctx) {
			refreshRuntime(ctx.cwd);
			const status = runtime ? collectStatus(runtime) : [];
			return {
				content: [{ type: "text", text: formatStatusTable(status) }],
				details: { sources: status, cwd: ctx.cwd },
			};
		},
	});

	const docsSearchTool = defineTool({
		name: "docs_search",
		label: "Docs search",
		description:
			"Keyword search over the locally mirrored official documentation (pi-docs-sync). Zero network latency: results come from the local mirror. " +
			"Returns ranked files with line-numbered snippets; follow up with docs_read for full context. Optionally restrict to one source.",
		parameters: Type.Object({
			query: Type.String({ description: "Search keywords, e.g. 'background tasks lifespan' or 'BaseModel field validation'." }),
			source: Type.Optional(Type.String({ description: "Restrict to one configured source name (see docs_list)." })),
			limit: Type.Optional(Type.Number({ description: "Max results (1-25, default 8)." })),
		}),
		promptSnippet: "Search locally mirrored official docs (pi-docs-sync)",
		promptGuidelines: ["Prefer docs_search over web fetches for libraries mirrored locally; results are offline and token-efficient."],
		async execute(_id, params, signal, _onUpdate, ctx) {
			refreshRuntime(ctx.cwd);
			if (!runtime || Object.keys(runtime.config.sources).length === 0) {
				return { content: [{ type: "text", text: "No documentation sources configured. Use `/docs add <name> <url>`." }], details: { hits: [] } };
			}
			const sources = params.source
				? Object.keys(runtime.config.sources).filter((name) => name === params.source)
				: Object.keys(runtime.config.sources);
			if (params.source && sources.length === 0) {
				return {
					content: [{ type: "text", text: `Unknown source '${params.source}'. Configured: ${Object.keys(runtime.config.sources).join(", ")}.` }],
					details: { hits: [] },
					isError: true,
				};
			}
			const searchable = sources.map((name) => ({ name, root: sourceRootFor(runtime!.mirrorRoot, name) }));
			const hits = searchMirror(searchable, params.query, { limit: Math.min(Math.max(params.limit ?? 8, 1), 25), signal });
			const text =
				hits.length === 0
					? `No matches for '${params.query}' in: ${searchable.map((s) => s.name).join(", ")}.`
					: hits
							.map((hit) => {
								const snippets = hit.snippets.map((s) => `    L${s.line}: ${s.text}`).join("\n");
								return `${hit.source}/${hit.path}  (${hit.title})\n${snippets}`;
							})
							.join("\n\n");
			return { content: [{ type: "text", text }], details: { hits } };
		},
	});

	const docsReadTool = defineTool({
		name: "docs_read",
		label: "Docs read",
		description:
			"Read a page (or a line range) from the locally mirrored official documentation (pi-docs-sync). " +
			"Use a path returned by docs_search (relative to the source root), or omit `path` and give `query` to read the best-matching page. " +
			"Results are line-numbered; pass `offset` to continue reading a long page.",
		parameters: Type.Object({
			source: Type.String({ description: "Configured source name (see docs_list)." }),
			path: Type.Optional(Type.String({ description: "Page path relative to the source root, as returned by docs_search." })),
			query: Type.Optional(Type.String({ description: "When `path` is omitted: pick the best-matching page for this query." })),
			offset: Type.Optional(Type.Number({ description: "1-based line to start from (default 1)." })),
			limit: Type.Optional(Type.Number({ description: "Max lines to return (default 120, max 400)." })),
		}),
		promptSnippet: "Read a page from locally mirrored official docs (pi-docs-sync)",
		async execute(_id, params, _signal, _onUpdate, ctx) {
			refreshRuntime(ctx.cwd);
			if (!runtime) return { content: [{ type: "text", text: "pi-docs-sync is not configured in this workspace." }], details: undefined, isError: true };
			const sourceRoot = sourceRootFor(runtime.mirrorRoot, params.source);
			if (!runtime.config.sources[params.source]) {
				return { content: [{ type: "text", text: `Unknown source '${params.source}'. Configured: ${Object.keys(runtime.config.sources).join(", ")}.` }], details: undefined, isError: true };
			}

			let relPath = params.path;
			if (!relPath && params.query) {
				const hits = searchSource(sourceRoot, params.source, params.query, { limit: 1 });
				relPath = hits[0]?.path;
				if (!relPath) {
					return { content: [{ type: "text", text: `No page in '${params.source}' matches '${params.query}'.` }], details: undefined, isError: true };
				}
			}
			if (!relPath) {
				return { content: [{ type: "text", text: "Provide `path` (from docs_search) or `query`." }], details: undefined, isError: true };
			}

			const absolute = resolveSafe(sourceRoot, relPath);
			if (!absolute) {
				return { content: [{ type: "text", text: `Invalid path '${relPath}'.` }], details: undefined, isError: true };
			}
			let text: string;
			try {
				text = fs.readFileSync(absolute, "utf8");
			} catch {
				const manifest: SourceManifest | null = readManifest(sourceRoot);
				const known = manifest && Object.values(manifest.pages).some((p) => p.path === relPath);
				return {
					content: [{ type: "text", text: known ? `Page '${relPath}' is missing on disk; run /docs sync ${params.source} or the docs_sync tool.` : `Unknown page '${relPath}' in '${params.source}'. Use docs_search to find valid paths.` }],
					details: undefined,
					isError: true,
				};
			}

			const lines = text.split(/\r?\n/);
			const offset = Math.max(1, Math.floor(params.offset ?? 1));
			const limit = Math.min(Math.max(Math.floor(params.limit ?? 120), 1), 400);
			const slice = lines.slice(offset - 1, offset - 1 + limit);
			const truncatedLine = slice.map((line) => (line.length > 2000 ? `${line.slice(0, 2000)}…` : line));
			const header = `${params.source}/${relPath} — lines ${offset}–${offset - 1 + slice.length} of ${lines.length}`;
			const nextHint = offset - 1 + slice.length < lines.length ? `\n[Truncated. Continue with offset=${offset + limit}]` : "";
			const numbered = truncatedLine.map((line, i) => `${offset + i}\t${line}`).join("\n");
			return {
				content: [{ type: "text", text: `${header}\n${numbered}${nextHint}` }],
				details: { source: params.source, path: relPath, totalLines: lines.length, offset, returned: slice.length },
			};
		},
	});

	const docsSyncTool = defineTool({
		name: "docs_sync",
		label: "Docs sync",
		description:
			"Force a differential sync of the locally mirrored documentation (pi-docs-sync): probes llms.txt/llms-full.txt, downloads only new or changed pages (ETag/Last-Modified), prunes removed pages, updates the manifest. " +
			"Use when the user asks to refresh docs or a page is missing. Omit `source` to sync every configured source.",
		parameters: Type.Object({
			source: Type.Optional(Type.String({ description: "Restrict to one configured source name." })),
		}),
		promptSnippet: "Refresh the local official-docs mirror (pi-docs-sync)",
		promptGuidelines: ["docs_sync performs network I/O; use it only when the user asks for a refresh or local docs are clearly missing a needed page."],
		async execute(_id, params, _signal, onUpdate, ctx) {
			refreshRuntime(ctx.cwd);
			if (!runtime) return { content: [{ type: "text", text: "No documentation sources configured in this workspace." }], details: undefined, isError: true };
			const names = params.source ? [params.source] : Object.keys(runtime.config.sources);
			if (params.source && !runtime.config.sources[params.source]) {
				return { content: [{ type: "text", text: `Unknown source '${params.source}'. Configured: ${Object.keys(runtime.config.sources).join(", ")}.` }], details: undefined, isError: true };
			}
			const results = await syncNow(names, {
				force: true,
				onProgress: (message) =>
					onUpdate?.({
						content: [{ type: "text", text: message }],
						details: { progress: message },
					}),
			});
			runtime.hasMirrors = true;
			const body = results
				.map((r) => {
					if (r.skippedSync) return `${r.name}: up to date (TTL not expired) — nothing checked.`;
					const parts = [`+${r.fetched}`, `~${r.unchanged} unchanged`, `-${r.removed} removed`];
					if (r.skipped > 0) parts.push(`${r.skipped} skipped`);
					const line = `${r.name}: ${parts.join(", ")} (${formatBytes(r.bytes)}, ${(r.durationMs / 1000).toFixed(1)}s)`;
					return r.error ? `${line}\n  errors: ${r.error}` : line;
				})
				.join("\n");
			const failed = results.some((r) => r.error);
			return { content: [{ type: "text", text: body || "Nothing to sync." }], details: { results }, isError: failed || undefined };
		},
	});

	pi.registerTool(docsListTool);
	pi.registerTool(docsSearchTool);
	pi.registerTool(docsReadTool);
	pi.registerTool(docsSyncTool);

	// --- Lifecycle ---------------------------------------------------------------

	pi.on("session_start", (event, ctx) => {
		runtime = loadRuntime(ctx.cwd);
		syncAbort = new AbortController();
		if (!runtime) return;
		if (ctx.hasUI) ctx.ui.setStatus("docs-sync", `${Object.keys(runtime.config.sources).length} doc sources`);
		if (event.reason !== "startup" && event.reason !== "resume") return;
		queueDueSyncs(ctx);
		timer = setInterval(() => queueDueSyncs(ctx), TIMER_INTERVAL_MS);
		timer.unref?.();
	});

	pi.on("session_shutdown", () => {
		if (timer !== undefined) {
			clearInterval(timer);
			timer = undefined;
		}
		syncAbort.abort(new Error("session shutdown"));
		runtime = null;
	});

	pi.on("before_agent_start", async (event, ctx) => {
		refreshRuntime(ctx.cwd);
		if (!runtime) return undefined;
		const status = collectStatus(runtime);
		if (status.length === 0) return undefined;
		const list = status
			.map((s) => `- ${s.name} (${s.mode === "full" ? `llms-full.txt, ${formatBytes(s.bytes)}` : `${s.pages} pages, ${formatBytes(s.bytes)}`})`)
			.join("\n");
		return {
			systemPrompt: `${event.systemPrompt}\n\n## Local documentation mirror (pi-docs-sync)\nOfficial documentation is mirrored locally and refreshed in the background:\n${list}\nFor questions about these libraries, use docs_search / docs_read first (offline, token-efficient) before any web fetch.`,
		};
	});

	// --- /docs command -------------------------------------------------------------

	const syncCommand = async (names: readonly string[], ctx: { ui: { notify: (message: string, level?: "info" | "warning" | "error") => void } }): Promise<void> => {
		ctx.ui.notify(`pi-docs-sync: syncing ${names.join(", ")}…`, "info");
		const results = await syncNow(names, { force: true });
		for (const result of results) {
			if (result.error) ctx.ui.notify(`${result.name}: sync failed — ${result.error}`, "warning");
			else ctx.ui.notify(`${result.name}: +${result.fetched} fetched, ${result.unchanged} unchanged, ${result.removed} removed (${formatBytes(result.bytes)})`, "info");
		}
		if (runtime) runtime.hasMirrors = true;
	};

	pi.registerCommand("docs", {
		description: "Manage the local official-docs mirror (pi-docs-sync): add | remove | list | sync | status | path",
		getArgumentCompletions: (prefix) => {
			const subcommands = ["add", "remove", "list", "sync", "status", "path"].filter((s) => s.startsWith(prefix));
			return subcommands.length > 0 ? subcommands.map((value) => ({ value, label: value })) : null;
		},
		handler: async (args, ctx) => {
			const [subcommand, ...rest] = args.trim().split(/\s+/);
			const workspaceConfigPath = path.join(ctx.cwd, WORKSPACE_CONFIG_REL);

			if (!subcommand || subcommand === "status" || subcommand === "list") {
				if (!runtime) {
					ctx.ui.notify("pi-docs-sync: no .pi/docs.json found in this workspace. Add a source with `/docs add <name> <url>`.", "info");
					return;
				}
				ctx.ui.notify(`pi-docs-sync (storage: ${runtime.config.storage ?? "global"})\n${formatStatusTable(collectStatus(runtime))}`, "info");
				return;
			}

			if (subcommand === "add") {
				const [name, url, ttl] = rest as [string | undefined, string | undefined, string | undefined];
				if (!name || !url) {
					ctx.ui.notify("Usage: /docs add <name> <url> [ttlHours]\nExample: /docs add fastapi https://fastapi.tiangolo.com/ 168", "warning");
					return;
				}
				if (!isValidSourceName(name)) {
					ctx.ui.notify(`Invalid source name '${name}': use letters, digits, '.', '_', '-' (max 64 chars).`, "warning");
					return;
				}
				let parsedUrl: URL;
				try {
					parsedUrl = new URL(url);
				} catch {
					ctx.ui.notify(`Invalid URL '${url}'.`, "warning");
					return;
				}
				if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
					ctx.ui.notify("Only http(s) URLs are supported.", "warning");
					return;
				}
				const ttlHours = ttl !== undefined ? Number(ttl) : undefined;
				if (ttlHours !== undefined && (!Number.isFinite(ttlHours) || ttlHours <= 0)) {
					ctx.ui.notify("ttlHours must be a positive number.", "warning");
					return;
				}

				const workspaceConfig = readConfigFile(workspaceConfigPath) ?? { version: 1 as const, sources: {} };
				const sourceConfig: DocsSourceConfig = { url };
				if (ttlHours !== undefined) sourceConfig.ttlHours = ttlHours;
				workspaceConfig.sources[name] = sourceConfig;
				writeConfigFile(workspaceConfigPath, workspaceConfig);
				runtime = loadRuntime(ctx.cwd) ?? runtime;
				if (ctx.hasUI) ctx.ui.setStatus("docs-sync", `${runtime ? Object.keys(runtime.config.sources).length : 0} doc sources`);
				await syncCommand([name], ctx);
				return;
			}

			if (subcommand === "remove") {
				const [name] = rest as [string | undefined];
				if (!name) {
					ctx.ui.notify("Usage: /docs remove <name>", "warning");
					return;
				}
				const workspaceConfig = readConfigFile(workspaceConfigPath);
				if (workspaceConfig?.sources[name]) {
					delete workspaceConfig.sources[name];
					writeConfigFile(workspaceConfigPath, workspaceConfig);
					ctx.ui.notify(`Removed '${name}' from .pi/docs.json (mirror files kept on disk).`, "info");
				} else if (runtime?.globalConfig?.sources[name]) {
					ctx.ui.notify(`'${name}' is defined in the global config (~/.pi/agent/docs.json); remove it there.`, "warning");
					return;
				} else {
					ctx.ui.notify(`Unknown source '${name}'.`, "warning");
					return;
				}
				runtime = loadRuntime(ctx.cwd);
				if (ctx.hasUI) ctx.ui.setStatus("docs-sync", runtime ? `${Object.keys(runtime.config.sources).length} doc sources` : undefined);
				return;
			}

			if (subcommand === "sync") {
				if (!runtime) {
					ctx.ui.notify("pi-docs-sync: no sources configured.", "warning");
					return;
				}
				const [name] = rest as [string | undefined];
				const names = name ? [name] : Object.keys(runtime.config.sources);
				if (name && !runtime.config.sources[name]) {
					ctx.ui.notify(`Unknown source '${name}'. Configured: ${Object.keys(runtime.config.sources).join(", ")}.`, "warning");
					return;
				}
				await syncCommand(names, ctx);
				return;
			}

			if (subcommand === "path") {
				if (!runtime) {
					ctx.ui.notify("pi-docs-sync: no sources configured.", "info");
					return;
				}
				const [name] = rest as [string | undefined];
				if (name) {
					const status = collectStatus(runtime).find((s) => s.name === name);
					ctx.ui.notify(status ? status.root : `Unknown source '${name}'.`, "info");
				} else {
					ctx.ui.notify(runtime.mirrorRoot, "info");
				}
				return;
			}

			ctx.ui.notify(`Unknown subcommand '${subcommand ?? ""}'. Use: add | remove | list | sync | status | path`, "warning");
		},
	});
}
