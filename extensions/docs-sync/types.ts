/** Shared types for pi-docs-sync. */

/** Configuration for one documentation source inside `.pi/docs.json`. */
export interface DocsSourceConfig {
	/**
	 * Base URL of the documentation site (e.g. `https://fastapi.tiangolo.com/`)
	 * or a direct URL to `llms.txt` / `llms-full.txt`.
	 */
	url: string;
	/** Hours between background refresh checks. Default: 168 (7 days). */
	ttlHours?: number;
	/** Glob patterns (matched against the URL path) to keep. Empty = keep all. */
	include?: string[];
	/** Glob patterns (matched against the URL path) to skip. Applied after `include`. */
	exclude?: string[];
	/** Allow pages on other hosts referenced from the index. Default: false. */
	allowExternal?: boolean;
}

/** Workspace (or global) configuration file. */
export interface DocsConfig {
	version: 1;
	/** Where mirrors are stored: `global` (agent dir, shared across workspaces) or `workspace` (`.pi/docs-mirror/`). Default: `global`. */
	storage?: "global" | "workspace";
	/** Default TTL applied to sources without an explicit `ttlHours`. */
	defaultTtlHours?: number;
	/** Named documentation sources. */
	sources: Record<string, DocsSourceConfig>;
}

/** One mirrored page tracked in the manifest. */
export interface PageRecord {
	/** URL originally referenced by the index. */
	requestedUrl: string;
	/** Final URL after redirects (same-origin redirects only). */
	finalUrl: string;
	/** True when the redirect left the original origin. */
	redirectedExternal?: boolean;
	/** Path relative to the source mirror root. */
	path: string;
	etag?: string;
	lastModified?: string;
	sha256: string;
	bytes: number;
	contentType?: string;
	/** Epoch ms of the last successful download. */
	fetchedAt: number;
	/** Epoch ms of the last conditional check (200 or 304). */
	checkedAt: number;
}

/** A page seen in the index but skipped (non-textual content, filtered out, too large, failed). */
export interface SkippedRecord {
	url: string;
	reason: string;
	checkedAt: number;
}

/** Per-source manifest stored as `<mirrorRoot>/<source>/manifest.json`. */
export interface SourceManifest {
	version: 1;
	name: string;
	/** `tree`: llms.txt index expanded into pages. `full`: single llms-full.txt file. */
	mode: "tree" | "full";
	config: DocsSourceConfig;
	/** URL of the discovered llms.txt (tree mode). */
	indexUrl?: string;
	/** URL of the discovered llms-full.txt (full mode). */
	fullUrl?: string;
	title?: string;
	/** Conditional-request validators + hash of the primary artifact (full mode). */
	etag?: string;
	lastModified?: string;
	sha256?: string;
	bytes?: number;
	/** Mirrored pages keyed by requested URL (tree mode). */
	pages: Record<string, PageRecord>;
	/** Index-referenced pages that were not mirrored. */
	skipped: Record<string, SkippedRecord>;
	/** Epoch ms of the last completed sync attempt (success or failure). */
	lastCheckedAt?: number;
	/** Epoch ms of the last successful sync. */
	lastSyncAt?: number;
	lastError?: string;
	lastErrorAt?: number;
}

export interface SyncOptions {
	/** Parallel page downloads. Default: 5. */
	concurrency?: number;
	/** Per-request timeout ms. Default: 20000. */
	timeoutMs?: number;
	/** Max bytes per page. Default: 4 MiB. */
	maxPageBytes?: number;
	/** Force revalidation even when TTL has not expired. */
	force?: boolean;
	signal?: AbortSignal;
	/** Progress callback. */
	onProgress?: (message: string) => void;
}

export interface SyncResult {
	name: string;
	mode: "tree" | "full";
	/** Pages downloaded fresh. */
	fetched: number;
	/** Pages answered 304 Not Modified. */
	unchanged: number;
	/** Pages removed because the index no longer references them. */
	removed: number;
	/** Pages skipped (filtered, non-text, too large, errors). */
	skipped: number;
	/** True when the TTL had not expired and nothing was checked. */
	skippedSync: boolean;
	bytes: number;
	durationMs: number;
	error?: string;
}

/** A single search hit. */
export interface SearchHit {
	source: string;
	path: string;
	title: string;
	score: number;
	snippets: Array<{ line: number; text: string }>;
}
