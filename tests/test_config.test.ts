import assert from "node:assert/strict";
import { test } from "node:test";
import { mergeConfigs, parseConfig, writeConfigFile, readConfigFile, isValidSourceName, effectiveTtlHours, DEFAULT_TTL_HOURS } from "../extensions/docs-sync/config.ts";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

test("parseConfig accepts valid config and rejects malformed entries", () => {
	const config = parseConfig({
		version: 1,
		storage: "workspace",
		defaultTtlHours: 24,
		sources: {
			fastapi: { url: "https://fastapi.tiangolo.com/", ttlHours: 12, exclude: ["/blog/**"] },
			bad: { url: "ftp://nope" },
			worse: "string",
		},
	});
	assert.ok(config);
	assert.deepEqual(Object.keys(config.sources), ["fastapi"]);
	assert.equal(config.sources.fastapi?.ttlHours, 12);
	assert.equal(config.storage, "workspace");
	assert.equal(parseConfig("nope"), null);
	assert.equal(parseConfig({ sources: "nope" }), null);
});

test("mergeConfigs: workspace overrides global by name", () => {
	const globalConfig = parseConfig({ sources: { a: { url: "https://a" }, b: { url: "https://b" } } });
	const workspaceConfig = parseConfig({ sources: { b: { url: "https://b-v2" } } });
	const merged = mergeConfigs(globalConfig, workspaceConfig);
	assert.equal(merged.sources.a?.url, "https://a");
	assert.equal(merged.sources.b?.url, "https://b-v2");
	assert.equal(merged.storage, "global");
});

test("writeConfigFile/readConfigFile roundtrip", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "docs-sync-test-"));
	try {
		const filePath = path.join(dir, "nested", "docs.json");
		const config = parseConfig({ version: 1, sources: { pydantic: { url: "https://docs.pydantic.dev/latest/" } } });
		writeConfigFile(filePath, config!);
		const read = readConfigFile(filePath);
		assert.equal(read?.sources.pydantic?.url, "https://docs.pydantic.dev/latest/");
		assert.equal(readConfigFile(path.join(dir, "missing.json")), null);
		fs.writeFileSync(filePath, "{ broken");
		assert.equal(readConfigFile(filePath), null);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("isValidSourceName blocks path separators and hostile names", () => {
	assert.ok(isValidSourceName("fastapi"));
	assert.ok(isValidSourceName("react-19"));
	assert.ok(isValidSourceName("site.com_docs"));
	assert.ok(!isValidSourceName("../etc"));
	assert.ok(!isValidSourceName("a/b"));
	assert.ok(!isValidSourceName(""));
	assert.ok(!isValidSourceName("-lead"));
	assert.ok(!isValidSourceName("x".repeat(65)));
});

test("effectiveTtlHours falls back through source, config, default", () => {
	const base = { version: 1 as const, sources: {} };
	assert.equal(effectiveTtlHours(base, { url: "https://a", ttlHours: 3 }), 3);
	assert.equal(effectiveTtlHours({ ...base, defaultTtlHours: 9 }, { url: "https://a" }), 9);
	assert.equal(effectiveTtlHours(base, { url: "https://a" }), DEFAULT_TTL_HOURS);
});
