import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const {
  buildProjectIdeaRefinementPrompt,
  buildProjectIdeaBrainstormSummaryPrompt,
  buildProjectIdeaPlansPrompt,
  buildProjectIdeaSessionTitle,
  formatProjectIdeaForDiscussion,
  formatProjectIdeaPlanForImplementation,
  parseProjectIdeaPlans,
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

test("brainstorm summary prompt asks for one editable refinement without implementation plans", () => {
  const prompt = buildProjectIdeaBrainstormSummaryPrompt("讨论入口", "先讨论方向", "user: 讨论入口\\n\\nassistant: 形成共识");
  assert.match(prompt, /归纳为一条/);
  assert.match(prompt, /不要列出多个候选方案/);
  assert.match(prompt, /只返回一个合法 JSON/);
  assert.match(prompt, /acceptanceCriteria/);
  assert.match(prompt, /完整头脑风暴会话/);
});

test("structured brainstorm plans parse strictly and allow an empty result for continued discussion", () => {
  const plans = parseProjectIdeaPlans(JSON.stringify({ plans: [{ id: "p1", title: "方案一", summary: "先做最小版本", goal: "验证方向", scope: ["入口"], advantages: ["快"], disadvantages: ["能力少"], risks: ["遗漏边界"], openQuestions: ["是否扩展"] }] }));
  assert.equal(parseProjectIdeaPlans('{"plans":[]}').length, 0);
  assert.equal(plans.length, 1);
  assert.match(formatProjectIdeaPlanForImplementation(plans[0], "头脑风暴"), /已采纳方案：方案一/);
  assert.match(buildProjectIdeaPlansPrompt("user: 讨论方案"), /完整头脑风暴会话/);
  assert.throws(() => parseProjectIdeaPlans(JSON.stringify({ plans: [{ summary: "缺少标题" }] })), /PROJECT_IDEA_PLANS_RESPONSE_INVALID/);
});

test("brainstorm ideas produce discussion-only structured prompts", () => {
  const prompt = buildProjectIdeaRefinementPrompt(
    { title: "增加想法类型", body: "先讨论几个可行方向" },
    undefined,
    "brainstorm",
  );
  assert.match(prompt, /头脑风暴/);
  assert.match(prompt, /只提出和比较方案/);
  assert.match(prompt, /不要修改代码/);
  assert.match(prompt, /不要擅自选定方案/);

  const discussion = formatProjectIdeaForDiscussion({
    title: "增加想法类型",
    body: "先讨论几个可行方向",
    refinement: {
      summary: "比较几种实现方向",
      problem: "方向尚未确定",
      goal: "形成可讨论的候选方案",
      expectedOutcome: "明确后续决策问题",
      scope: ["方案 A：最小改动"],
      acceptanceCriteria: ["比较成本与风险"],
      openQuestions: ["是否需要迁移"],
    },
  });
  assert.match(discussion, /只讨论、不改代码/);
  assert.match(discussion, /候选方案/);
  assert.match(discussion, /不要擅自选定方案/);
});
