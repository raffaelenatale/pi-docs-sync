/**
 * Parser for the /llms.txt convention (https://llmstxt.org) plus a fence-aware
 * Markdown section splitter used to shard `llms-full.txt` files.
 */

export interface LlmsLink {
	title: string;
	url: string;
	description?: string;
}

export interface LlmsSection {
	title: string;
	links: LlmsLink[];
}

export interface LlmsIndex {
	title?: string;
	description?: string;
	sections: LlmsSection[];
	/** Every link in document order, sections flattened. */
	allLinks: LlmsLink[];
}

/**
 * Parse an llms.txt document. Tolerant: unparsable lines are ignored, and any
 * `- [title](url)` list item counts as a link even outside a named section.
 */
export function parseLlmsTxt(text: string): LlmsIndex {
	const index: LlmsIndex = { sections: [], allLinks: [] };
	let current: LlmsSection | null = null;
	const seen = new Set<string>();

	for (const rawLine of text.split(/\r?\n/)) {
		const line = rawLine.trimEnd();
		if (line.startsWith("# ") && !line.startsWith("## ")) {
			index.title = line.slice(2).trim();
			current = null;
			continue;
		}
		if (line.startsWith("> ") && index.description === undefined) {
			index.description = line.slice(2).trim();
			continue;
		}
		if (/^#{2,6}\s+/.test(line)) {
			const title = line.replace(/^#{2,6}\s+/, "").trim();
			current = { title, links: [] };
			index.sections.push(current);
			continue;
		}
		const link = parseLinkLine(line);
		if (link && !seen.has(link.url)) {
			seen.add(link.url);
			if (!current) {
				current = { title: "", links: [] };
				index.sections.push(current);
			}
			current.links.push(link);
			index.allLinks.push(link);
		}
	}
	index.sections = index.sections.filter((s) => s.links.length > 0 || s.title.length > 0);
	return index;
}

/** Match `- [title](url): description` (bracket title, optional description). */
function parseLinkLine(line: string): LlmsLink | null {
	const m = /^[-*]\s+\[([^\]]+)\]\((\S+?)(?:\s+"[^"]*")?\)(?:\s*:\s*(.*))?$/.exec(line.trim());
	if (!m) return null;
	const [, title, url, description] = m as unknown as [string, string, string, string?];
	return { title: title.trim(), url: url.trim(), description: description?.trim() || undefined };
}

/** Resolve a link href against the index URL; returns null for non-http(s) schemes. */
export function resolveLinkUrl(href: string, baseUrl: string): string | null {
	try {
		const resolved = new URL(href, baseUrl);
		if (resolved.protocol !== "http:" && resolved.protocol !== "https:") return null;
		resolved.hash = "";
		return resolved.toString();
	} catch {
		return null;
	}
}

export interface MdSection {
	title: string;
	slug: string;
	/** 1-based line where the section heading lives. */
	startLine: number;
	endLine: number;
}

/** Filesystem-safe slug. */
export function slugify(text: string): string {
	const slug = text
		.toLowerCase()
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 64);
	return slug || "section";
}

/**
 * Split Markdown into sections at `#` or `##` headings that live outside code
 * fences. The preamble before the first heading becomes a section with
 * `title: ""` (only when non-empty).
 */
export function splitMarkdownSections(text: string): MdSection[] {
	const lines = text.split(/\r?\n/);
	const marks: Array<{ title: string; line: number }> = [];
	let inFence = false;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] as string;
		if (/^\s*(```|~~~)/.test(line)) {
			inFence = !inFence;
			continue;
		}
		if (!inFence && /^#{1,2}\s+\S/.test(line)) {
			marks.push({ title: line.replace(/^#{1,2}\s+/, "").trim(), line: i + 1 });
		}
	}

	const sections: MdSection[] = [];
	const usedSlugs = new Map<string, number>();
	for (let i = 0; i < marks.length; i++) {
		const mark = marks[i] as { title: string; line: number };
		const endLine = i + 1 < marks.length ? (marks[i + 1] as { line: number }).line - 1 : lines.length;
		let slug = slugify(mark.title);
		const seen = usedSlugs.get(slug) ?? 0;
		usedSlugs.set(slug, seen + 1);
		if (seen > 0) slug = `${slug}-${seen + 1}`;
		sections.push({ title: mark.title, slug, startLine: mark.line, endLine });
	}
	if (marks.length === 0 || (marks[0] as { line: number }).line > 1) {
		const firstContent = lines.findIndex((l) => l.trim().length > 0);
		if (firstContent !== -1) {
			const preambleEnd = marks.length > 0 ? (marks[0] as { line: number }).line - 1 : lines.length;
			if (firstContent < preambleEnd || (marks.length === 0 && lines.length > 0)) {
				sections.unshift({ title: "", slug: "preamble", startLine: 1, endLine: preambleEnd });
			}
		}
	}
	return sections;
}
