import assert from "node:assert/strict";
import { test } from "node:test";
import { parseLlmsTxt, resolveLinkUrl, slugify, splitMarkdownSections } from "../extensions/docs-sync/llms-txt.ts";

const SAMPLE = `# FastAPI

> FastAPI framework, high performance, easy to learn, fast to code

## Learn

- [Tutorial](tutorial/index.md): The basics
- [Advanced](advanced.md "quoted title")

## Reference

- [Router](reference/router.md)
- [External](https://other.example.com/page.md)

- [Loose link](guide/loose.md)
`;

test("parseLlmsTxt extracts title, description, sections and links", () => {
	const index = parseLlmsTxt(SAMPLE);
	assert.equal(index.title, "FastAPI");
	assert.equal(index.description, "FastAPI framework, high performance, easy to learn, fast to code");
	assert.equal(index.allLinks.length, 5);
	const titles = index.allLinks.map((l) => l.title);
	assert.deepEqual(titles, ["Tutorial", "Advanced", "Router", "External", "Loose link"]);
	assert.equal(index.allLinks[1]?.description, undefined); // quoted title line, no description
	assert.equal(index.allLinks[0]?.description, "The basics");
});

test("parseLlmsTxt groups links by section; blank lines do not end a section", () => {
	const index = parseLlmsTxt(SAMPLE);
	const sectionTitles = index.sections.map((s) => s.title);
	assert.deepEqual(sectionTitles, ["Learn", "Reference"]);
	assert.equal(index.sections[0]?.links.length, 2);
	assert.equal(index.sections[1]?.links.length, 3); // External + loose link trail Reference
});

test("parseLlmsTxt deduplicates repeated URLs", () => {
	const index = parseLlmsTxt("- [A](a.md)\n- [B](a.md)\n");
	assert.equal(index.allLinks.length, 1);
});

test("resolveLinkUrl resolves relative hrefs and strips fragments", () => {
	assert.equal(resolveLinkUrl("guide/x.md", "https://docs.example.com/base/llms.txt"), "https://docs.example.com/base/guide/x.md");
	assert.equal(resolveLinkUrl("/abs/page.md", "https://docs.example.com/llms.txt"), "https://docs.example.com/abs/page.md");
	assert.equal(resolveLinkUrl("page.md#section", "https://docs.example.com/llms.txt"), "https://docs.example.com/page.md");
	assert.equal(resolveLinkUrl("mailto:a@b.c", "https://docs.example.com/llms.txt"), null);
	assert.equal(resolveLinkUrl("javascript:void(0)", "https://docs.example.com/llms.txt"), null);
	assert.equal(resolveLinkUrl("http://[::1", "https://docs.example.com/llms.txt"), null);
});

test("splitMarkdownSections splits at # and ## outside code fences", () => {
	const md = `preamble line
# One
content one
\`\`\`md
# not a heading
\`\`\`
## Two
content two
# Three
`;
	const sections = splitMarkdownSections(md);
	const titles = sections.map((s) => s.title);
	assert.deepEqual(titles, ["", "One", "Two", "Three"]); // "" = preamble
	assert.deepEqual(
		sections.map((s) => [s.startLine, s.endLine]),
		[
			[1, 1],
			[2, 6],
			[7, 8],
			[9, 10],
		],
	);
});

test("splitMarkdownSections is fence-state aware even with ~~~ fences", () => {
	const md = `# A
~~~
# still code
~~~
# B
text
`;
	const sections = splitMarkdownSections(md);
	assert.deepEqual(
		sections.map((s) => s.title),
		["A", "B"],
	);
	assert.equal(sections[1]?.startLine, 5);
});

test("slugify produces filesystem-safe slugs", () => {
	assert.equal(slugify("Getting Started!"), "getting-started");
	assert.equal(slugify("Àéî öü"), "aei-ou");
	assert.equal(slugify("///"), "section");
	assert.equal(slugify("a".repeat(100)).length, 64);
});
