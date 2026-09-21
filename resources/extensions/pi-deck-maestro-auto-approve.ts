/**
 * PiDeck-owned RPC adapter for pi-maestro-flow Plan confirmation.
 *
 * RPC mode cannot render pi-maestro-flow's ctx.ui.custom() TUI panel. This
 * adapter replaces the model's plan-confirm call with PiDeck's standard
 * select/input UI, then re-enters the upstream `/plan approve` command.
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

type PlanDecision = typeof EXECUTE_DECISION;

export default function (pi: ExtensionAPI): void {
	let executeApprovalPending = false;
	let approvalInProgress = false;
	let approveCommandPending = false;
	let latestPlanMarkdown = "";

	function sendApproveCommand(): void {
		approveCommandPending = true;
		pi.sendUserMessage("/plan approve", {
			deliverAs: "followUp",
			expandPromptTemplates: true,
		});
	}

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

	// Native PiDeck approval: select/input are supported by the RPC protocol,
	// unlike the upstream TUI custom component.
	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "plan-confirm" || approvalInProgress) return;
		approvalInProgress = true;
		const choice = await ctx.ui.select(
			"Plan confirmation / 计划审批",
			PLAN_ACTIONS,
		);
		if (choice === PLAN_ACTIONS[0]) {
			executeApprovalPending = true;
			sendApproveCommand();
		} else if (choice === PLAN_ACTIONS[1]) {
			const feedback = await ctx.ui.input(
				"Continue discussing the Plan / 继续讨论",
				"Enter feedback or a question",
			);
			if (feedback?.trim()) {
				pi.sendUserMessage(feedback.trim(), { deliverAs: "followUp" });
			}
		} else if (choice === PLAN_ACTIONS[2]) {
			pi.sendUserMessage("/plan exit", {
				deliverAs: "followUp",
				expandPromptTemplates: true,
			});
		}
		approvalInProgress = false;
		return { block: true, terminate: true };
	});

	// `/plan approve` is still handled by the upstream command. Its reviewPlan()
	// calls custom(); return the Execute decision selected above.
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "rpc") return;
		const ui = ctx.ui;
		Reflect.set(ui, "custom", async () => {
			if (!approveCommandPending) return undefined;
			approveCommandPending = false;
			if (!executeApprovalPending) return undefined;
			executeApprovalPending = false;
			return EXECUTE_DECISION satisfies PlanDecision;
		});
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
			ctx.ui.setWidget(PLAN_WIDGET_KEY, undefined);
		}
	});

	pi.on("session_shutdown", (_event, ctx) => {
		executeApprovalPending = false;
		approvalInProgress = false;
		approveCommandPending = false;
		latestPlanMarkdown = "";
		ctx.ui.setWidget(PLAN_WIDGET_KEY, undefined);
	});
}
