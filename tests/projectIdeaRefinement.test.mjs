import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const {
  buildProjectIdeaRefinementPrompt,
  buildProjectIdeaSessionTitle,
  formatProjectIdeaForExecution,
  parseProjectIdeaRefinement,
} = loadTsCommonJs("src/renderer/src/utils/projectIdeaRefinement.ts");

const refinementJson = JSON.stringify({
  summary: "让想法可执行",
  problem: "原始记录过于零散",
  goal: "形成明确目标",
  expectedOutcome: "可确认的任务",
  scope: ["整理背景"],
  acceptanceCriteria: ["保留原文"],
  openQuestions: ["是否需要拆分"],
});

test("parseProjectIdeaRefinement accepts plain and fenced JSON", () => {
  assert.equal(parseProjectIdeaRefinement(refinementJson, 10).summary, "让想法可执行");
  assert.equal(Array.from(parseProjectIdeaRefinement("```json\n" + refinementJson + "\n```", 11).acceptanceCriteria).join("|"), "保留原文");
});

test("parseProjectIdeaRefinement rejects responses without a summary", () => {
  assert.throws(() => parseProjectIdeaRefinement(JSON.stringify({ goal: "missing summary" })), /PROJECT_IDEA_REFINEMENT_RESPONSE_INVALID/);
});

test("builds a bounded session title from the confirmed AI summary", () => {
  assert.equal(
    buildProjectIdeaSessionTitle({
      title: "原始标题",
      refinement: { summary: "目标摘要：整理关联会话命名", scope: [], acceptanceCriteria: [], openQuestions: [] },
    }),
    "整理关联会话命名",
  );
  assert.equal(buildProjectIdeaSessionTitle({ title: "仅有标题", refinement: undefined }), "仅有标题");
  assert.equal(buildProjectIdeaSessionTitle({ title: "", refinement: undefined }), "");
  assert.ok(buildProjectIdeaSessionTitle({ title: "x".repeat(120), refinement: undefined }).length <= 80);
});

test("prompts keep refinement separate from execution", () => {
  const prompt = buildProjectIdeaRefinementPrompt({ title: "整理入口", body: "先记下来" });
  assert.match(prompt, /不要修改代码/);
  assert.match(prompt, /只返回一个合法 JSON/);
  const execution = formatProjectIdeaForExecution({ title: "整理入口", body: "先记下来", refinement: parseProjectIdeaRefinement(refinementJson) });
  assert.match(execution, /直接在当前项目中实现/);
  assert.match(execution, /验收标准/);
});
