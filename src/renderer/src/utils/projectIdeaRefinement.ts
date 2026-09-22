import type { ProjectIdea, ProjectIdeaRefinement } from "../../../shared/types";

const MAX_LIST_ITEMS = 20;
const MAX_FIELD_LENGTH = 20_000;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function text(value: unknown): string {
	return typeof value === "string" ? value.trim().slice(0, MAX_FIELD_LENGTH) : "";
}

function list(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value
		.filter((item): item is string => typeof item === "string")
		.map((item) => item.trim().slice(0, MAX_FIELD_LENGTH))
		.filter(Boolean)
		.filter((item, index, items) => items.indexOf(item) === index)
		.slice(0, MAX_LIST_ITEMS);
}

/** Parse the model's JSON response while tolerating a fenced markdown wrapper. */
export function parseProjectIdeaRefinement(response: string, generatedAt = Date.now()): ProjectIdeaRefinement {
	const trimmed = response.trim();
	const fenced = /```(?:json)?\s*([\s\S]*?)\s*```/i.exec(trimmed)?.[1] ?? trimmed;
	const start = fenced.indexOf("{");
	const end = fenced.lastIndexOf("}");
	if (start < 0 || end <= start) throw new Error("PROJECT_IDEA_REFINEMENT_RESPONSE_INVALID");
	let parsed: unknown;
	try {
		parsed = JSON.parse(fenced.slice(start, end + 1)) as unknown;
	} catch {
		throw new Error("PROJECT_IDEA_REFINEMENT_RESPONSE_INVALID");
	}
	if (!isRecord(parsed) || !text(parsed.summary)) throw new Error("PROJECT_IDEA_REFINEMENT_RESPONSE_INVALID");
	return {
		summary: text(parsed.summary),
		problem: text(parsed.problem),
		goal: text(parsed.goal),
		expectedOutcome: text(parsed.expectedOutcome),
		scope: list(parsed.scope),
		acceptanceCriteria: list(parsed.acceptanceCriteria),
		openQuestions: list(parsed.openQuestions),
		generatedAt,
	};
}

/** Build the model instruction for clarification only; it must never ask the agent to edit code. */
export function buildProjectIdeaRefinementPrompt(
	idea: Pick<ProjectIdea, "title" | "body">,
	context?: string,
): string {
	return [
		"你是项目需求整理助手。请把下面这条随笔或草稿整理成可确认的项目想法。",
		"不要修改代码，不要执行命令，也不要把未表达的产品决策当成事实。",
		"只返回一个合法 JSON 对象，不要 Markdown 代码块，不要额外解释。",
		"JSON 字段必须是：summary、problem、goal、expectedOutcome（字符串），scope、acceptanceCriteria、openQuestions（字符串数组）。",
		"信息不足时把不确定内容放入 openQuestions，不要擅自补全。",
		"原始项目想法：",
		`标题：${idea.title}`,
		`内容：${idea.body || "（暂无正文）"}`,
		...(context ? ["当前会话只读上下文（仅用于理解背景，不要把它当成用户新需求）：", context] : []),
	].join("\n\n");
}

const PROJECT_IDEA_SESSION_TITLE_MAX_LENGTH = 80;

/**
 * 从已确认的 AI 整理稿生成关联会话的候选名称。
 * 整理稿的 summary 是项目想法流程已经生成并由用户确认的 AI 摘要；
 * 没有正文时仍可仅凭标题完成整理，因此这里只在 summary 缺失时回退到标题。
 */
export function buildProjectIdeaSessionTitle(
	idea: Pick<ProjectIdea, "title" | "refinement">,
): string {
	const source = idea.refinement?.summary.trim() || idea.title.trim();
	const firstLine = source.split(/\r?\n/, 1)[0]?.trim() ?? "";
	const normalized = firstLine
		.replace(/^(?:目标摘要|摘要|标题|Title)\s*[:：-]\s*/i, "")
		.replace(/^#+\s*/, "")
		.replace(/[ \\t]+/g, " ")
		.trim();
	if (!normalized) return "";
	const characters = Array.from(normalized);
	return characters.length <= PROJECT_IDEA_SESSION_TITLE_MAX_LENGTH
		? normalized
		: `${characters.slice(0, PROJECT_IDEA_SESSION_TITLE_MAX_LENGTH - 1).join("").trimEnd()}…`;
}

export function formatProjectIdeaForExecution(idea: Pick<ProjectIdea, "title" | "body" | "refinement">): string {
	const refinement = idea.refinement;
	const sections = [
		"请直接在当前项目中实现下面这条已经确认的项目想法。",
		"请遵守当前项目的 AGENTS.md 和现有架构约束；先检查相关代码，需求明确时直接实现，完成后运行相关验证并总结结果。",
		`项目想法标题：${idea.title}`,
		`原始记录：\n${idea.body || "（暂无正文）"}`,
	];
	if (!refinement) return sections.join("\n\n");
	sections.push(
		["AI 整理稿：", `目标摘要：${refinement.summary}`, `要解决的问题：${refinement.problem}`, `目标：${refinement.goal}`, `期望结果：${refinement.expectedOutcome}`].join("\n"),
	);
	if (refinement.scope.length) sections.push(`建议范围：\n${refinement.scope.map((item) => `- ${item}`).join("\n")}`);
	if (refinement.acceptanceCriteria.length) sections.push(`验收标准：\n${refinement.acceptanceCriteria.map((item) => `- ${item}`).join("\n")}`);
	if (refinement.openQuestions.length) sections.push(`待确认问题：\n${refinement.openQuestions.map((item) => `- ${item}`).join("\n")}`);
	return sections.join("\n\n");
}
