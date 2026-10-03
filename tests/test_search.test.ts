import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { pickSnippets, scoreFile, searchMirror, searchSource, tokenize } from "../extensions/docs-sync/search.ts";

function makeSource(files: Record<string, string>): { root: string; cleanup: () => void } {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "docs-sync-search-"));
	for (const [rel, content] of Object.entries(files)) {
		const absolute = path.join(root, rel);
		fs.mkdirSync(path.dirname(absolute), { recursive: true });
		fs.writeFileSync(absolute, content, "utf8");
	}
	return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test("tokenize lowercases and keeps alphanumeric runs", () => {
	assert.deepEqual(tokenize("BaseModel field_validation!"), ["basemodel", "field_validation"]);
	assert.deepEqual(tokenize("a I"), []);
});

test("scoreFile requires every term (AND) and rewards frequency", () => {
	const lines = ["pydantic BaseModel basics", "BaseModel validators explained", "unrelated topic", "BaseModel again with BaseModel"];
	const single = scoreFile(["basemodel"], lines);
	assert.ok(single.score > 0);
	assert.equal(single.matchedLines.size, 3);
	const multi = scoreFile(["basemodel", "validators"], lines);
	assert.ok(multi.score > 0);
	assert.ok(multi.matchedLines.has(1));
	const none = scoreFile(["basemodel", "missingterm"], lines);
	assert.equal(none.score, 0);
});

test("searchSource ranks and returns line-snippets; skips full.md", () => {
	const { root, cleanup } = makeSource({
		"docs.example.com/guide/lifespan.md": "# Lifespan\n\nUse lifespan for background tasks on startup and shutdown.\nLifespan replaces on_event.\n",
		"docs.example.com/tasks.md": "# Background Tasks\n\nBackground tasks run after responses; for startup work see lifespan.\n",
		"docs.example.com/full.md": "# Lifespan\nlifespan duplicated content\n",
	});
	try {
		const hits = searchSource(root, "fastapi", "lifespan background", { limit: 5 });
		assert.ok(hits.length >= 1);
		assert.ok(!hits.some((hit) => hit.path === "full.md"));
		const top = hits[0];
		assert.equal(top?.source, "fastapi");
		assert.ok(top && (top.path === "docs.example.com/guide/lifespan.md" || top.path === "docs.example.com/tasks.md"));
		assert.ok(top && top.snippets.length > 0);
		assert.ok(top && top.snippets.every((snippet) => snippet.line >= 1));
		assert.equal(searchSource(root, "fastapi", "zzz-not-present", { limit: 5 }).length, 0);
	} finally {
		cleanup();
	}
});

test("searchMirror merges sources by score", () => {
	const a = makeSource({ "a.example.com/x.md": "# X\nalpha alpha alpha\n" });
	const b = makeSource({ "b.example.com/y.md": "# Y\nalpha\n" });
	try {
		const hits = searchMirror(
			[
				{ name: "a", root: a.root },
				{ name: "b", root: b.root },
			],
			"alpha",
			{ limit: 10 },
		);
		assert.equal(hits.length, 2);
		assert.equal(hits[0]?.source, "a");
	} finally {
		a.cleanup();
		b.cleanup();
	}
});

test("pickSnippets orders by line after relevance cut", () => {
	const lines = ["noise", "hit ten", "hit nine", "noise", "hit many many"];
	const matched = new Map<number, number>([
		[4, 2],
		[1, 1],
		[2, 1],
	]);
	const snippets = pickSnippets(matched, lines, 3);
	// matched indexes are 0-based; reported line numbers are 1-based
	assert.deepEqual(
		snippets.map((snippet) => snippet.line),
		[2, 3, 5],
	);
});

test("searchSource ignores oversized files", () => {
	const { root, cleanup } = makeSource({ "big.example.com/huge.md": `# Huge\n${"alpha ".repeat(200_000)}\n` });
	try {
		assert.equal(searchSource(root, "big", "alpha").length, 0);
	} finally {
		cleanup();
	}
});
