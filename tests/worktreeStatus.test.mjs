import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { normalizeWorktreeStatus, worktreeStatusKey } = loadTsCommonJs("src/renderer/src/utils/worktreeStatus.ts");

const status = (patch = {}) => ({
  path: "C:/repo/worktree-a",
  branch: "feature-a",
  isMain: false,
  counts: { staged: 0, modified: 0, untracked: 0, conflicted: 0 },
  changed: 0,
  ahead: null,
  behind: null,
  ...patch,
});

test("worktree status derives clean only from an available zero-change snapshot", () => {
  assert.equal(normalizeWorktreeStatus(status()).clean, true);
  assert.equal(normalizeWorktreeStatus(status({ counts: { staged: 1, modified: 0, untracked: 0, conflicted: 0 } })).clean, false);
  assert.equal(normalizeWorktreeStatus(status({ ahead: 1 })).clean, false);
  assert.equal(normalizeWorktreeStatus(status({ unavailable: true })).clean, false);
});

test("worktree status keys match Windows path spelling variants", () => {
  assert.equal(worktreeStatusKey("C:\\Repo\\Worktree-A\\"), "c:/repo/worktree-a");
  assert.equal(worktreeStatusKey("C:/Repo/Worktree-A"), "c:/repo/worktree-a");
  assert.equal(worktreeStatusKey("/Repo/Worktree-A"), "/Repo/Worktree-A");
});
