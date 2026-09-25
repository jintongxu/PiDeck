import { existsSync, lstatSync, realpathSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
	resolveConfiguredPackageRoots,
	type ConfiguredPackageRootsOptions,
} from "../packageResourceResolver";

const MAESTRO_PACKAGE_NAME = "pi-maestro-flow";
const MAESTRO_CLI_PACKAGE_NAME = "maestro-flow";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJson(path: string): Record<string, unknown> | null {
	try {
		const value: unknown = JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
		return isRecord(value) ? value : null;
	} catch {
		return null;
	}
}

function canonical(path: string): string | null {
	try {
		return realpathSync(path);
	} catch {
		return null;
	}
}

function isPathInside(root: string, candidate: string): boolean {
	const child = relative(root, candidate);
	return child !== "" && !child.startsWith("..") && !isAbsolute(child);
}

function hasUnsafePathCharacters(value: string, delimiter: string): boolean {
	return value.includes(delimiter) || /[\u0000-\u001f\u007f]/.test(value);
}

/**
 * Finds the validated host-side `.bin` directory containing the transitive Maestro CLI.
 * Package metadata is treated as untrusted input: only an actual maestro-flow dependency,
 * an in-package `bin.maestro` target, and its matching npm shim are accepted.
 */
export function resolveMaestroCliBinDir(
	packageRoot: string,
	options: { wsl?: boolean } = {},
): string | undefined {
	try {
		const realPackageRoot = canonical(packageRoot);
		if (!realPackageRoot) return undefined;
		const packageJson = readJson(join(realPackageRoot, "package.json"));
		if (packageJson?.name !== MAESTRO_PACKAGE_NAME) return undefined;

		const lexicalDependencyRoot = resolve(realPackageRoot, "node_modules", MAESTRO_CLI_PACKAGE_NAME);
		if (!isPathInside(realPackageRoot, lexicalDependencyRoot)) return undefined;
		const dependencyRoot = canonical(lexicalDependencyRoot);
		if (!dependencyRoot) return undefined;
		const dependencyJson = readJson(join(dependencyRoot, "package.json"));
		if (dependencyJson?.name !== MAESTRO_CLI_PACKAGE_NAME) return undefined;
		const dependencies = packageJson.dependencies;
		if (!isRecord(dependencies) || typeof dependencies[MAESTRO_CLI_PACKAGE_NAME] !== "string") return undefined;

		const bin = dependencyJson.bin;
		const entry = typeof bin === "string"
			? bin
			: isRecord(bin) && typeof bin.maestro === "string"
				? bin.maestro
				: "";
		const delimiter = process.platform === "win32" ? ";" : ":";
		if (!entry.trim() || hasUnsafePathCharacters(entry, delimiter)) return undefined;
		const cliEntry = canonical(resolve(dependencyRoot, entry));
		if (!cliEntry || !isPathInside(dependencyRoot, cliEntry) || !statSync(cliEntry).isFile()) return undefined;

		const lexicalBinDir = resolve(realPackageRoot, "node_modules", ".bin");
		if (!isPathInside(realPackageRoot, lexicalBinDir)) return undefined;
		const binDir = canonical(lexicalBinDir);
		if (!binDir || !statSync(binDir).isDirectory()) return undefined;
		const shimName = options.wsl || process.platform !== "win32" ? "maestro" : "maestro.cmd";
		const shim = join(binDir, shimName);
		if (!existsSync(shim) || !statSync(shim).isFile()) return undefined;
		const lexicalCliEntry = resolve(lexicalDependencyRoot, entry);
		if (!isExpectedCliShim(shim, binDir, cliEntry, lexicalCliEntry)) return undefined;
		return binDir;
	} catch {
		return undefined;
	}
}

function isExpectedCliShim(
	shimPath: string,
	binDir: string,
	cliEntry: string,
	lexicalCliEntry: string,
): boolean {
	try {
		const shimStat = lstatSync(shimPath);
		if (shimStat.isSymbolicLink()) {
			return canonical(shimPath) === cliEntry;
		}
		if (!shimStat.isFile()) return false;
		const relativeEntry = relative(binDir, lexicalCliEntry).replace(/\\/g, "/").toLowerCase();
		const lines = readFileSync(shimPath, "utf8")
			.replace(/^\uFEFF/, "")
			.replace(/\\/g, "/")
			.toLowerCase()
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter((line) => line && !line.startsWith("#") && !line.startsWith("rem "));
		const escapedEntry = relativeEntry.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		// npm POSIX shims execute the target through node; Windows cmd shims use
		// the generated `%_prog%` + `%dp0%` form. A comment/echo or an arbitrary
		// executable containing the expected path must not grant PATH access.
		const posixExec = new RegExp(`^exec\\s+(?:node|node\\.exe)\\s+[^\\n]*${escapedEntry}`);
		const windowsExec = new RegExp(`^endlocal\\s*&.*"%_prog%"\\s+"%dp0%/${escapedEntry}"`);
		return lines.some((line) => posixExec.test(line) || windowsExec.test(line));
	} catch {
		return false;
	}
}

/** Resolve all configured pi-maestro-flow CLI bin directories in Pi's package precedence order. */
export function resolveConfiguredMaestroCliBinDirs(
	options: ConfiguredPackageRootsOptions & { wsl?: boolean },
): string[] {
	const result: string[] = [];
	const seen = new Set<string>();
	for (const packageRoot of resolveConfiguredPackageRoots(options)) {
		const binDir = resolveMaestroCliBinDir(packageRoot.path, options);
		if (!binDir) continue;
		const key = process.platform === "win32" ? binDir.toLowerCase() : binDir;
		if (seen.has(key)) continue;
		seen.add(key);
		result.push(binDir);
	}
	return result;
}
