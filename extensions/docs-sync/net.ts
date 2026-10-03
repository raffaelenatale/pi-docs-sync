/** HTTP helpers: conditional GET (ETag / Last-Modified), hashing, bounded concurrency. */

import { createHash } from "node:crypto";

export const USER_AGENT = "pi-docs-sync/0.1 (local documentation mirror)";

export interface ConditionalFetchInput {
	url: string;
	etag?: string;
	lastModified?: string;
	timeoutMs?: number;
	signal?: AbortSignal;
	maxBytes?: number;
	/** Return status/headers only and cancel the body (discovery probing). */
	probeOnly?: boolean;
}

export interface ConditionalFetchResult {
	/** 200 (fresh body), 304 (not modified), or the failing status / 0 on network error. */
	status: number;
	ok: boolean;
	body?: string;
	finalUrl: string;
	etag?: string;
	lastModified?: string;
	contentType?: string;
	bytes: number;
	error?: string;
}

/** Conditional GET with redirect following, timeout and size cap. */
export async function conditionalFetch(input: ConditionalFetchInput): Promise<ConditionalFetchResult> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(new Error("timeout")), input.timeoutMs ?? 20_000);
	const onExternalAbort = () => controller.abort(input.signal?.reason);
	input.signal?.addEventListener("abort", onExternalAbort, { once: true });
	try {
		const headers: Record<string, string> = { "user-agent": USER_AGENT, "accept": "text/markdown, text/plain; q=0.9, */*; q=0.1" };
		if (input.etag) headers["if-none-match"] = input.etag;
		if (input.lastModified) headers["if-modified-since"] = input.lastModified;

		const response = await fetch(input.url, { headers, redirect: "follow", signal: controller.signal });
		const etag = response.headers.get("etag") ?? undefined;
		const lastModified = response.headers.get("last-modified") ?? undefined;
		const contentType = response.headers.get("content-type") ?? undefined;
		const finalUrl = response.url || input.url;

		if (response.status === 304) {
			return { status: 304, ok: true, finalUrl, etag, lastModified, contentType, bytes: 0 };
		}
		if (!response.ok) {
			return { status: response.status, ok: false, finalUrl, etag, lastModified, contentType, bytes: 0, error: `HTTP ${response.status}` };
		}

		if (input.probeOnly) {
			try {
				await response.body?.cancel();
			} catch {
				// body already consumed or stream unavailable
			}
			return { status: 200, ok: true, finalUrl, etag, lastModified, contentType, bytes: 0 };
		}

		const raw = await response.text();
		const body = input.maxBytes !== undefined && raw.length > input.maxBytes ? undefined : raw;
		return {
			status: 200,
			ok: true,
			body,
			finalUrl,
			etag,
			lastModified,
			contentType,
			bytes: raw.length,
			error: body === undefined ? `body exceeds ${input.maxBytes} bytes` : undefined,
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { status: 0, ok: false, finalUrl: input.url, bytes: 0, error: message };
	} finally {
		clearTimeout(timeout);
		input.signal?.removeEventListener("abort", onExternalAbort);
	}
}

export function sha256(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Heuristic: does this look like an llms.txt/markdown document and not an SPA catch-all HTML page? */
export function looksLikeLlmsTxt(body: string, contentType?: string): boolean {
	if (contentType && /\btext\/html\b/i.test(contentType)) return false;
	const head = body.slice(0, 2048);
	return head.startsWith("#") || /(^|\n)\s*[-*]\s*\[[^\]]+\]\(/.test(head);
}

/** Map over items with at most `limit` promises in flight; preserves order. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;
	const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
		while (true) {
			const index = next++;
			if (index >= items.length) return;
			results[index] = await fn(items[index] as T, index);
		}
	});
	await Promise.all(workers);
	return results;
}
