import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { hasLiveLatestLinkedSession } = loadTsCommonJs("src/renderer/src/utils/projectIdeaSessionLinks.ts");

test("continue uses only the latest linked implementation session", () => {
  assert.equal(hasLiveLatestLinkedSession(["source", "implementation"], ["source"]), false);
  assert.equal(hasLiveLatestLinkedSession(["source", "implementation"], ["source", "implementation"]), true);
});

test("continue is hidden when no linked session exists", () => {
  assert.equal(hasLiveLatestLinkedSession([], ["source"]), false);
});
