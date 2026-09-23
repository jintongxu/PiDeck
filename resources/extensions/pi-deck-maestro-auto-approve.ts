/**
 * PiDeck-owned RPC adapter for pi-maestro-flow Plan confirmation.
 *
 * RPC mode cannot render pi-maestro-flow's ctx.ui.custom() TUI panel. This
 * adapter uses PiDeck's standard select UI to choose an action, then supplies
 * that decision to the original upstream plan-confirm call. Keeping approval
 * inside one tool execution prevents a follow-up `/plan approve` turn from
 * observing stale PlanStore state or a different handoff key.
 * PlanStore and Plan/Act state remain owned by pi-maestro-flow; this file never
 * registers a duplicate tool or edits the installed pi-maestro-flow package.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PLAN_WIDGET_KEY = "pideck-plan-confirm";
const PLAN_ACTIONS = [
	"Execute / 执行",
	"Continue discussion / 继续讨论",
	"Exit Plan mode / 退出计划模式",
];
const EXECUTE_DECISION = {
	action: "execute" as const,
	execution: { backend: "standalone" as const, context: "current" as const },
};

type PlanDecision =
	| typeof EXECUTE_DECISION
	| { action: "continue" | "exit-plan" | "close" };

export default function (pi: ExtensionAPI): void {
	let pendingDecision: PlanDecision | undefined;
	let approvalInProgress = false;
	let bridgedUi: object | undefined;
	let latestPlanMarkdown = "";

	// Show the latest decision-complete Plan in PiDeck's existing widget lane.
	// This is display-only; Maestro remains the sole Plan state/Store owner.
	pi.on("tool_call", (event, ctx) => {
		if (event.toolName !== "plan-update") return;
		const markdown = event.input.markdown;
		if (typeof markdown !== "string") return;
		latestPlanMarkdown = markdown;
		ctx.ui.setWidget(
			PLAN_WIDGET_KEY,
			markdown.split(/\r?\n/).slice(0, 240),
			{ widgetPlacement: "aboveEditor" },
		);
	});

	// Native PiDeck approval: select is supported by the RPC protocol, unlike
	// the upstream TUI custom component. Do not block the tool: the upstream
	// plan-confirm implementation must perform the approval commit itself.
	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "plan-confirm") return;
		if (approvalInProgress) return { block: true, terminate: true };
		approvalInProgress = true;
		try {
			const choice = await ctx.ui.select(
				"Plan confirmation / 计划审批",
				PLAN_ACTIONS,
			);
			pendingDecision = choice === PLAN_ACTIONS[0]
				? EXECUTE_DECISION
				: choice === PLAN_ACTIONS[1]
					? { action: "continue" }
					: choice === PLAN_ACTIONS[2]
						? { action: "exit-plan" }
						: { action: "close" };
		} finally {
			approvalInProgress = false;
		}
	});

	// The upstream /plan implementation still owns reviewPlan(), PlanStore
	// approval, Act-mode transition, and handoff-key generation. Only its custom
	// UI result is replaced, so all of those operations remain one atomic flow.
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "rpc") return;
		const ui = ctx.ui;
		if (bridgedUi === ui) return;
		const originalCustom = ui.custom;
		Reflect.set(ui, "custom", async (factory: unknown, options?: unknown): Promise<unknown> => {
			const decision = pendingDecision;
			if (decision) {
				pendingDecision = undefined;
				return decision;
			}
			return Reflect.apply(originalCustom, ui, [factory, options]);
		});
		bridgedUi = ui;
	});

	pi.on("tool_execution_end", (event, ctx) => {
		if (event.toolName === "plan-update" && latestPlanMarkdown) {
			ctx.ui.setWidget(
				PLAN_WIDGET_KEY,
				latestPlanMarkdown.split(/\r?\n/).slice(0, 240),
				{ widgetPlacement: "aboveEditor" },
			);
		}
		if (event.toolName === "plan-confirm") {
			approvalInProgress = false;
			pendingDecision = undefined;
			ctx.ui.setWidget(PLAN_WIDGET_KEY, undefined);
		}
	});

	pi.on("session_shutdown", (_event, ctx) => {
		approvalInProgress = false;
		pendingDecision = undefined;
		latestPlanMarkdown = "";
		ctx.ui.setWidget(PLAN_WIDGET_KEY, undefined);
	});
}
