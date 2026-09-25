import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

function put(path, content) {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, content, "utf8");
}

function createMaestroPackage(root, { name = "pi-maestro-flow", validShim = true } = {}) {
	const packageRoot = join(root, "pi-maestro-flow");
	const dependencyRoot = join(packageRoot, "node_modules", "maestro-flow");
	const binDir = join(packageRoot, "node_modules", ".bin");
	put(join(packageRoot, "package.json"), JSON.stringify({
		name,
		dependencies: { "maestro-flow": "0.5.88" },
	}));
	put(join(dependencyRoot, "package.json"), JSON.stringify({
		name: "maestro-flow",
		bin: { maestro: "bin/maestro.js" },
	}));
	put(join(dependencyRoot, "bin", "maestro.js"), "#!/usr/bin/env node\n");
	put(join(binDir, "maestro"), validShim
		? "#!/bin/sh\nexec node \"$basedir/../maestro-flow/bin/maestro.js\" \"$@\"\n"
		: "#!/bin/sh\n# ../maestro-flow/bin/maestro.js\nexec node /tmp/not-maestro.js\n");
	return { packageRoot, binDir };
}

test("resolveMaestroCliBinDir accepts the configured pi-maestro-flow CLI shim", () => {
	const root = mkdtempSync(join(tmpdir(), "pideck-maestro-cli-"));
	try {
		const { resolveMaestroCliBinDir } = loadTsCommonJs("src/main/pi/maestroCliPath.ts");
		const fixture = createMaestroPackage(root);
		assert.equal(resolveMaestroCliBinDir(fixture.packageRoot, { wsl: true }), fixture.binDir);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("resolveMaestroCliBinDir accepts the POSIX npm symlink shim", (t) => {
	const root = mkdtempSync(join(tmpdir(), "pideck-maestro-cli-symlink-"));
	try {
		const { resolveMaestroCliBinDir } = loadTsCommonJs("src/main/pi/maestroCliPath.ts");
		const fixture = createMaestroPackage(root);
		try {
			rmSync(join(fixture.binDir, "maestro"));
			symlinkSync("../maestro-flow/bin/maestro.js", join(fixture.binDir, "maestro"));
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "EPERM") {
				t.skip("The current filesystem does not permit symlink creation");
				return;
			}
			throw error;
		}
		assert.equal(resolveMaestroCliBinDir(fixture.packageRoot, { wsl: true }), fixture.binDir);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("resolveMaestroCliBinDir rejects a package with an unrelated maestro shim", () => {
	const root = mkdtempSync(join(tmpdir(), "pideck-maestro-cli-invalid-"));
	try {
		const { resolveMaestroCliBinDir } = loadTsCommonJs("src/main/pi/maestroCliPath.ts");
		const fixture = createMaestroPackage(root, { validShim: false });
		assert.equal(resolveMaestroCliBinDir(fixture.packageRoot, { wsl: true }), undefined);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("resolveMaestroCliBinDir accepts a symlinked pnpm-style dependency", (t) => {
	const root = mkdtempSync(join(tmpdir(), "pideck-maestro-cli-dependency-link-"));
	try {
		const { resolveMaestroCliBinDir } = loadTsCommonJs("src/main/pi/maestroCliPath.ts");
		const fixture = createMaestroPackage(root);
		const externalDependency = join(root, "pnpm-store", "maestro-flow");
		mkdirSync(join(externalDependency, "bin"), { recursive: true });
		writeFileSync(join(externalDependency, "package.json"), JSON.stringify({
			name: "maestro-flow",
			bin: { maestro: "bin/maestro.js" },
		}));
		writeFileSync(join(externalDependency, "bin", "maestro.js"), "#!/usr/bin/env node\n", "utf8");
		writeFileSync(join(fixture.binDir, "maestro"), "#!/bin/sh\nexec node \"$basedir/../maestro-flow/bin/maestro.js\" \"$@\"\n", "utf8");
		rmSync(join(fixture.packageRoot, "node_modules", "maestro-flow"), { recursive: true, force: true });
		try {
			symlinkSync(externalDependency, join(fixture.packageRoot, "node_modules", "maestro-flow"), "junction");
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "EPERM") {
				t.skip("The current filesystem does not permit directory link creation");
				return;
			}
			throw error;
		}
		assert.equal(resolveMaestroCliBinDir(fixture.packageRoot, { wsl: true }), fixture.binDir);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("resolveMaestroCliBinDir rejects a package whose root is not pi-maestro-flow", () => {
	const root = mkdtempSync(join(tmpdir(), "pideck-maestro-cli-name-"));
	try {
		const { resolveMaestroCliBinDir } = loadTsCommonJs("src/main/pi/maestroCliPath.ts");
		const fixture = createMaestroPackage(root, { name: "not-maestro" });
		assert.equal(resolveMaestroCliBinDir(fixture.packageRoot, { wsl: true }), undefined);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("resolveConfiguredMaestroCliBinDirs follows configured package roots", () => {
	const root = mkdtempSync(join(tmpdir(), "pideck-maestro-cli-configured-"));
	try {
		const { resolveConfiguredMaestroCliBinDirs } = loadTsCommonJs("src/main/pi/maestroCliPath.ts");
		const fixture = createMaestroPackage(root);
		const agentDir = join(root, "agent");
		const settingsFile = join(agentDir, "settings.json");
		put(settingsFile, JSON.stringify({ packages: [fixture.packageRoot] }));
		assert.equal(JSON.stringify(resolveConfiguredMaestroCliBinDirs({
			userSettingsFile: settingsFile,
			userBaseDir: agentDir,
			wsl: true,
		})), JSON.stringify([fixture.binDir]));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
