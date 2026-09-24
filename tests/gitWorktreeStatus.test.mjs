import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { after, before, test } from "node:test";

const require = createRequire(import.meta.url);
const buildDir = mkdtempSync(join(tmpdir(), "pideck-git-worktree-status-build-"));
const root = mkdtempSync(join(tmpdir(), "pideck-git-worktree-status-"));
let GitService;

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

before(() => {
  execFileSync(process.execPath, [
    resolve("node_modules/typescript/bin/tsc"),
    "src/main/git/GitService.ts",
    "src/shared/types.ts",
    "--module", "commonjs", "--target", "es2022", "--moduleResolution", "node",
    "--esModuleInterop", "--skipLibCheck", "--outDir", buildDir,
  ], { cwd: resolve("."), stdio: "pipe" });
  const electronDir = join(buildDir, "node_modules", "electron");
  mkdirSync(electronDir, { recursive: true });
  writeFileSync(join(electronDir, "package.json"), JSON.stringify({ name: "electron", main: "index.js" }));
  writeFileSync(join(electronDir, "index.js"), "exports.shell = { trashItem: async () => {} };\n");
  ({ GitService } = require(join(buildDir, "main/git/GitService.js")));
  git(root, "init");
  git(root, "config", "user.name", "PiDeck Test");
  git(root, "config", "user.email", "test@example.com");
  writeFileSync(join(root, "tracked.txt"), "initial\n");
  git(root, "add", "tracked.txt");
  git(root, "commit", "-m", "initial");
});

after(() => {
  rmSync(buildDir, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

test("GitService aggregates independent status counts for multiple worktrees", async () => {
  const child = join(root, "feature-a");
  git(root, "worktree", "add", "-b", "feature-a", child);
  writeFileSync(join(root, "main-change.txt"), "main\n");
  writeFileSync(join(child, "child-change.txt"), "child\n");
  git(child, "add", "child-change.txt");

  const service = new GitService();
  const statuses = await service.getWorktreeStatus(root, [
    { path: root, branch: "master" },
    { path: child, branch: "feature-a" },
  ]);

  assert.equal(statuses.length, 2);
  assert.equal(statuses[0].isMain, true);
  assert.ok(statuses[0].counts.untracked >= 1);
  assert.equal(statuses[1].isMain, false);
  assert.equal(statuses[1].counts.staged, 1);
  assert.equal(statuses[1].counts.modified, 0);
  assert.equal(statuses[1].unavailable, undefined);
});

test("GitService preserves unavailable rows when a worktree path disappears", async () => {
  const service = new GitService();
  const statuses = await service.getWorktreeStatus(root, [
    { path: root, branch: "master" },
    { path: join(root, "missing-worktree"), branch: "gone" },
  ]);
  assert.equal(statuses[1].unavailable, true);
  assert.equal(statuses[1].ahead, null);
  assert.equal(statuses[1].behind, null);
});
