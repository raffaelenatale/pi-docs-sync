/** Loading, saving and merging of `.pi/docs.json` (workspace) and global config. */

import * as fs from "node:fs";
import * as path from "node:path";
import type { DocsConfig, DocsSourceConfig } from "./types.ts";

export const WORKSPACE_CONFIG_REL = path.join(".pi", "docs.json");
export const DEFAULT_TTL_HOURS = 24 * 7;

/** Pure merge: workspace entries win over global entries with the same name. */
export function mergeConfigs(global: DocsConfig | null, workspace: DocsConfig | null): DocsConfig {
	const sources: Record<string, DocsSourceConfig> = {};
	if (global) for (const [name, cfg] of Object.entries(global.sources ?? {})) sources[name] = cfg;
	if (workspace) for (const [name, cfg] of Object.entries(workspace.sources ?? {})) sources[name] = cfg;
	return {
		version: 1,
		storage: workspace?.storage ?? global?.storage ?? "global",
		defaultTtlHours: workspace?.defaultTtlHours ?? global?.defaultTtlHours,
		sources,
	};
}

/** Parse + validate unknown JSON into a DocsConfig; returns null when absent/invalid. */
export function parseConfig(raw: unknown): DocsConfig | null {
	if (raw === null || typeof raw !== "object") return null;
	const obj = raw as Record<string, unknown>;
	const sourcesRaw = obj.sources;
	if (sourcesRaw !== undefined && (sourcesRaw === null || typeof sourcesRaw !== "object")) return null;
	const sources: Record<string, DocsSourceConfig> = {};
	for (const [name, value] of Object.entries((sourcesRaw ?? {}) as Record<string, unknown>)) {
		if (!isValidSourceName(name) || value === null || typeof value !== "object") continue;
		const s = value as Record<string, unknown>;
		if (typeof s.url !== "string" || !/^https?:\/\//i.test(s.url)) continue;
		const cfg: DocsSourceConfig = { url: s.url };
		if (typeof s.ttlHours === "number" && s.ttlHours > 0) cfg.ttlHours = s.ttlHours;
		if (Array.isArray(s.include)) cfg.include = s.include.filter((p): p is string => typeof p === "string");
		if (Array.isArray(s.exclude)) cfg.exclude = s.exclude.filter((p): p is string => typeof p === "string");
		if (typeof s.allowExternal === "boolean") cfg.allowExternal = s.allowExternal;
		sources[name] = cfg;
	}
	const storage = obj.storage === "workspace" ? "workspace" : obj.storage === "global" ? "global" : undefined;
	const defaultTtlHours = typeof obj.defaultTtlHours === "number" && obj.defaultTtlHours > 0 ? obj.defaultTtlHours : undefined;
	return { version: 1, storage, defaultTtlHours, sources };
}

export function readConfigFile(filePath: string): DocsConfig | null {
	let text: string;
	try {
		text = fs.readFileSync(filePath, "utf8");
	} catch {
		return null;
	}
	try {
		return parseConfig(JSON.parse(text));
	} catch {
		return null;
	}
}

export function writeConfigFile(filePath: string, config: DocsConfig): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	const clean: DocsConfig = { version: 1, storage: config.storage, sources: config.sources };
	if (config.defaultTtlHours !== undefined) clean.defaultTtlHours = config.defaultTtlHours;
	const tmp = `${filePath}.tmp-${process.pid}`;
	fs.writeFileSync(tmp, JSON.stringify(clean, null, "\t") + "\n", "utf8");
	fs.renameSync(tmp, filePath);
}

/** Source names are folder names: keep them filesystem-safe. */
export function isValidSourceName(name: string): boolean {
	return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name);
}

export function effectiveTtlHours(config: DocsConfig, source: DocsSourceConfig): number {
	return source.ttlHours ?? config.defaultTtlHours ?? DEFAULT_TTL_HOURS;
}
