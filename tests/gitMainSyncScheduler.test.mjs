import test from "node:test";
import assert from "node:assert/strict";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { MainBranchSyncScheduler } = loadTsCommonJs("src/main/git/MainBranchSyncScheduler.ts");

test("scheduler is idempotent and single-flight", async () => {
  let resolveSync;
  let calls = 0;
  const gate = new Promise((resolve) => { resolveSync = resolve; });
  const scheduler = new MainBranchSyncScheduler(async () => { calls += 1; await gate; }, () => ["p"], () => ({ enabled: true, intervalMin: 0 }));
  const first = scheduler.tick();
  await scheduler.tick();
  assert.equal(calls, 1);
  resolveSync();
  await first;
  scheduler.start();
  scheduler.start();
  scheduler.stop();
  scheduler.stop();
});

test("scheduler clamps invalid intervals and refreshes settings", () => {
  const scheduler = new MainBranchSyncScheduler(async () => undefined, () => [], () => ({ enabled: true, intervalMin: Number.NaN }));
  scheduler.start();
  scheduler.refresh();
  scheduler.stop();
});
