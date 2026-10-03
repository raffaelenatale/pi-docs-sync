import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, test } from "node:test";
import { parseConfig } from "../extensions/docs-sync/config.ts";
import { readManifest, syncSource } from "../extensions/docs-sync/mirror.ts";
import type { DocsConfig } from "../extensions/docs-sync/types.ts";

interface Route {
	body?: string;
	etag?: string;
	status?: number;
	location?: string;
	/** Received If-None-Match values, in request order. */
	seenIfNoneMatch?: string[];
}

interface TestServer {
	server: http.Server;
	base: string;
	routes: Record<string, Route>;
}

function createServer(routes: Record<string, Route>): Promise<TestServer> {
	return new Promise((resolve) => {
		const server = http.createServer((request, response) => {
			const route = routes[request.url ?? ""];
			if (!route) {
				response.writeHead(404, { "content-type": "text/plain" });
				response.end("not found");
				return;
			}
			route.seenIfNoneMatch = route.seenIfNoneMatch ?? [];
			route.seenIfNoneMatch.push(request.headers["if-none-match"] ?? "");
			if (route.location) {
				response.writeHead(route.status ?? 301, { location: route.location });
				response.end();
				return;
			}
			if (route.etag && request.headers["if-none-match"] === route.etag) {
				response.writeHead(304, { etag: route.etag });
				response.end();
				return;
			}
			response.writeHead(route.status ?? 200, { "content-type": "text/markdown", etag: route.etag ?? `"${Math.random()}"` });
			response.end(route.body ?? "");
		});
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			const port = typeof address === "object" && address ? address.port : 0;
			resolve({ server, base: `http://127.0.0.1:${port}`, routes });
		});
	});
}

function makeRoot(): { root: string; cleanup: () => void } {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "docs-sync-mirror-"));
	return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function configFor(url: string): DocsConfig {
	return parseConfig({ version: 1, storage: "workspace", sources: { demo: { url } } }) as DocsConfig;
}

function hostPrefix(base: string, rest: string): string {
	const url = new URL(base);
	const host = url.hostname + (url.port ? `-${url.port}` : "");
	return `${host}/${rest}`;
}

let full: TestServer;
let tree: TestServer;
let tmp: { root: string; cleanup: () => void };

before(async () => {
	full = await createServer({
		"/llms-full.txt": {
			body: "# Demo Docs\n\n> demo\n\n# Intro\nintro body\n\n## Setup\nsetup steps\n\n```md\n# not a heading\n```\n\n# Api\napi body\n",
			etag: '"full-v1"',
		},
	});
	tree = await createServer({
		"/llms.txt": {
			body: "# Demo\n\n- [Old](old/page.md)\n- [Keep](keep.md)\n",
			etag: '"index-v1"',
		},
		"/old/page.md": { location: "/new/page.md" },
		"/new/page.md": { body: "# Redirected page\ncontent v1\n", etag: '"page-v1"' },
		"/keep.md": { body: "# Keep\nkeep v1\n", etag: '"keep-v1"' },
	});
	tmp = makeRoot();
});

after(() => {
	full.server.close();
	tree.server.close();
	tmp.cleanup();
});

test("full mode: downloads llms-full.txt, shards sections, records validators", async () => {
	const config = configFor(`${full.base}/llms-full.txt`);
	const sourceRoot = path.join(tmp.root, "demo-full");
	const result = await syncSource("demo-full", config.sources.demo!, config, sourceRoot, { force: true });

	assert.equal(result.mode, "full");
	assert.equal(result.fetched, 1);
	const manifest = readManifest(sourceRoot);
	assert.equal(manifest?.mode, "full");
	assert.equal(manifest?.etag, '"full-v1"');
	assert.ok(fs.readFileSync(path.join(sourceRoot, "full.md"), "utf8").startsWith("# Demo Docs"));
	const sectionsDir = path.join(sourceRoot, "sections");
	const sectionFiles = fs.readdirSync(sectionsDir).filter((f) => f.endsWith(".md"));
	assert.equal(sectionFiles.length, 4); // Demo Docs, Intro, Setup, Api (fenced heading ignored)
	assert.ok(fs.existsSync(path.join(sectionsDir, "index.json")));
	const setup = sectionFiles.find((f) => f.includes("setup"));
	assert.ok(setup && fs.readFileSync(path.join(sectionsDir, setup), "utf8").includes("setup steps"));
});

test("full mode: second sync is a 304 no-op via If-None-Match", async () => {
	const config = configFor(`${full.base}/llms-full.txt`);
	const sourceRoot = path.join(tmp.root, "demo-full");
	const result = await syncSource("demo-full", config.sources.demo!, config, sourceRoot, { force: true });

	assert.equal(result.unchanged, 1);
	assert.equal(result.fetched, 0);
	assert.ok(full.routes["/llms-full.txt"]?.seenIfNoneMatch?.includes('"full-v1"'));
});

test("tree mode: first sync follows redirects into the structured tree", async () => {
	const config = configFor(`${tree.base}/llms.txt`);
	const sourceRoot = path.join(tmp.root, "demo-tree");
	const result = await syncSource("demo-tree", config.sources.demo!, config, sourceRoot, { force: true });

	assert.equal(result.mode, "tree");
	assert.equal(result.fetched, 2);
	const manifest = readManifest(sourceRoot);
	assert.equal(manifest?.mode, "tree");
	assert.equal(Object.keys(manifest?.pages ?? {}).length, 2);

	const redirected = manifest?.pages[`${tree.base}/old/page.md`];
	assert.ok(redirected);
	assert.equal(redirected?.finalUrl, `${tree.base}/new/page.md`);
	assert.equal(redirected?.path, hostPrefix(tree.base, "new/page.md"));
	assert.equal(redirected?.redirectedExternal, undefined);
	assert.ok(fs.readFileSync(path.join(sourceRoot, redirected!.path), "utf8").includes("content v1"));
	assert.ok(fs.existsSync(path.join(sourceRoot, hostPrefix(tree.base, "keep.md"))));
});

test("tree mode: differential sync fetches only changes and prunes removed pages", async () => {
	const config = configFor(`${tree.base}/llms.txt`);
	const sourceRoot = path.join(tmp.root, "demo-tree");

	tree.routes["/llms.txt"] = { body: "# Demo\n\n- [Keep](keep.md)\n- [Added](added.md)\n", etag: '"index-v2"', seenIfNoneMatch: [] };
	tree.routes["/keep.md"] = { body: "# Keep\nkeep v2\n", etag: '"keep-v2"', seenIfNoneMatch: [] };
	tree.routes["/added.md"] = { body: "# Added\nadded v1\n", etag: '"added-v1"', seenIfNoneMatch: [] };
	delete tree.routes["/old/page.md"]; // gone from the index and from the server

	const result = await syncSource("demo-tree", config.sources.demo!, config, sourceRoot, { force: true });

	assert.equal(result.fetched, 2); // keep.md changed + added.md new
	assert.equal(result.removed, 1); // old/page.md pruned
	const manifest = readManifest(sourceRoot);
	assert.equal(manifest?.pages[`${tree.base}/old/page.md`], undefined);
	assert.ok(!fs.existsSync(path.join(sourceRoot, hostPrefix(tree.base, "new/page.md"))));
	assert.equal(manifest?.etag, '"index-v2"');
	assert.ok(fs.readFileSync(path.join(sourceRoot, hostPrefix(tree.base, "keep.md")), "utf8").includes("keep v2"));
	assert.ok(fs.existsSync(path.join(sourceRoot, hostPrefix(tree.base, "added.md"))));
});

test("tree mode: TTL not expired -> skippedSync without network", async () => {
	const config = configFor(`${tree.base}/llms.txt`);
	const sourceRoot = path.join(tmp.root, "demo-tree");
	const beforeCalls = tree.routes["/llms.txt"]?.seenIfNoneMatch?.length ?? 0;
	const result = await syncSource("demo-tree", config.sources.demo!, config, sourceRoot, {});
	assert.equal(result.skippedSync, true);
	assert.equal(tree.routes["/llms.txt"]?.seenIfNoneMatch?.length, beforeCalls);
});

test("discovery failure: no llms.txt produces a reported error", async () => {
	const server = await createServer({ "/": { body: "# nothing\n" } });
	try {
		const config = configFor(`${server.base}/`);
		const sourceRoot = path.join(tmp.root, "demo-missing");
		const result = await syncSource("demo-missing", config.sources.demo!, config, sourceRoot, { force: true });
		assert.match(result.error ?? "", /no llms\.txt/);
		const manifest = readManifest(sourceRoot);
		assert.match(manifest?.lastError ?? "", /no llms\.txt/);
	} finally {
		server.server.close();
	}
});

test("mapLimit preserves order under concurrency", async () => {
	const { mapLimit } = await import("../extensions/docs-sync/net.ts");
	const input = [1, 2, 3, 4, 5, 6, 7];
	const out = await mapLimit(input, 3, async (n) => n * 10);
	assert.deepEqual(out, [10, 20, 30, 40, 50, 60, 70]);
});
