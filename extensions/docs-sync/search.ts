/** Local search over the mirrored markdown: multi-term scoring with line snippets. No dependencies. */

import * as fs from "node:fs";
import * as path from "node:path";
import type { SearchHit } from "./types.ts";

const MAX_FILE_BYTES = 512 * 1024;
const SNIPPET_MAX_CHARS = 240;

interface IndexedFile {
	source: string;
	relPath: string;
	title: string;
	lines: string[];
}

/** Tokenize for matching: lowercase alphanumeric runs. */
export function tokenize(text: string): string[] {
	return (text.toLowerCase().match(/[a-z0-9_]+/g) ?? []).filter((t) => t.length > 1);
}

/** Pure scorer: rank files for a query; every term must appear (AND) for full score. */
export function scoreFile(terms: string[], fileLines: readonly string[]): { score: number; matchedLines: Map<number, number> } {
	if (terms.length === 0) return { score: 0, matchedLines: new Map() };
	const matchedLines = new Map<number, number>();
	const termHits = new Map<string, number>();
	for (let i = 0; i < fileLines.length; i++) {
		const tokens = tokenize(fileLines[i] as string);
		if (tokens.length === 0) continue;
		const unique = new Set(tokens);
		let lineHits = 0;
		for (const term of terms) {
			if (unique.has(term)) {
				termHits.set(term, (termHits.get(term) ?? 0) + 1);
				lineHits++;
			}
		}
		if (lineHits > 0) matchedLines.set(i, lineHits);
	}
	let score = 0;
	for (const term of terms) {
		const hits = termHits.get(term) ?? 0;
		if (hits === 0) return { score: 0, matchedLines: new Map() }; // AND semantics
		score += 1 + Math.min(hits, 10); // every present term contributes; frequency saturates
	}
	return { score, matchedLines };
}

/** Best matching lines of a file, ordered by hits then position. */
export function pickSnippets(matchedLines: Map<number, number>, lines: readonly string[], limit: number): Array<{ line: number; text: string }> {
	const candidates = [...matchedLines.entries()]
		.sort((a, b) => (b[1] as number) - (a[1] as number) || (a[0] as number) - (b[0] as number))
		.slice(0, limit)
		.sort((a, b) => (a[0] as number) - (b[0] as number));
	return candidates.map(([index]) => {
		const text = (lines[index] as string).trim();
		return { line: index + 1, text: text.length > SNIPPET_MAX_CHARS ? `${text.slice(0, SNIPPET_MAX_CHARS)}…` : text };
	});
}

function readIndexedFile(root: string, relPath: string, source: string): IndexedFile | null {
	const absolute = path.join(root, relPath);
	try {
		const stat = fs.statSync(absolute);
		if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return null;
		const text = fs.readFileSync(absolute, "utf8");
		let title = "";
		for (const line of text.split(/\r?\n/)) {
			const heading = /^#{1,3}\s+(.+)/.exec(line);
			if (heading) {
				title = (heading[1] as string).trim();
				break;
			}
		}
		return { source, relPath, title, lines: text.split(/\r?\n/) };
	} catch {
		return null;
	}
}

/** List searchable files of one source: everything except `full.md` (sections already shard it). */
export function listSourceFiles(sourceRoot: string, source: string): string[] {
	const files: string[] = [];
	const walk = (dir: string, prefix: string) => {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
			if (entry.isDirectory()) {
				walk(path.join(dir, entry.name), rel);
			} else if (entry.isFile() && entry.name.endsWith(".md") && rel !== "full.md") {
				files.push(rel);
			}
		}
	};
	walk(sourceRoot, "");
	return files;
}

export interface SearchOptions {
	limit?: number;
	snippetsPerFile?: number;
	signal?: AbortSignal;
}

/** Search one source root. Returns ranked hits; empty when nothing matches. */
export function searchSource(sourceRoot: string, source: string, query: string, options: SearchOptions = {}): SearchHit[] {
	const terms = tokenize(query);
	if (terms.length === 0) return [];
	const limit = options.limit ?? 8;
	const hits: SearchHit[] = [];
	for (const relPath of listSourceFiles(sourceRoot, source)) {
		if (options.signal?.aborted) break;
		const file = readIndexedFile(sourceRoot, relPath, source);
		if (!file) continue;
		const { score, matchedLines } = scoreFile(terms, file.lines);
		if (score <= 0 || matchedLines.size === 0) continue;
		hits.push({
			source,
			path: relPath,
			title: file.title || relPath,
			score: score + (file.title.toLowerCase().includes(terms[0] as string) ? 2 : 0),
			snippets: pickSnippets(matchedLines, file.lines, options.snippetsPerFile ?? 3),
		});
	}
	hits.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
	return hits.slice(0, limit);
}

/** Search across several sources (name -> root), merging results. */
export function searchMirror(sources: ReadonlyArray<{ name: string; root: string }>, query: string, options: SearchOptions = {}): SearchHit[] {
	const hits: SearchHit[] = [];
	for (const { name, root } of sources) {
		if (options.signal?.aborted) break;
		hits.push(...searchSource(root, name, query, options));
	}
	hits.sort((a, b) => b.score - a.score || a.source.localeCompare(b.source) || a.path.localeCompare(b.path));
	return hits.slice(0, options.limit ?? 8);
}
