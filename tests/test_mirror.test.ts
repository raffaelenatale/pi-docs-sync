import assert from "node:assert/strict";
import { test } from "node:test";
import { compileFilters, dedupeLocalPath, globToRegExp, isDue, mirrorRootFor, passesFilters, planPageSync, urlToLocalPath } from "../extensions/docs-sync/mirror.ts";
import type { PageRecord } from "../extensions/docs-sync/types.ts";

test("urlToLocalPath maps URLs to structured host/paths", () => {
	assert.equal(urlToLocalPath("https://docs.example.com/guide/advanced/foo.md"), "docs.example.com/guide/advanced/foo.md");
	assert.equal(urlToLocalPath("https://docs.example.com/"), "docs.example.com/index.md");
	assert.equal(urlToLocalPath("https://docs.example.com"), "docs.example.com/index.md");
	assert.equal(urlToLocalPath("https://docs.example.com/tutorial/"), "docs.example.com/tutorial/index.md");
	assert.equal(urlToLocalPath("https://docs.example.com/page"), "docs.example.com/page.md");
	assert.equal(urlToLocalPath("https://docs.example.com/page.html"), "docs.example.com/page.md");
	assert.equal(urlToLocalPath("https://docs.example.com/older/page.htm"), "docs.example.com/older/page.md");
	assert.equal(urlToLocalPath("https://docs.example.com/api?v=2#sec"), "docs.example.com/api.md");
});

test("urlToLocalPath decodes percent-encoding into readable folders", () => {
	assert.equal(urlToLocalPath("https://docs.example.com/guide%20book/intro.md"), "docs.example.com/guide-book/intro.md");
	assert.equal(urlToLocalPath("https://docs.example.com/%C3%A0-propos.md"), "docs.example.com/a-propos.md");
});

test("urlToLocalPath refuses traversal and unsafe schemes", () => {
	// Literal (and %2e-encoded) dot segments are normalized away by the WHATWG
	// parser, mirroring what the server actually serves; the result stays in-tree.
	assert.equal(urlToLocalPath("https://docs.example.com/../../etc/passwd.md"), "docs.example.com/etc/passwd.md");
	// Encoded-slash traversal decodes into a `..` segment after the parser, and is refused.
	assert.equal(urlToLocalPath("https://docs.example.com/%2e%2e%2f%2e%2e%2fetc/passwd.md"), null);
	assert.equal(urlToLocalPath("file:///etc/passwd"), null);
	assert.equal(urlToLocalPath("not a url"), null);
});

test("urlToLocalPath sanitizes hostile segment characters", () => {
	assert.equal(urlToLocalPath("https://docs.example.com/a b/c<>d.md"), "docs.example.com/a-b/c--d.md");
	const mapped = urlToLocalPath("https://docs.example.com/" + "x".repeat(200) + ".md");
	assert.ok(mapped && mapped.length < 200);
});

test("urlToLocalPath keeps non-default ports distinct", () => {
	assert.equal(urlToLocalPath("http://localhost:3000/docs/x.md"), "localhost-3000/docs/x.md");
});

test("globToRegExp: * stays in-segment, ** crosses segments", () => {
	const star = globToRegExp("/api/*.md");
	assert.ok(star.test("/api/client.md"));
	assert.ok(!star.test("/api/v2/client.md"));
	const globstar = globToRegExp("/api/**/*.md");
	assert.ok(globstar.test("/api/v2/deep/client.md"));
	const literal = globToRegExp("/guide/advanced.md");
	assert.ok(literal.test("/guide/advanced.md"));
	assert.ok(!literal.test("/guide/advancedXmd"));
});

test("compileFilters + passesFilters: include wins, exclude final", () => {
	const filters = compileFilters({ url: "https://x.example.com", include: ["/docs/**"], exclude: ["**/internal/**"] });
	assert.ok(passesFilters("/docs/guide.md", filters));
	assert.ok(!passesFilters("/blog/post.md", filters));
	assert.ok(!passesFilters("/docs/internal/secret.md", filters));
	const empty = compileFilters({ url: "https://x.example.com" });
	assert.ok(passesFilters("/anything/at/all.md", empty));
});

test("planPageSync: missing/validator-less URLs need fetch, stale ones are deleted", () => {
	const pages: Record<string, PageRecord> = {
		"https://a/1.md": { requestedUrl: "https://a/1.md", finalUrl: "https://a/1.md", path: "a/1.md", sha256: "x", bytes: 1, etag: '"e1"', fetchedAt: 1, checkedAt: 1 },
		"https://a/2.md": { requestedUrl: "https://a/2.md", finalUrl: "https://a/2.md", path: "a/2.md", sha256: "x", bytes: 1, fetchedAt: 1, checkedAt: 1 },
		"https://a/gone.md": { requestedUrl: "https://a/gone.md", finalUrl: "https://a/gone.md", path: "a/gone.md", sha256: "x", bytes: 1, etag: '"e"', fetchedAt: 1, checkedAt: 1 },
	};
	const plan = planPageSync(pages, ["https://a/1.md", "https://a/2.md", "https://a/new.md"]);
	assert.deepEqual(plan.toCheck, ["https://a/2.md", "https://a/new.md"]);
	assert.deepEqual(plan.toRevalidate, ["https://a/1.md"]);
	assert.deepEqual(plan.toDelete, ["https://a/gone.md"]);
});

test("dedupeLocalPath appends -2, -3 only on collisions", () => {
	const used = new Set(["a/page.md"]);
	assert.equal(dedupeLocalPath("a/other.md", used), "a/other.md");
	assert.equal(dedupeLocalPath("a/page.md", used), "a/page-2.md");
	used.add("a/page-2.md");
	assert.equal(dedupeLocalPath("a/page.md", used), "a/page-3.md");
});

test("isDue: no manifest is due; fresh manifest is not; expired is", () => {
	const day = 3_600_000 * 24;
	assert.equal(isDue(null, 24), true);
	const fresh = { version: 1 as const, name: "x", mode: "tree" as const, config: { url: "https://a" }, pages: {}, skipped: {}, lastCheckedAt: Date.now() - day };
	assert.equal(isDue(fresh, 24 * 7), false);
	assert.equal(isDue(fresh, 12), true);
});

test("mirrorRootFor honors storage mode", () => {
	const config = { version: 1 as const, storage: "workspace" as const, sources: {} };
	assert.equal(mirrorRootFor(config, "/work/proj", "/agent/dir"), "/work/proj/.pi/docs-mirror");
	const global = { version: 1 as const, storage: "global" as const, sources: {} };
	assert.equal(mirrorRootFor(global, "/work/proj", "/agent/dir"), "/agent/dir/docs-mirror");
	assert.equal(mirrorRootFor({ version: 1 as const, sources: {} }, "/work/proj", "/agent/dir"), "/agent/dir/docs-mirror");
});
