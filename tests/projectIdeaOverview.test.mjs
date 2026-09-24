import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createStore } from "jotai/vanilla";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { loadProjectIdeaWorkspaces, projectIdeaOverviewIdeas, synchronizeProjectIdeaWorkspaces } = loadTsCommonJs(
  "src/renderer/src/utils/projectIdeaOverview.ts",
);
const {
  openProjectIdeasModalAtom,
  projectIdeasModalOpenAtom,
  projectIdeasModalScopeAtom,
} = loadTsCommonJs("src/renderer/src/atoms/project-idea-atoms.ts");
const { createProjectIdeaWorkspaceRequestGate } = loadTsCommonJs(
  "src/renderer/src/utils/projectIdeaWorkspaceTransition.ts",
);

const workspace = (id) => ({ id, name: id, path: `/projects/${id}`, lastOpenedAt: 1 });

test("project overview refreshes registered worktrees before resolving current workspace groups", async () => {
  const root = { ...workspace("root"), worktreeEnabled: true };
  const child = { ...workspace("feature-a"), worktreeParentId: "root" };
  const calls = [];
  const result = await synchronizeProjectIdeaWorkspaces(
    [root],
    { kind: "project", projectId: "root" },
    {
      scanWorktrees: async (rootProjectId) => { calls.push(`scan:${rootProjectId}`); return [{ path: child.path, branch: "feature-a" }]; },
      listProjects: async () => { calls.push("list"); return [root, child]; },
    },
  );

  assert.deepEqual(Array.from(result.workspaces, (item) => item.id), ["root", "feature-a"]);
  assert.deepEqual(calls, ["scan:root", "list"]);
});

test("project overview keeps registered workspace groups when Git discovery fails", async () => {
  const root = { ...workspace("root"), worktreeEnabled: true };
  const child = { ...workspace("feature-a"), worktreeParentId: "root" };
  const result = await synchronizeProjectIdeaWorkspaces(
    [root, child],
    { kind: "project", projectId: "root" },
    {
      scanWorktrees: async () => { throw new Error("GIT_UNAVAILABLE"); },
      listProjects: async () => [root, child],
    },
  );

  assert.deepEqual(Array.from(result.workspaces, (item) => item.id), ["root", "feature-a"]);
});

test("project overview requires refreshed stable ids after a successful Git scan", async () => {
  const root = { ...workspace("root"), worktreeEnabled: true };
  await assert.rejects(
    synchronizeProjectIdeaWorkspaces(
      [root],
      { kind: "project", projectId: "root" },
      {
        scanWorktrees: async () => [{ path: "/projects/new-child", branch: "new-child" }],
        listProjects: async () => { throw new Error("PROJECT_CATALOG_UNAVAILABLE"); },
      },
    ),
    /PROJECT_CATALOG_UNAVAILABLE/,
  );
});

test("project overview excludes stale registered children missing from the current Git worktree set", async () => {
  const root = { ...workspace("root"), worktreeEnabled: true };
  const current = { ...workspace("feature-a"), worktreeParentId: "root" };
  const stale = { ...workspace("removed"), worktreeParentId: "root" };
  const result = await synchronizeProjectIdeaWorkspaces(
    [root, current, stale],
    { kind: "project", projectId: "root" },
    {
      scanWorktrees: async () => [{ path: current.path.replaceAll("/", "\\"), branch: "feature-a" }],
      listProjects: async () => [root, current, stale],
    },
  );

  assert.deepEqual(Array.from(result.workspaces, (item) => item.id), ["root", "feature-a"]);
});

test("project overview hides completed ideas and promotes unfinished descendants", () => {
  const ideas = [
    { id: "done-parent", projectId: "root", status: "done", derivedFromIdeaId: undefined },
    { id: "active-child", projectId: "root", status: "doing", derivedFromIdeaId: "done-parent" },
    { id: "planned", projectId: "root", status: "planned", derivedFromIdeaId: undefined },
  ];
  const visible = projectIdeaOverviewIdeas(ideas);
  assert.deepEqual(Array.from(visible, (idea) => idea.id), ["active-child", "planned"]);
  assert.equal(visible.some((idea) => idea.status === "done"), false);
});

test("project idea overview preserves successful workspace buckets when another load fails", async () => {
  const rootIdea = { id: "root-idea", projectId: "root" };
  const results = await loadProjectIdeaWorkspaces(
    [workspace("root"), workspace("broken"), workspace("empty")],
    async (workspaceId) => {
      if (workspaceId === "broken") throw new Error("WORKSPACE_GONE");
      return workspaceId === "root" ? [rootIdea] : [];
    },
  );

  assert.deepEqual(JSON.parse(JSON.stringify(results)), [
    { workspaceId: "root", ideas: [rootIdea] },
    { workspaceId: "broken", error: "WORKSPACE_GONE" },
    { workspaceId: "empty", ideas: [] },
  ]);
});

test("overview card handoff retains the requested workspace idea id", () => {
  const store = createStore();
  store.set(openProjectIdeasModalAtom, {
    kind: "workspace",
    workspaceId: "feature-a",
    ideaId: "idea-2",
    overviewProjectId: "root",
  });

  assert.equal(store.get(projectIdeasModalOpenAtom), true);
  assert.deepEqual(store.get(projectIdeasModalScopeAtom), {
    kind: "workspace",
    workspaceId: "feature-a",
    ideaId: "idea-2",
    overviewProjectId: "root",
  });

  store.set(openProjectIdeasModalAtom, { kind: "project", projectId: "root" });
  assert.deepEqual(store.get(projectIdeasModalScopeAtom), { kind: "project", projectId: "root" });
});

test("delayed workspace resource responses cannot cross a back-and-open transition", async () => {
  const gate = createProjectIdeaWorkspaceRequestGate();
  const committed = [];
  const deferred = () => {
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    return { promise, resolve };
  };
  const responseA = deferred();
  const responseB = deferred();
  gate.begin("feature-a");
  const workspaceA = gate.capture("feature-a");
  const taskA = responseA.promise.then((value) => { if (gate.isCurrent(workspaceA)) committed.push(value); });
  gate.invalidate(); // Back to the project overview.
  gate.begin("feature-b");
  const workspaceB = gate.capture("feature-b");
  const taskB = responseB.promise.then((value) => { if (gate.isCurrent(workspaceB)) committed.push(value); });

  responseB.resolve("feature-b-models");
  await taskB;
  responseA.resolve("feature-a-models");
  await taskA;
  assert.deepEqual(committed, ["feature-b-models"]);
});

test("project idea overview guards stale request state and renders per-workspace errors", () => {
  const source = readFileSync("src/renderer/src/components/projectIdeas/ProjectIdeasOverview.tsx", "utf8");
  assert.match(source, /if \(requestRef\.current !== requestId\) return/);
  assert.match(source, /if \(!open \|\| !scopeProjectId\) \{[\s\S]*?setLoading\(true\)/);
  assert.match(source, /overviewReady = open && scopeResolved && !loading/);
  assert.match(source, /open && !overviewReady/);
  assert.match(source, /synchronizeProjectIdeaWorkspaces\(projects, scope/);
  assert.match(source, /desktopApi\.git\.worktreeList\(rootProjectId\)/);
  assert.match(source, /errorsByWorkspace\[workspace\.id\]/);
  assert.match(source, /projectIdeas\.workspaceLoadFailed/);
  assert.match(source, /projectIdeas\.overviewLoadFailed/);
  assert.match(source, /projectIdeaOverviewIdeas\(ideasByWorkspace\[workspace\.id\] \?\? \[\]\)/);
  assert.match(source, /buildProjectIdeaHierarchy\(ideas, "all"\)/);
  assert.match(source, /<ProjectIdeaTree roots=\{hierarchy\}/);
  assert.match(source, /overviewProjectId: scopeProjectId/);
  assert.doesNotMatch(source, /void load\(\)\.catch\(\(\) => setLoading\(false\)\)/);
});

test("workspace editor selects the exact overview card and can return to its project overview", () => {
  const modal = readFileSync("src/renderer/src/components/projectIdeas/ProjectIdeasModal.tsx", "utf8");
  assert.match(modal, /requestedIdeaId = scope\?\.kind === "workspace" \? scope\.ideaId/);
  assert.match(modal, /overviewProjectId = scope\?\.kind === "workspace" \? scope\.overviewProjectId/);
  assert.match(modal, /result\.find\(\(idea\) => idea\.id === requestedIdeaId\)/);
  assert.match(modal, /if \(requestedIdeaId\) return requestedIdea\?\.id \?\? result\[0\]\?\.id \?\? null/);
  assert.match(modal, /projectIdeas\.backToOverview/);
  assert.match(modal, /resetWorkspaceState\(\); openProjectIdeas\(\{ kind: "project", projectId: overviewProjectId \}\)/);
  assert.match(modal, /workspaceRequestGateRef\.current\.isCurrent\(token\)/);
  assert.match(modal, /uploadImage[\s\S]*?workspaceRequestGateRef\.current\.isCurrent\(token\)/);
  assert.match(modal, /ideas\.create[\s\S]*?workspaceRequestGateRef\.current\.isCurrent\(token\)/);
  assert.match(modal, /setImplementationModel\(undefined\)/);
  assert.match(modal, /setImplementationThinkingLevel\(undefined\)/);
  assert.match(modal, /setImplementationModelPickerOpen\(false\)/);
});

test("workspace cancellation clears hook-local errors and results before another workspace opens", () => {
  const refinementHook = readFileSync("src/renderer/src/hooks/useProjectIdeaRefinement.ts", "utf8");
  const plansHook = readFileSync("src/renderer/src/hooks/useProjectIdeaPlans.ts", "utf8");
  assert.match(refinementHook, /const cancel = useCallback\(\(\) => \{[\s\S]*?setError\(null\);[\s\S]*?setResult\(null\);[\s\S]*?setResultTargetKey\(null\)/);
  assert.match(plansHook, /const cancel = useCallback\(\(\) => \{[\s\S]*?setError\(null\);[\s\S]*?setSummary\(null\);[\s\S]*?setRunning\(false\)/);
});

test("root project and workspace rows expose distinct project-aggregate and workspace scopes", () => {
  const projectTree = readFileSync("src/renderer/src/components/sidebar/ProjectTree.tsx", "utf8");
  const worktreeTree = readFileSync("src/renderer/src/components/sidebar/WorktreeTree.tsx", "utf8");
  assert.match(projectTree, /manageIdeas\(\{ kind: "project", projectId: project\.id \}\)/);
  assert.match(projectTree, /projectIdeas\.projectOverviewEntry/);
  assert.match(worktreeTree, /manageIdeas\(\{ kind: "workspace", workspaceId: props\.project\.id \}\)/);
  assert.match(worktreeTree, /manageIdeas\(\{ kind: "workspace", workspaceId: childProject\.id \}\)/);
  const ideaButton = worktreeTree.indexOf('aria-label={t("projectIdeas.workspaceEntry")}');
  const createButton = worktreeTree.indexOf('aria-label={t("app.newNormalSession")}', ideaButton);
  assert.ok(ideaButton >= 0 && createButton > ideaButton, "workspace idea action must be left of create-session");
});

test("worktree refresh publishes stable project ids before workspace rows", () => {
  const source = readFileSync("src/renderer/src/hooks/useProjectSync.ts", "utf8");
  const publishProjects = source.indexOf("setProjects(next);");
  const publishWorktrees = source.indexOf("setWorktreesByProject((prev)");
  assert.ok(publishProjects >= 0 && publishWorktrees > publishProjects);
});
