import { app } from "electron";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { AppSettings } from "../../shared/types";
import {
	listActiveBuiltInExtensionPaths,
	resolveBuiltInExtensionsOverlayDir,
	type BuiltInExtensionPathRoots,
} from "./builtInExtensions";
import { resolveEnabledExtensionPaths } from "./enabledExtensionResolver";
import { readProjectResourceOverrides } from "../projects/projectResourceOverrides";
import { readSettingsObject } from "../resourceWhitelist";

const MAESTRO_FLOW_PACKAGE = "pi-maestro-flow";
const CONFLICTING_BUILT_IN = "pi-deck-todo.ts";

/** Package sources may be strings or filtered package objects in pi settings. */
function packageSource(value: unknown): string | undefined {
	if (typeof value === "string") return value.trim();
	if (value && typeof value === "object" && !Array.isArray(value)) {
		const source = (value as { source?: unknown }).source;
		return typeof source === "string" ? source.trim() : undefined;
	}
	return undefined;
}

/** Exported for focused tests and to keep package-name matching explicit. */
export function isPiMaestroFlowPackageSource(source: string): boolean {
	const normalized = source.trim().toLowerCase().replace(/\\/g, "/");
	const withoutProtocol = normalized.startsWith("npm:") ? normalized.slice(4) : normalized;
	return (
		withoutProtocol === MAESTRO_FLOW_PACKAGE ||
		withoutProtocol.startsWith(`${MAESTRO_FLOW_PACKAGE}@`) ||
		withoutProtocol.endsWith(`/${MAESTRO_FLOW_PACKAGE}`) ||
		withoutProtocol.includes(`/${MAESTRO_FLOW_PACKAGE}@`)
	);
}

function hasConfiguredMaestroFlow(cwd: string, includeProjectResources: boolean): boolean {
	const settingsFiles = [join(homedir(), ".pi", "agent", "settings.json")];
	if (includeProjectResources) settingsFiles.push(join(cwd, ".pi", "settings.json"));
	return settingsFiles.some((settingsFile) => {
		const packages = readSettingsObject(settingsFile).packages;
		return Array.isArray(packages) && packages.some((entry) => {
			const source = packageSource(entry);
			return source !== undefined && isPiMaestroFlowPackageSource(source);
		});
	});
}

function filterConflictingBuiltIns(paths: string[], cwd: string, includeProjectResources: boolean): string[] {
	if (!hasConfiguredMaestroFlow(cwd, includeProjectResources)) return paths;
	return paths.filter((path) => basename(path).toLowerCase() !== CONFLICTING_BUILT_IN);
}

/**
 * 为 PiProcess 构造扩展解析器（内置扩展注入 + 白名单枚举）。
 * 返回值可直接展开为 PiProcess 第 4 参 options 的
 * resolveBuiltInExtensionPaths / resolveEnabledExtensionPaths。
 *
 * 为什么共用：AgentManager（会话运行时 RPC）与 PiModelCapabilityCache（模型能力快照）
 * 必须走同一套「哪些扩展加载」的判定，否则选择器可能展示运行时实际不存在的模型
 * （例如用户已禁用的扩展贡献的模型），用户选完才在会话启动时报错。
 */
export function createPiProcessExtensionResolvers(
	cwd: string,
	settings: AppSettings,
): {
	resolveBuiltInExtensionPaths: (
		processSettings?: Partial<AppSettings>,
		includeProjectResources?: boolean,
	) => string[];
	resolveEnabledExtensionPaths: (
		processSettings?: Partial<AppSettings>,
		cwd?: string,
		includeProjectResources?: boolean,
	) => string[] | null;
} {
	const builtInRoots: BuiltInExtensionPathRoots = {
		appPath: app.getAppPath(),
		resourcesPath: process.resourcesPath,
		isDev: !app.isPackaged,
		// 热更新覆盖层：有热补丁时优先注入它，重启会话即生效（无覆盖层时该字段无影响）
		overlayDir: resolveBuiltInExtensionsOverlayDir(app.getPath("userData")),
	};
	return {
		resolveBuiltInExtensionPaths: (processSettings, includeProjectResources = true) => {
			const disabledForProject = new Set(
				includeProjectResources
					? readProjectResourceOverrides(cwd).disabledGlobalExtensions
					: [],
			);
			const paths = listActiveBuiltInExtensionPaths(
				builtInRoots,
				processSettings?.removedBuiltInExtensions ?? settings.removedBuiltInExtensions ?? [],
			).filter((path) => !disabledForProject.has(basename(path)));
			return filterConflictingBuiltIns(paths, cwd, includeProjectResources);
		},
		resolveEnabledExtensionPaths: (processSettings, _processCwd, includeProjectResources = true) => {
			const paths = resolveEnabledExtensionPaths({
				cwd,
				includeProjectResources,
				disabled:
					processSettings?.disabledExtensions ?? settings.disabledExtensions ?? [],
				removedBuiltInExtensions:
					processSettings?.removedBuiltInExtensions ??
					settings.removedBuiltInExtensions ??
					[],
				builtInRoots,
			});
			return paths === null
				? null
				: filterConflictingBuiltIns(paths, cwd, includeProjectResources);
		},
	};
}
