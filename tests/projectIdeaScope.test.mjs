import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { projectIdeaScopeWorkspaces } = loadTsCommonJs(
  "src/renderer/src/utils/projectIdeaScope.ts",
);

const project = (id, worktreeParentId) => ({
  id,
  name: id,
  path: `/projects/${id}`,
  lastOpenedAt: 1,
  ...(worktreeParentId ? { worktreeParentId } : {}),
});

const projects = [project("root"), project("feature-a", "root"), project("feature-b", "root"), project("other")];

test("workspace idea scope resolves only the concrete workspace", () => {
  assert.deepEqual(
    Array.from(projectIdeaScopeWorkspaces(projects, { kind: "workspace", workspaceId: "feature-a" }), (item) => item.id),
    ["feature-a"],
  );
});

test("project idea scope groups the main workspace and registered worktree children", () => {
  assert.deepEqual(
    Array.from(projectIdeaScopeWorkspaces(projects, { kind: "project", projectId: "root" }), (item) => item.id),
    ["root", "feature-a", "feature-b"],
  );
  assert.deepEqual(
    Array.from(projectIdeaScopeWorkspaces(projects, { kind: "project", projectId: "feature-a" }), (item) => item.id),
    ["root", "feature-a", "feature-b"],
  );
});

test("missing or orphaned project scopes do not infer membership by name or path", () => {
  assert.deepEqual(Array.from(projectIdeaScopeWorkspaces(projects, { kind: "project", projectId: "missing" })), []);
  assert.deepEqual(
    Array.from(projectIdeaScopeWorkspaces([project("orphan", "missing")], { kind: "project", projectId: "orphan" })),
    [],
  );
});
