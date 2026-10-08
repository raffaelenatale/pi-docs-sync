import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	AGENTS_BEGIN,
	AGENTS_BLOCK,
	MIRROR_IGNORE_ENTRY,
	PACKAGE_SOURCE,
	addGitignoreEntry,
	addPackageDeclaration,
	setupWorkspace,
	upsertAgentsBlock,
} from "../extensions/docs-sync/workspace-setup.ts";

test("addGitignoreEntry appends once and respects existing coverage", () => {
	const next = addGitignoreEntry("node_modules/");
	assert.ok(next?.startsWith("node_modules/\n"));
	assert.ok(next?.includes(MIRROR_IGNORE_ENTRY));
	assert.equal(addGitignoreEntry(next!), null);
	assert.equal(addGitignoreEntry(".pi/\n"), null);
	assert.ok(addGitignoreEntry("")?.includes(MIRROR_IGNORE_ENTRY));
});

test("addPackageDeclaration keeps other keys and is idempotent", () => {
	const next = addPackageDeclaration({ skills: [], packages: ["npm:other"] });
	assert.deepEqual(next, { skills: [], packages: ["npm:other", PACKAGE_SOURCE] });
	assert.equal(addPackageDeclaration(next!), null);
	assert.equal(addPackageDeclaration({ packages: [{ source: "../pi-docs-sync" }] }), null);
	assert.deepEqual(addPackageDeclaration({}), { packages: [PACKAGE_SOURCE] });
});

test("upsertAgentsBlock appends, replaces stale block, and is idempotent", () => {
	const appended = upsertAgentsBlock("# Project\n");
	assert.equal(appended, `# Project\n\n${AGENTS_BLOCK}\n`);
	assert.equal(upsertAgentsBlock(appended!), null);
	const stale = `# P\n${AGENTS_BEGIN}\nold\n<!-- END pi-docs-sync -->\ntail\n`;
	assert.equal(upsertAgentsBlock(stale), `# P\n${AGENTS_BLOCK}\ntail\n`);
	assert.equal(upsertAgentsBlock(""), `${AGENTS_BLOCK}\n`);
});

test("setupWorkspace applies all steps in a git root and is idempotent", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "docs-setup-"));
	fs.mkdirSync(path.join(dir, ".git"));
	fs.mkdirSync(path.join(dir, ".pi"));
	fs.writeFileSync(path.join(dir, ".pi", "settings.json"), JSON.stringify({ skills: [] }));
	fs.writeFileSync(path.join(dir, "AGENTS.md"), "# Repo\n");

	const first = setupWorkspace(dir);
	assert.deepEqual(first.changed.sort(), ["agents", "gitignore", "settings"]);
	assert.ok(fs.readFileSync(path.join(dir, ".gitignore"), "utf8").includes(MIRROR_IGNORE_ENTRY));
	assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, ".pi", "settings.json"), "utf8")), { skills: [], packages: [PACKAGE_SOURCE] });
	assert.ok(fs.readFileSync(path.join(dir, "AGENTS.md"), "utf8").startsWith("# Repo\n"));

	const second = setupWorkspace(dir);
	assert.deepEqual(second.changed, []);
	fs.rmSync(dir, { recursive: true, force: true });
});

test("setupWorkspace: no git -> skips gitignore; CLAUDE.md fallback; invalid settings left untouched", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "docs-setup-"));
	fs.mkdirSync(path.join(dir, ".pi"));
	fs.writeFileSync(path.join(dir, ".pi", "settings.json"), "{ not json");
	fs.writeFileSync(path.join(dir, "CLAUDE.md"), "# Claude\n");

	const result = setupWorkspace(dir);
	assert.deepEqual(result.changed, ["agents"]);
	assert.deepEqual(result.skipped.map((s) => s.step).sort(), ["gitignore", "settings"]);
	assert.equal(fs.existsSync(path.join(dir, "AGENTS.md")), false);
	assert.ok(fs.readFileSync(path.join(dir, "CLAUDE.md"), "utf8").includes(AGENTS_BEGIN));
	assert.equal(fs.readFileSync(path.join(dir, ".pi", "settings.json"), "utf8"), "{ not json");
	fs.rmSync(dir, { recursive: true, force: true });
});
