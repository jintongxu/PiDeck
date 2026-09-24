import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

function setupGitIpc({
	rootPath = join(tmpdir(), "pideck-ipc-root"),
	child,
	createImpl = async () => ({ path: child?.path ?? "", branch: "feature" }),
	removeImpl = async () => false,
	listOrThrowImpl = async () => [],
}) {
	const handlers = new Map();
	const electron = {
		dialog: {},
		ipcMain: {
			handle(channel, handler) {
				handlers.set(channel, handler);
			},
		},
	};
	const { ipcChannels } = loadTsCommonJs("src/shared/ipc.ts");
	const { registerGitIpc } = loadTsCommonJs("src/main/ipc/gitIpc.ts", {
		stubs: { electron },
	});
	const root = {
		id: "root",
		name: "repo",
		path: rootPath,
		lastOpenedAt: 1,
		environment: "windows",
	};
	const calls = { add: [], remove: [], worktreeRemoveBindings: [] };
	registerGitIpc({
		appLogger: {
			warn: async () => {},
			info: async () => {},
			error: async () => {},
		},
		mainCopy: (key) => key,
		gitService: {},
		piLocator: {},
		projectStore: {
			get: (id) => id === root.id ? root : undefined,
			findByPath: (path) => path === child?.path ? child : null,
			add: async (...args) => {
				calls.add.push(args);
				return child ?? { id: "created", path: args[0], worktreeParentId: root.id };
			},
			remove: async (id) => { calls.remove.push(id); },
		},
		settingsStore: {
			get: () => ({
				wslEnabled: false,
				maxEditorFileSizeMB: 10,
			}),
		},
		worktreeService: {
			create: createImpl,
			remove: async (_path, _root, binding) => {
				calls.worktreeRemoveBindings.push(binding);
				return removeImpl(_path, _root, binding);
			},
			listOrThrow: listOrThrowImpl,
		},
	});
	return { calls, handlers, ipcChannels, root };
}

/** 删除复查必须保留 Git 查询失败语义，不能把未知状态当作删除成功。 */
test("git worktree remove keeps the project binding when strict confirmation fails", async () => {
	const child = {
		id: "child",
		name: "feature",
		path: join(tmpdir(), "pideck-ipc-feature"),
		lastOpenedAt: 1,
		worktreeParentId: "root",
		worktreeBranch: "feature",
		worktreeBranchManaged: true,
	};
	let strictListCalls = 0;
	const fixture = setupGitIpc({
		child,
		listOrThrowImpl: async () => {
			strictListCalls += 1;
			throw new Error("git worktree list failed");
		},
	});
	const handler = fixture.handlers.get(fixture.ipcChannels.gitWorktreeRemove);

	await assert.rejects(
		() => handler({}, fixture.root.id, child.path),
		/git worktree list failed/,
	);
	assert.equal(strictListCalls, 1);
	assert.equal(fixture.calls.remove.length, 0, "the retry binding must remain persisted");
});

test("git worktree remove does not report success for an untracked directory that still exists", async () => {
	const temp = mkdtempSync(join(tmpdir(), "pideck-ipc-residual-worktree-"));
	const childPath = join(temp, "feature");
	mkdirSync(childPath);
	const child = {
		id: "child",
		name: "feature",
		path: childPath,
		lastOpenedAt: 1,
		worktreeParentId: "root",
		worktreeBranch: "feature",
		worktreeBranchManaged: true,
	};
	try {
		const fixture = setupGitIpc({ child, rootPath: join(temp, "root") });
		const handler = fixture.handlers.get(fixture.ipcChannels.gitWorktreeRemove);
		assert.equal(await handler({}, fixture.root.id, child.path), false);
		assert.equal(fixture.calls.remove.length, 0);
	} finally {
		rmSync(temp, { recursive: true, force: true });
	}
});

test("git worktree remove never trusts or deletes a binding owned by another parent project", async () => {
	const child = {
		id: "foreign-child",
		name: "feature",
		path: join(tmpdir(), `pideck-foreign-${Date.now()}`),
		lastOpenedAt: 1,
		worktreeParentId: "other-root",
		worktreeBranch: "feature",
		worktreeBranchManaged: true,
	};
	const fixture = setupGitIpc({ child });
	const handler = fixture.handlers.get(fixture.ipcChannels.gitWorktreeRemove);
	await handler({}, fixture.root.id, child.path);

	assert.equal(fixture.calls.worktreeRemoveBindings[0], undefined);
	assert.equal(fixture.calls.remove.length, 0);
});

test("git worktree create persists a managed retry binding when compensating cleanup fails", async () => {
	const failedPath = join(tmpdir(), "pideck-incomplete-feature");
	const cleanupError = Object.assign(new Error("create failed"), {
		worktreePath: failedPath,
		branch: "feature",
	});
	const fixture = setupGitIpc({
		createImpl: async () => { throw cleanupError; },
	});
	const handler = fixture.handlers.get(fixture.ipcChannels.gitWorktreeCreate);
	await assert.rejects(() => handler({}, fixture.root.id, "feature"), /create failed/);

	assert.equal(fixture.calls.add.length, 1);
	assert.equal(fixture.calls.add[0][0], failedPath);
	assert.equal(fixture.calls.add[0][1], fixture.root.id);
	assert.equal(fixture.calls.add[0][3].branch, "feature");
	assert.equal(fixture.calls.add[0][3].managed, true);
});
