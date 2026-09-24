import test from "node:test";
import assert from "node:assert/strict";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { GitOperationCoordinator } = loadTsCommonJs("src/main/git/GitOperationCoordinator.ts");

test("coordinator serializes operations by key", async () => {
  const coordinator = new GitOperationCoordinator();
  const order = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const first = coordinator.acquire("repo", async () => { order.push("first"); await gate; order.push("first-done"); });
  await new Promise((resolve) => setImmediate(resolve));
  const second = coordinator.acquire("repo", async () => { order.push("second"); });
  assert.deepEqual(order, ["first"]);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(order, ["first", "first-done", "second"]);
});

test("tryAcquire is non-blocking and keyed", () => {
  const coordinator = new GitOperationCoordinator();
  const release = coordinator.tryAcquire("repo");
  assert.ok(release);
  assert.equal(coordinator.tryAcquire("repo"), null);
  release();
  assert.ok(coordinator.tryAcquire("repo"));
});
