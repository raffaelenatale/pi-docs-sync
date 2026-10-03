/**
 * Mirror engine: URL -> structured local path mapping, manifest persistence and
 * the differential sync loop (probe -> conditional GET -> write-if-changed).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { effectiveTtlHours } from "./config.ts";
import { parseLlmsTxt, resolveLinkUrl, splitMarkdownSections } from "./llms-txt.ts";
import { conditionalFetch, looksLikeLlmsTxt, mapLimit, sha256 } from "./net.ts";
import type { DocsConfig, DocsSourceConfig, PageRecord, SkippedRecord, SourceManifest, SyncOptions, SyncResult } from "./types.ts";

/** Mirror root for a config: global agent dir (default) or workspace `.pi/docs-mirror/`. */
export function mirrorRootFor(config: DocsConfig, cwd: string, agentDir: string): string {
	return config.storage === "workspace" ? path.join(cwd, ".pi", "docs-mirror") : path.join(agentDir, "docs-mirror");
}

export function sourceRootFor(root: string, name: string): string {
	return path.join(root, name);
}

export function manifestPath(sourceRoot: string): string {
	return path.join(sourceRoot, "manifest.json");
}

export function readManifest(sourceRoot: string): SourceManifest | null {
	try {
		const raw = JSON.parse(fs.readFileSync(manifestPath(sourceRoot), "utf8")) as SourceManifest;
		if (raw && raw.version === 1 && typeof raw.name === "string") return raw;
		return null;
	} catch {
		return null;
	}
}

export function writeManifest(sourceRoot: string, manifest: SourceManifest): void {
	fs.mkdirSync(sourceRoot, { recursive: true });
	const tmp = `${manifestPath(sourceRoot)}.tmp-${process.pid}`;
	fs.writeFileSync(tmp, JSON.stringify(manifest, null, "\t") + "\n", "utf8");
	fs.renameSync(tmp, manifestPath(sourceRoot));
}

/** True when the source's TTL has expired (or it was never synced). */
export function isDue(manifest: SourceManifest | null, ttlHours: number, now = Date.now()): boolean {
	if (!manifest?.lastCheckedAt) return true;
	return now - manifest.lastCheckedAt >= ttlHours * 3_600_000;
}

/** Convert a glob with `*` (no `/`) and `**` (any) into a RegExp. */
export function globToRegExp(pattern: string): RegExp {
	let source = "";
	for (let i = 0; i < pattern.length; i++) {
		const ch = pattern[i] as string;
		if (ch === "*") {
			if (pattern[i + 1] === "*") {
				source += ".*";
				i++;
			} else {
				source += "[^/]*";
			}
		} else if ("\\^$.|?+()[]{}".includes(ch)) {
			source += `\\${ch}`;
		} else {
			source += ch;
		}
	}
	return new RegExp(`^${source}$`);
}

export function compileFilters(config: DocsSourceConfig): { include: RegExp[]; exclude: RegExp[] } {
	return {
		include: (config.include ?? []).map(globToRegExp),
		exclude: (config.exclude ?? []).map(globToRegExp),
	};
}

export function passesFilters(pathname: string, filters: { include: RegExp[]; exclude: RegExp[] }): boolean {
	if (filters.include.length > 0 && !filters.include.some((re) => re.test(pathname))) return false;
	if (filters.exclude.some((re) => re.test(pathname))) return false;
	return true;
}

const MAX_SEGMENT = 80;

function sanitizeSegment(segment: string): string {
	const transliterated = segment.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
	const cleaned = transliterated.replace(/[^A-Za-z0-9._~@=+,-]/g, "-").replace(/^\.+/, "").slice(0, MAX_SEGMENT);
	return cleaned.length > 0 ? cleaned : "-";
}

/**
 * Map a URL onto a structured local path: `<host>/<decoded path segments>.md`.
 * Query/fragments are dropped, traversal segments are rejected (never escaping
 * the mirror root), extensionless pages get `.md`, `.html` becomes `.md`.
 */
export function urlToLocalPath(urlString: string): string | null {
	let parsed: URL;
	try {
		parsed = new URL(urlString);
	} catch {
		return null;
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;

	const host = sanitizeSegment(parsed.hostname.toLowerCase()) + (parsed.port ? `-${sanitizeSegment(parsed.port)}` : "");
	let decoded: string;
	try {
		decoded = decodeURIComponent(parsed.pathname);
	} catch {
		decoded = parsed.pathname;
	}
	const rawSegments = decoded.split("/");
	// Split AFTER decoding so encoded slashes mirror server-side nesting; encoded
	// `..` segments are refused (the WHATWG parser already normalizes literal dots).
	const isDirectory = decoded.endsWith("/");
	if (rawSegments[rawSegments.length - 1] === "") rawSegments.pop();
	if (rawSegments[0] === "") rawSegments.shift();
	if (rawSegments.length === 0) rawSegments.push("index.md");
	else if (isDirectory) rawSegments.push("index.md");

	const segments: string[] = [];
	for (const segment of rawSegments) {
		if (segment === "." || segment === "..") return null; // traversal attempt: refuse to map
		segments.push(sanitizeSegment(segment));
	}

	const last = segments[segments.length - 1] as string;
	if (last.endsWith(".html") || last.endsWith(".htm")) segments[segments.length - 1] = `${last.slice(0, last.lastIndexOf("."))}.md`;
	else if (!last.includes(".")) segments[segments.length - 1] = `${last}.md`;

	return [host, ...segments].join("/");
}

export interface PlanDiff {
	/** URLs absent from the manifest or missing validators: they need a full body fetch. */
	toCheck: string[];
	/** Manifest-tracked URLs with validators: revalidated cheaply via conditional GET. */
	toRevalidate: string[];
	/** Manifest keys no longer referenced by the index. */
	toDelete: string[];
}

/** Pure diff between the manifest pages and the URLs the index currently references. */
export function planPageSync(manifestPages: Record<string, PageRecord>, requestedUrls: readonly string[]): PlanDiff {
	const wanted = new Set(requestedUrls);
	const toCheck: string[] = [];
	const toRevalidate: string[] = [];
	for (const url of requestedUrls) {
		const record = manifestPages[url];
		if (!record || (record.etag === undefined && record.lastModified === undefined)) toCheck.push(url);
		else toRevalidate.push(url);
	}
	const toDelete = Object.keys(manifestPages).filter((url) => !wanted.has(url));
	return { toCheck, toRevalidate, toDelete };
}

/** First available variant of `path` (`.md` suffix assumed) not already used. */
export function dedupeLocalPath(localPath: string, usedPaths: ReadonlySet<string>): string {
	if (!usedPaths.has(localPath)) return localPath;
	const base = localPath.replace(/\.md$/, "");
	let i = 2;
	while (usedPaths.has(`${base}-${i}.md`)) i++;
	return `${base}-${i}.md`;
}

function atomicWrite(filePath: string, content: string): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	const tmp = `${filePath}.tmp-${process.pid}`;
	fs.writeFileSync(tmp, content, "utf8");
	fs.renameSync(tmp, filePath);
}

interface Discovery {
	mode: "tree" | "full";
	indexUrl?: string;
	fullUrl?: string;
	title?: string;
}

async function discover(cfg: DocsSourceConfig, opts: SyncOptions): Promise<Discovery | null> {
	const base = cfg.url.replace(/\/+$/, "");
	const directPath = (() => {
		try {
			return decodeURIComponent(new URL(cfg.url).pathname);
		} catch {
			return "";
		}
	})();

	if (directPath.endsWith("/llms-full.txt")) return { mode: "full", fullUrl: cfg.url };
	if (directPath.endsWith("/llms.txt")) return { mode: "tree", indexUrl: cfg.url };

	const probe = async (url: string): Promise<boolean> => {
		const result = await conditionalFetch({ url, probeOnly: true, timeoutMs: opts.timeoutMs, signal: opts.signal });
		return result.ok && result.status === 200 && !(result.contentType && /\btext\/html\b/i.test(result.contentType));
	};

	if (await probe(`${base}/llms-full.txt`)) return { mode: "full", fullUrl: `${base}/llms-full.txt` };
	if (await probe(`${base}/llms.txt`)) return { mode: "tree", indexUrl: `${base}/llms.txt` };
	return null;
}

async function syncFullMode(name: string, cfg: DocsSourceConfig, fullUrl: string, manifest: SourceManifest, sourceRoot: string, opts: SyncOptions): Promise<SyncResult> {
	const started = Date.now();
	const result = await conditionalFetch({
		url: fullUrl,
		etag: manifest.etag,
		lastModified: manifest.lastModified,
		timeoutMs: opts.timeoutMs,
		signal: opts.signal,
		maxBytes: opts.maxPageBytes,
	});

	if (!result.ok) {
		manifest.lastError = result.error ?? `HTTP ${result.status}`;
		manifest.lastErrorAt = Date.now();
		manifest.lastCheckedAt = Date.now() - 3_540_000; // retry in ~1h instead of a full TTL
		writeManifest(sourceRoot, manifest);
		return { name, mode: "full", fetched: 0, unchanged: 0, removed: 0, skipped: 0, skippedSync: false, bytes: 0, durationMs: Date.now() - started, error: manifest.lastError };
	}

	let fetched = 0;
	let unchanged = 0;
	let bytes = 0;

	if (result.status === 304) {
		unchanged = 1;
	} else if (result.body !== undefined && looksLikeLlmsTxt(result.body, result.contentType)) {
		const sectionsDir = path.join(sourceRoot, "sections");
		fs.rmSync(sectionsDir, { recursive: true, force: true });
		atomicWrite(path.join(sourceRoot, "full.md"), result.body);
		const lines = result.body.split(/\r?\n/);
		const sections = splitMarkdownSections(result.body);
		const sectionIndex: Array<{ file: string; title: string; startLine: number; endLine: number }> = [];
		for (const [position, section] of sections.entries()) {
			const file = `${String(position + 1).padStart(3, "0")}-${section.slug}.md`;
			const content = lines.slice(section.startLine - 1, section.endLine).join("\n");
			atomicWrite(path.join(sectionsDir, file), content.endsWith("\n") ? content : `${content}\n`);
			sectionIndex.push({ file, title: section.title, startLine: section.startLine, endLine: section.endLine });
		}
		atomicWrite(path.join(sectionsDir, "index.json"), JSON.stringify(sectionIndex, null, "\t") + "\n");
		manifest.fullUrl = result.finalUrl;
		manifest.etag = result.etag;
		manifest.lastModified = result.lastModified;
		manifest.sha256 = sha256(result.body);
		manifest.bytes = result.bytes;
		manifest.title = parseLlmsTxt(result.body).title;
		fetched = 1;
		bytes = result.bytes;
	} else {
		manifest.lastError = "llms-full.txt not found or not markdown";
		manifest.lastErrorAt = Date.now();
		writeManifest(sourceRoot, manifest);
		return { name, mode: "full", fetched: 0, unchanged: 0, removed: 0, skipped: 0, skippedSync: false, bytes: 0, durationMs: Date.now() - started, error: manifest.lastError };
	}

	manifest.lastCheckedAt = Date.now();
	manifest.lastSyncAt = Date.now();
	delete manifest.lastError;
	writeManifest(sourceRoot, manifest);
	return { name, mode: "full", fetched, unchanged, removed: 0, skipped: 0, skippedSync: false, bytes, durationMs: Date.now() - started };
}

async function syncTreeMode(name: string, cfg: DocsSourceConfig, indexUrl: string, manifest: SourceManifest, sourceRoot: string, opts: SyncOptions): Promise<SyncResult> {
	const started = Date.now();
	const indexFetch = await conditionalFetch({
		url: indexUrl,
		etag: manifest.etag,
		lastModified: manifest.lastModified,
		timeoutMs: opts.timeoutMs,
		signal: opts.signal,
		maxBytes: opts.maxPageBytes,
	});

	if (!indexFetch.ok) {
		manifest.lastError = indexFetch.error ?? `HTTP ${indexFetch.status}`;
		manifest.lastErrorAt = Date.now();
		manifest.lastCheckedAt = Date.now() - 3_540_000;
		writeManifest(sourceRoot, manifest);
		return { name, mode: "tree", fetched: 0, unchanged: 0, removed: 0, skipped: 0, skippedSync: false, bytes: 0, durationMs: Date.now() - started, error: manifest.lastError };
	}

	const filters = compileFilters(cfg);
	let requestedUrls: string[] = [];
	let indexChanged = false;

	if (indexFetch.status === 304) {
		requestedUrls = Object.keys(manifest.pages);
	} else if (indexFetch.body !== undefined && looksLikeLlmsTxt(indexFetch.body, indexFetch.contentType)) {
		const index = parseLlmsTxt(indexFetch.body);
		const indexOrigin = new URL(indexFetch.finalUrl).origin;
		const seen = new Set<string>();
		for (const link of index.allLinks) {
			const resolved = resolveLinkUrl(link.url, indexFetch.finalUrl);
			if (!resolved || seen.has(resolved)) continue;
			const target = new URL(resolved);
			if (target.origin !== indexOrigin && !cfg.allowExternal) continue;
			if (!passesFilters(decodeURIComponent(target.pathname), filters)) {
				const skipped: SkippedRecord = manifest.skipped[resolved] ?? { url: resolved, reason: "", checkedAt: 0 };
				skipped.reason = "filtered by include/exclude";
				skipped.checkedAt = Date.now();
				manifest.skipped[resolved] = skipped;
				continue;
			}
			seen.add(resolved);
			requestedUrls.push(resolved);
		}
		manifest.indexUrl = indexFetch.finalUrl;
		manifest.title = index.title;
		manifest.etag = indexFetch.etag;
		manifest.lastModified = indexFetch.lastModified;
		indexChanged = true;
	} else {
		manifest.lastError = "llms.txt not found or not markdown";
		manifest.lastErrorAt = Date.now();
		writeManifest(sourceRoot, manifest);
		return { name, mode: "tree", fetched: 0, unchanged: 0, removed: 0, skipped: 0, skippedSync: false, bytes: 0, durationMs: Date.now() - started, error: manifest.lastError };
	}

	opts.onProgress?.(`${name}: ${requestedUrls.length} pages referenced by index`);

	const usedPaths = new Set<string>(Object.values(manifest.pages).map((p) => p.path));
	let fetched = 0;
	let unchanged = 0;
	let skippedCount = 0;
	let bytes = 0;
	let hadError: string | undefined;

	await mapLimit(requestedUrls, opts.concurrency ?? 5, async (url) => {
		if (opts.signal?.aborted) return;
		const previous = manifest.pages[url];
		const pageFetch = await conditionalFetch({
			url,
			etag: previous?.etag,
			lastModified: previous?.lastModified,
			timeoutMs: opts.timeoutMs,
			signal: opts.signal,
			maxBytes: opts.maxPageBytes,
		});

		if (!pageFetch.ok) {
			skippedCount++;
			hadError = hadError ?? `${url}: ${pageFetch.error ?? `HTTP ${pageFetch.status}`}`;
			const skipped: SkippedRecord = manifest.skipped[url] ?? { url, reason: "", checkedAt: 0 };
			skipped.reason = pageFetch.error ?? `HTTP ${pageFetch.status}`;
			skipped.checkedAt = Date.now();
			manifest.skipped[url] = skipped;
			return;
		}

		if (pageFetch.status === 304 && previous) {
			previous.checkedAt = Date.now();
			unchanged++;
			return;
		}
		if (pageFetch.body === undefined) {
			skippedCount++;
			const skipped: SkippedRecord = manifest.skipped[url] ?? { url, reason: "", checkedAt: 0 };
			skipped.reason = pageFetch.error ?? "empty body";
			skipped.checkedAt = Date.now();
			manifest.skipped[url] = skipped;
			return;
		}

		const finalOrigin = new URL(pageFetch.finalUrl).origin;
		const requestedOrigin = new URL(url).origin;
		const pathSource = finalOrigin === requestedOrigin ? pageFetch.finalUrl : url;
		const mappedPath = urlToLocalPath(pathSource) ?? urlToLocalPath(url);
		if (!mappedPath) {
			skippedCount++;
			return;
		}
		const localPath =
			previous && previous.path === mappedPath ? mappedPath : dedupeLocalPath(mappedPath, usedPaths);

		const hash = sha256(pageFetch.body);
		const absolutePath = path.join(sourceRoot, localPath);
		const needsWrite = !fs.existsSync(absolutePath) || sha256(fs.readFileSync(absolutePath, "utf8")) !== hash;
		if (needsWrite) atomicWrite(absolutePath, pageFetch.body);

		if (previous && previous.path !== localPath) {
			try {
				fs.rmSync(path.join(sourceRoot, previous.path), { force: true });
			} catch {
				// previous file already gone
			}
			usedPaths.delete(previous.path);
		}
		usedPaths.add(localPath);

		const record: PageRecord = {
			requestedUrl: url,
			finalUrl: pageFetch.finalUrl,
			redirectedExternal: finalOrigin !== requestedOrigin || undefined,
			path: localPath,
			etag: pageFetch.etag,
			lastModified: pageFetch.lastModified,
			sha256: hash,
			bytes: pageFetch.bytes,
			contentType: pageFetch.contentType,
			fetchedAt: needsWrite ? Date.now() : (previous?.fetchedAt ?? Date.now()),
			checkedAt: Date.now(),
		};
		manifest.pages[url] = record;
		if (needsWrite) {
			fetched++;
			bytes += pageFetch.bytes;
		} else {
			unchanged++;
		}
	});

	// Remove pages the index no longer references (or a changed filter excludes).
	let removed = 0;
	if (indexChanged) {
		const wanted = new Set(requestedUrls);
		for (const [url, record] of Object.entries(manifest.pages)) {
			if (wanted.has(url)) continue;
			try {
				fs.rmSync(path.join(sourceRoot, record.path), { force: true });
			} catch {
				// ignore
			}
			delete manifest.pages[url];
			removed++;
		}
	}

	manifest.lastCheckedAt = Date.now();
	manifest.lastSyncAt = Date.now();
	if (hadError) {
		manifest.lastError = hadError;
		manifest.lastErrorAt = Date.now();
	} else {
		delete manifest.lastError;
	}
	writeManifest(sourceRoot, manifest);
	return { name, mode: "tree", fetched, unchanged, removed, skipped: skippedCount, skippedSync: false, bytes, durationMs: Date.now() - started, error: hadError };
}

const inFlight = new Map<string, Promise<SyncResult>>();

/** Serialize syncs per source name so a manual sync and the TTL timer cannot race. */
export function syncSourceQueued(name: string, cfg: DocsSourceConfig, config: DocsConfig, sourceRoot: string, opts: SyncOptions = {}): Promise<SyncResult> {
	const previous = inFlight.get(name) ?? Promise.resolve();
	const next = previous.catch(() => undefined).then(() => syncSource(name, cfg, config, sourceRoot, opts));
	inFlight.set(name, next);
	next.finally(() => {
		if (inFlight.get(name) === next) inFlight.delete(name);
	}).catch(() => undefined);
	return next;
}

/** One differential sync of a source: discovery + conditional fetches + manifest update. */
export async function syncSource(name: string, cfg: DocsSourceConfig, config: DocsConfig, sourceRoot: string, opts: SyncOptions = {}): Promise<SyncResult> {
	fs.mkdirSync(sourceRoot, { recursive: true });
	const manifest: SourceManifest = readManifest(sourceRoot) ?? {
		version: 1,
		name,
		mode: "tree",
		config: cfg,
		pages: {},
		skipped: {},
	};

	if (!opts.force && manifest.lastCheckedAt && !isDue(manifest, effectiveTtlHours(config, cfg))) {
		return { name, mode: manifest.mode, fetched: 0, unchanged: 0, removed: 0, skipped: 0, skippedSync: true, bytes: 0, durationMs: 0 };
	}

	const discovery = await discover(cfg, opts);
	if (!discovery) {
		manifest.lastError = `no llms.txt or llms-full.txt found at ${cfg.url}`;
		manifest.lastErrorAt = Date.now();
		writeManifest(sourceRoot, manifest);
		return { name, mode: manifest.mode, fetched: 0, unchanged: 0, removed: 0, skipped: 0, skippedSync: false, bytes: 0, durationMs: 0, error: manifest.lastError };
	}
	manifest.mode = discovery.mode;

	if (discovery.mode === "full") {
		return syncFullMode(name, cfg, discovery.fullUrl as string, manifest, sourceRoot, opts);
	}
	return syncTreeMode(name, cfg, discovery.indexUrl as string, manifest, sourceRoot, opts);
}
