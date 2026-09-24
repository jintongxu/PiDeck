import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const servicePath = "src/main/git/WorktreeService.ts";

function compile(filePath, stubs = {}) {
	const source = readFileSync(filePath, "utf8");
	const output = ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
			esModuleInterop: true,
		},
		fileName: filePath,
	}).outputText;
	const module = { exports: {} };
	const localRequire = (specifier) => stubs[specifier] ?? {};
	vm.runInNewContext(output, {
		module,
		exports: module.exports,
		require: localRequire,
		console,
		process,
	}, { filename: filePath });
	return module.exports;
}

function loadService(execFileImpl = execFile) {
	const stubs = {
		"node:child_process": { execFile: execFileImpl },
		"node:fs": { existsSync },
		"node:path": { basename, dirname, join, resolve },
		"node:util": { promisify },
		"../fs/trash": {
			trashPath: async (path) => rmSync(path, { recursive: true, force: true }),
		},
		"../../shared/worktreeSlug": { worktreeSlugify: (value) => value.trim() },
		"./gitExecutable": { currentGitExecutable: () => "git" },
	};
	return new (compile(servicePath, stubs).WorktreeService)();
}

function git(cwd, ...args) {
	return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function setupRepository() {
	const temp = mkdtempSync(join(tmpdir(), "pideck-worktree-branch-cleanup-"));
	const root = join(temp, "main-repo");
	execFileSync("git", ["init", "-b", "main", root]);
	git(root, "config", "user.email", "test@example.com");
	git(root, "config", "user.name", "PiDeck Test");
	writeFileSync(join(root, "README.md"), "fixture\n", "utf8");
	git(root, "add", "README.md");
	git(root, "commit", "-m", "fixture");
	return { temp, root };
}

function localBranches(root) {
	return git(root, "for-each-ref", "--format=%(refname:short)", "refs/heads")
		.split(/\r?\n/)
		.filter(Boolean);
}

test("remove() deletes the matching PiDeck branch even when git already removed the directory", async () => {
	const { temp, root } = setupRepository();
	const worktreePath = join(temp, "feature-cleanup");
	try {
		git(root, "worktree", "add", "-b", "feature-cleanup", worktreePath);
		const removed = await loadService().remove(
			worktreePath,
			root,
			{ branch: "feature-cleanup", managed: true },
		);

		assert.equal(removed, true);
		assert.equal(existsSync(worktreePath), false, "git worktree remove should remove the directory");
		assert.ok(!localBranches(root).includes("feature-cleanup"), "the matching branch must also be removed");
	} finally {
		rmSync(temp, { recursive: true, force: true });
	}
});

test("remove() reports branch cleanup failure and can retry from a persisted managed binding", async () => {
	const { temp, root } = setupRepository();
	const branch = "feature-retry";
	const worktreePath = join(temp, branch);
	let rejectBranchDelete = true;
	const guardedExecFile = (file, args, options, callback) => {
		if (rejectBranchDelete && args[0] === "branch" && args[1] === "-D") {
			const error = Object.assign(new Error("branch is locked"), { code: 128 });
			callback(error);
			return;
		}
		// 普通 wrapper 没有 execFile 的 custom promisify symbol，因此把成功值组装回
		// { stdout, stderr }，与 WorktreeService 内 promisify(execFile) 的契约一致。
		execFile(file, args, options, (error, stdout, stderr) => {
			if (error) callback(error);
			else callback(null, { stdout, stderr });
		});
	};
	try {
		git(root, "worktree", "add", "-b", branch, worktreePath);
		const service = loadService(guardedExecFile);
		await assert.rejects(
			() => service.remove(worktreePath, root, { branch, managed: true }),
			/branch is locked/,
		);
		assert.equal(existsSync(worktreePath), false, "the worktree removal itself already succeeded");
		assert.ok(localBranches(root).includes(branch), "a failed branch deletion must not be reported as success");

		rejectBranchDelete = false;
		assert.equal(
			await service.remove(worktreePath, root, { branch, managed: true }),
			true,
			"the persisted binding should make the partial deletion retryable",
		);
		assert.ok(!localBranches(root).includes(branch));
	} finally {
		rmSync(temp, { recursive: true, force: true });
	}
});

test("remove() deletes exactly the branch currently bound to the confirmed Git worktree", async () => {
	for (const branch of ["external-same-name", "pideck/external", "测试2"]) {
		const { temp, root } = setupRepository();
		const worktreePath = branch.startsWith("pideck/")
			? join(temp, "external")
			: join(temp, branch);
		const unrelatedBranch = "keep-this-branch";
		try {
			git(root, "branch", unrelatedBranch);
			git(root, "worktree", "add", "-b", branch, worktreePath);
			const removed = await loadService().remove(
				worktreePath,
				root,
				{ branch, managed: false },
			);

			assert.equal(removed, true);
			assert.equal(existsSync(worktreePath), false);
			assert.ok(!localBranches(root).includes(branch), `bound branch ${branch} must be deleted`);
			assert.ok(localBranches(root).includes(unrelatedBranch), "unrelated branches must be preserved");
		} finally {
			rmSync(temp, { recursive: true, force: true });
		}
	}
});

test("create() reuses an orphaned same-name branch left by an older deletion", async () => {
	const { temp, root } = setupRepository();
	const branch = "测试2";
	const expectedPath = join(temp, branch);
	try {
		git(root, "branch", branch);
		const service = loadService();
		const created = await service.create(root, "project-id", branch);

		assert.equal(created.path, expectedPath);
		assert.equal(created.branch, branch);
		assert.equal(existsSync(expectedPath), true);
		assert.ok(localBranches(root).includes(branch));

		assert.equal(
			await service.remove(expectedPath, root, { branch, managed: true }),
			true,
		);
		assert.ok(!localBranches(root).includes(branch));
	} finally {
		rmSync(temp, { recursive: true, force: true });
	}
});

test("ProjectStore persists the verified managed branch binding for deletion retries", async () => {
	const userData = mkdtempSync(join(tmpdir(), "pideck-worktree-binding-"));
	const { ProjectStore } = loadTsCommonJs("src/main/projects/ProjectStore.ts", {
		stubs: {
			electron: {
				app: { getPath: () => userData },
				dialog: {},
			},
		},
	});
	try {
		const store = new ProjectStore();
		await store.load();
		const parent = await store.add(join(userData, "repo"));
		const child = await store.add(
			join(userData, "feature-safe-retry"),
			parent.id,
			"windows",
			{ branch: "feature-safe-retry", managed: true },
		);
		assert.equal(child.worktreeBranch, "feature-safe-retry");
		assert.equal(child.worktreeBranchManaged, true);

		const persisted = JSON.parse(readFileSync(join(userData, "projects.json"), "utf8"));
		const persistedChild = persisted.find((project) => project.id === child.id);
		assert.equal(persistedChild.worktreeBranch, "feature-safe-retry");
		assert.equal(persistedChild.worktreeBranchManaged, true);

		// 关闭/重新打开工作区模式只改变显示开关，必须保留子项目与分支所有权。
		await store.toggleWorktreeEnabled(parent.id);
		await store.toggleWorktreeEnabled(parent.id);
		assert.equal(store.get(child.id)?.worktreeBranchManaged, true);
		assert.equal(store.get(child.id)?.worktreeBranch, "feature-safe-retry");

		// 同一路径若被另一个父仓库扫描到，旧仓库的 managed 标记不得跨边界继承。
		const otherParent = await store.add(join(userData, "other-repo"));
		await store.add(
			child.path,
			otherParent.id,
			"windows",
			{ branch: "feature-safe-retry", managed: false },
		);
		assert.equal(store.get(child.id)?.worktreeParentId, otherParent.id);
		assert.equal(store.get(child.id)?.worktreeBranchManaged, false);
	} finally {
		rmSync(userData, { recursive: true, force: true });
	}
});

test("close-all session strategy only clears chrome state and keeps the workspace selected", () => {
	const { closeAllSessionTabs } = loadTsCommonJs(
		"src/renderer/src/utils/sessionWorkspaceClose.ts",
	);
	const result = closeAllSessionTabs({ activeProjectId: "project-with-worktrees" });
	assert.equal(result.sessionTabIds.length, 0);
	assert.equal(result.previewSessionTabId, null);
	assert.equal(result.splitLayout, null);
	assert.equal(result.focusProjectId, "project-with-worktrees");
	assert.deepEqual(Object.keys(result).sort(), [
		"focusProjectId",
		"previewSessionTabId",
		"sessionTabIds",
		"splitLayout",
	]);
});
