import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { MainBranchSyncService } = loadTsCommonJs("src/main/git/MainBranchSyncService.ts", {
  stubs: {
    "./GitOperationCoordinator": {},
    "./GitService": {},
    "./WorktreeService": {},
  },
});

function makeService(overrides = {}) {
  const calls = [];
  const { gitService: gitOverrides = {}, ...serviceOverrides } = overrides;
  const baseGitService = {
    isGitRepo: async () => true,
    fetchOrigin: async () => calls.push("fetch"),
    getDefaultBranchName: async () => "main",
    getCurrentBranch: async () => "main",
    getUpstreamRef: async () => "refs/remotes/origin/main",
    getPorcelainSummary: async () => ({ dirty: false, conflicted: false }),
    resolveRefHash: async (_cwd, ref) => ref === "origin/main" ? "b".repeat(40) : "a".repeat(40),
    isAncestor: async () => true,
    fastForwardCurrentBranch: async () => calls.push("ff"),
    fetchBranchIntoLocal: async () => calls.push("branch-ff"),
  };
  const gitService = { ...baseGitService, ...gitOverrides };
  const service = new MainBranchSyncService({
    gitService,
    worktreeService: { listAll: async () => [{ path: "/repo", branch: "main" }] },
    coordinator: { tryAcquire: () => () => {} },
    getProject: () => ({ id: "p", name: "repo", path: "/repo", lastOpenedAt: 1 }),
    toHostPath: (path) => path,
    isActive: () => false,
    log: () => undefined,
    ...serviceOverrides,
  });
  return { service, calls };
}

test("syncs a clean main worktree by fast-forward only", async () => {
  const { service, calls } = makeService();
  const result = await service.syncOne("p");
  assert.equal(result.status, "updated");
  assert.deepEqual(calls, ["fetch", "ff"]);
});

test("does not mutate a dirty or active main worktree", async () => {
  const { service, calls } = makeService({
    gitService: { getPorcelainSummary: async () => ({ dirty: true, conflicted: false }) },
  });
  const result = await service.syncOne("p");
  assert.equal(result.status, "blocked");
  assert.equal(result.worktrees[0]?.reason, "dirty");
  assert.deepEqual(calls, ["fetch"]);
});

test("does not overwrite a locally-ahead main branch", async () => {
  const { service, calls } = makeService({
    gitService: {
      resolveRefHash: async (_cwd, ref) => ref === "origin/main" ? "a".repeat(40) : "b".repeat(40),
      isAncestor: async (_cwd, ancestor, descendant) => ancestor === "a".repeat(40) && descendant === "b".repeat(40),
    },
  });
  const result = await service.syncOne("p");
  assert.equal(result.status, "blocked");
  assert.equal(result.worktrees[0]?.reason, "local-ahead");
  assert.deepEqual(calls, ["fetch"]);
});

test("reports remote failures without touching worktrees", async () => {
  const { service, calls } = makeService({
    gitService: { fetchOrigin: async () => { throw new Error("offline"); } },
  });
  const result = await service.syncOne("p");
  assert.equal(result.status, "failed");
  assert.equal(result.error, "remote-failed");
  assert.deepEqual(calls, []);
});

test("does not sync when the current branch has no configured upstream", async () => {
  const { service, calls } = makeService({
    gitService: { getUpstreamRef: async () => null },
  });
  const result = await service.syncOne("p");
  assert.equal(result.status, "blocked");
  assert.equal(result.worktrees[0]?.reason, "no-upstream");
  assert.deepEqual(calls, ["fetch"]);
});
