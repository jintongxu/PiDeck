import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const actions = readFileSync("src/renderer/src/hooks/useWorktreeActions.ts", "utf8");
const app = readFileSync("src/renderer/src/App.tsx", "utf8");
const dialog = readFileSync("src/renderer/src/components/sidebar/SidebarComponents.tsx", "utf8");
const sidebar = readFileSync("src/renderer/src/components/sidebar/SidebarContent.tsx", "utf8");

test("isolated session creation resolves the newly registered child worktree before opening a session", () => {
  assert.match(actions, /createAndOpenSession/);
  assert.match(actions, /project\.worktreeParentId === projectId/);
  assert.match(actions, /worktreePathKey\(project\.path\) === createdPath/);
  assert.match(actions, /onProjectReady\(child\.id\)/);
  assert.match(app, /createSessionDraftWithTab\(childProjectId\)/);
});

test("worktree creation keeps ordinary creation separate from create-and-open", () => {
  assert.match(dialog, /onCreateAndOpenSession\?:/);
  assert.match(sidebar, /actions\.worktrees\.createAndOpenSession/);
  assert.match(sidebar, /actions\.worktrees\.create\(/);
});
