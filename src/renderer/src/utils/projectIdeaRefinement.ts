import type { ProjectIdea, ProjectIdeaKind, ProjectIdeaPlan, ProjectIdeaRefinement } from "../../../shared/types";

const MAX_LIST_ITEMS = 20;
const MAX_FIELD_LENGTH = 20_000;
const MAX_PLAN_ITEMS = 10;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function text(value: unknown): string {
	return typeof value === "string" ? value.trim().slice(0, MAX_FIELD_LENGTH) : "";
}

function list(value: unknown, maxItems = MAX_LIST_ITEMS): string[] {
	if (!Array.isArray(value)) return [];
	return value
		.filter((item): item is string => typeof item === "string")
		.map((item) => item.trim().slice(0, MAX_FIELD_LENGTH))
		.filter(Boolean)
		.filter((item, index, items) => items.indexOf(item) === index)
		.slice(0, maxItems);
}

/** Parse the model's JSON response while tolerating a fenced markdown wrapper. */
export function parseProjectIdeaPlans(response: string): ProjectIdeaPlan[] {
	const trimmed = response.trim();
	const fenced = /```(?:json)?\s*([\s\S]*?)\s*```/i.exec(trimmed)?.[1] ?? trimmed;
	const start = fenced.indexOf("{");
	const end = fenced.lastIndexOf("}");
	if (start < 0 || end <= start) throw new Error("PROJECT_IDEA_PLANS_RESPONSE_INVALID");
	let parsed: unknown;
	try { parsed = JSON.parse(fenced.slice(start, end + 1)) as unknown; } catch { throw new Error("PROJECT_IDEA_PLANS_RESPONSE_INVALID"); }
	if (!isRecord(parsed) || !Array.isArray(parsed.plans)) throw new Error("PROJECT_IDEA_PLANS_RESPONSE_INVALID");
	const plans = parsed.plans.slice(0, MAX_PLAN_ITEMS).map((value, index): ProjectIdeaPlan | null => {
		if (!isRecord(value)) return null;
		const title = text(value.title);
		const summary = text(value.summary);
		if (!title || !summary) return null;
		return {
			id: text(value.id) || `plan-${index + 1}`,
			title,
			summary,
			goal: text(value.goal),
			scope: list(value.scope),
			advantages: list(value.advantages),
			disadvantages: list(value.disadvantages),
			risks: list(value.risks),
			openQuestions: list(value.openQuestions),
		};
	}).filter((plan): plan is ProjectIdeaPlan => plan !== null);
	if (parsed.plans.length > 0 && plans.length === 0) throw new Error("PROJECT_IDEA_PLANS_RESPONSE_INVALID");
	// 空数组是模型明确表示“当前讨论还不足以形成候选方案”，不是 JSON 格式错误。
	// 允许 UI 把用户带回同一个头脑风暴会话继续追问，而不是误报 RESPONSE_INVALID。
	return plans;
}

export function buildProjectIdeaPlansPrompt(transcript: string): string {
	return [
		"你是头脑风暴方案整理助手。请根据下面完整的头脑风暴会话整理出多个可执行候选方案。",
		"只分析和整理，不修改代码，不执行命令，不要替用户选择方案。",
		"必须只返回一个合法 JSON 对象，不要 Markdown 代码块，不要额外解释。",
		"JSON 顶层字段必须是 plans 数组；每个方案必须包含 id、title、summary、goal、scope、advantages、disadvantages、risks、openQuestions，其中 scope、advantages、disadvantages、risks、openQuestions 都是字符串数组。",
		"方案必须来自完整会话内容；信息不足时使用空数组或写入 openQuestions，不要擅自补全。",
		"完整头脑风暴会话：",
		transcript || "（暂无会话内容）",
	].join("\n\n");
}

/** Build the private, single-summary prompt used after the user finishes brainstorming. */
export function buildProjectIdeaBrainstormSummaryPrompt(title: string, body: string, transcript: string): string {
	return [
		"你是项目想法归纳助手。用户已经在头脑风暴会话中完成多轮讨论，现在请把最终共识归纳为一条可继续编辑的项目想法。",
		"不要列出多个候选方案，不要替用户做新的产品决策，不要修改代码，不要执行命令。只保留讨论中已经确认或明确提出的内容；仍不确定的内容放入 openQuestions。",
		"必须只返回一个合法 JSON 对象，不要 Markdown 代码块，不要额外解释。",
		"JSON 字段必须是：summary、problem、goal、expectedOutcome（字符串），scope、acceptanceCriteria、openQuestions（字符串数组）。",
		`原始项目想法标题：${title}`,
		`原始记录：${body || "（暂无正文）"}`,
		"完整头脑风暴会话：",
		transcript || "（暂无会话内容）",
	].join("\n\n");
}

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
	kind: ProjectIdeaKind = "implementation",
): string {
	const brainstormInstructions = kind === "brainstorm"
		? [
			"这是头脑风暴类型：只提出和比较方案，不形成实现任务，不修改代码，也不执行命令。",
			"请把 scope 写成候选方案列表；每项包含方案名称、核心思路、优点和缺点。",
			"请把 acceptanceCriteria 写成方案比较维度或每个方案的优缺点，不要写成必须执行的开发验收标准。",
			"请保留不确定性，把需要用户继续讨论的问题放入 openQuestions；不要擅自选定方案。",
		]
		: [];
	return [
		kind === "brainstorm" ? "你是头脑风暴方案顾问。请把下面这条随笔整理成结构化的讨论提案。" : "你是项目需求整理助手。请把下面这条随笔或草稿整理成可确认的项目想法。",
		"不要修改代码，不要执行命令，也不要把未表达的产品决策当成事实。",
		...brainstormInstructions,
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
export function formatProjectIdeaPlanForImplementation(plan: ProjectIdeaPlan, brainstormTitle: string): string {
	const sections = [
		`来源头脑风暴：${brainstormTitle}`,
		`已采纳方案：${plan.title}`,
		`方案摘要：${plan.summary}`,
		`目标：${plan.goal || "（未填写）"}`,
	];
	if (plan.scope.length) sections.push(`建议范围：\n${plan.scope.map((item) => `- ${item}`).join("\n")}`);
	if (plan.advantages.length) sections.push(`方案优点：\n${plan.advantages.map((item) => `- ${item}`).join("\n")}`);
	if (plan.disadvantages.length) sections.push(`方案缺点：\n${plan.disadvantages.map((item) => `- ${item}`).join("\n")}`);
	if (plan.risks.length) sections.push(`风险：\n${plan.risks.map((item) => `- ${item}`).join("\n")}`);
	if (plan.openQuestions.length) sections.push(`待确认问题：\n${plan.openQuestions.map((item) => `- ${item}`).join("\n")}`);
	return sections.join("\n\n");
}

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

export function formatProjectIdeaForDiscussion(idea: Pick<ProjectIdea, "title" | "body" | "refinement">): string {
	const refinement = idea.refinement;
	const sections = [
		"请围绕下面这条头脑风暴项目想法提出和比较方案。",
		"这是只讨论、不改代码的头脑风暴：不要创建、修改或删除任何项目文件，不要执行会改变项目状态的命令。当前工作目录是否为空、是否存在代码都不影响讨论，不要因此索要项目路径或尝试创建示例项目。请先说明背景，再给出多个候选方案、各自优缺点、适用条件和待确认问题；不要擅自选定方案或开始实现。只有用户之后从项目想法界面明确启动正式实现，才进入编码阶段。",
		`项目想法标题：${idea.title}`,
		`原始记录：\n${idea.body || "（暂无正文）"}`,
	];
	if (!refinement) return sections.join("\n\n");
	sections.push(
		["AI 整理稿：", `讨论主题：${refinement.summary}`, `背景：${refinement.problem}`, `讨论目标：${refinement.goal}`, `期望产出：${refinement.expectedOutcome}`].join("\n"),
	);
	if (refinement.scope.length) sections.push(`候选方案：\n${refinement.scope.map((item) => `- ${item}`).join("\n")}`);
	if (refinement.acceptanceCriteria.length) sections.push(`方案比较维度与优缺点：\n${refinement.acceptanceCriteria.map((item) => `- ${item}`).join("\n")}`);
	if (refinement.openQuestions.length) sections.push(`待确认问题：\n${refinement.openQuestions.map((item) => `- ${item}`).join("\n")}`);
	return sections.join("\n\n");
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
