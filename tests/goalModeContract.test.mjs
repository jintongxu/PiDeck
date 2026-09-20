import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const agentTypes = readFileSync("src/shared/types/agent.ts", "utf8");
const composerComponents = readFileSync("src/renderer/src/components/session/ComposerComponents.tsx", "utf8");
const composerModeSelect = readFileSync("src/renderer/src/components/session/ComposerComponents.tsx", "utf8");
const controller = readFileSync("src/renderer/src/hooks/useSessionComposerController.ts", "utf8");
const builtIns = readFileSync("src/main/extensions/builtInExtensions.ts", "utf8");
const sendHook = readFileSync("src/renderer/src/hooks/useSessionSend.ts", "utf8");
const agentManager = readFileSync("src/main/pi/AgentManager.ts", "utf8");
const maestroControls = readFileSync("src/shared/maestroControls.ts", "utf8");
const maestroPatch = readFileSync("scripts/patch-pi-maestro-plan.mjs", "utf8");
const packageJson = readFileSync("package.json", "utf8");
const timelineCss = readFileSync("src/renderer/src/styles/timeline.css", "utf8");

test("Goal remains a DSH-native ComposerAgentMode, not a PiDeck Pi extension", () => {
	assert.match(agentTypes, /ComposerAgentMode = "normal" \| "plan" \| "imagegen" \| "goal"/);
	assert.doesNotMatch(builtIns, /pi-deck-goal-mode\.ts/);
	assert.match(controller, /runDshGoalAction/);
});

test("Plan mode is sourced from pi-maestro-flow instead of the retired PiDeck extension", () => {
	assert.doesNotMatch(builtIns, /"pi-deck-plan-mode\.ts"/);
	assert.match(controller, /PIDECK_MAESTRO_PLAN_ENTER/);
	assert.match(controller, /PIDECK_MAESTRO_PLAN_EXIT/);
	assert.match(controller, /message: nextMode === "plan" \? PIDECK_MAESTRO_PLAN_ENTER : PIDECK_MAESTRO_PLAN_EXIT/);
	assert.match(controller, /statuses\["mode"\]/);
	assert.doesNotMatch(readFileSync("src/renderer/src/composerBehavior.ts", "utf8"), /PI_DECK_PLAN_MODE_MARKER/);
	assert.match(maestroControls, /PIDECK_MAESTRO_PLAN_ENTER/);
	assert.match(maestroControls, /PIDECK_MAESTRO_PLAN_EXIT/);
	assert.match(agentManager, /isPrivateMaestroPlanControl/);
	assert.match(agentManager, /if \(!isPrivateControl\)/);
	assert.match(maestroPatch, /planToggleMode/);
	assert.match(maestroPatch, /planExitMode/);
	assert.match(maestroPatch, /event\.source !== "rpc"/);
	assert.match(packageJson, /patch-pi-maestro-plan\.mjs/);
});

test("DSH mode picker retains Goal while Pi mode availability excludes it", () => {
	// 模式选择器已重构进 ComposerComponents（旧 ComposerModeSelect.tsx 已删）：
	// 三态由 props.composerAgentMode 驱动，图标/文案锚点在同组件内
	assert.match(composerModeSelect, /mode === "goal"/);
	assert.match(composerModeSelect, /"app\.composerModeGoal"/);
	assert.match(composerModeSelect, /composerAgentMode === "goal"/);
	assert.match(composerModeSelect, /<Select/);
	const modeAvailability = readFileSync("src/renderer/src/hooks/useComposerModeAvailability.ts", "utf8");
	assert.match(modeAvailability, /options\.isDsh === true && options\.goalModeAvailable/);
	assert.match(composerModeSelect, /只有 DSH 保留原生模式控制/);
	// 图标分支顺序：plan → imagegen → goal（实现）；契约只断言 goal 存在且三态齐全
	const planOrder = composerModeSelect.indexOf('mode === "plan"');
	const goalOrder = composerModeSelect.indexOf('mode === "goal"');
	const imagegenOrder = composerModeSelect.indexOf('mode === "imagegen"');
	assert.ok(planOrder >= 0 && goalOrder >= 0 && imagegenOrder >= 0);
});

test("DSH setMode pauses on normal and resumes paused goals", () => {
	assert.match(controller, /runDshGoalAction\(agentId, "pause"\)/);
	assert.match(controller, /runDshGoalAction\(agentId, "resume"\)/);
	assert.match(controller, /dshGoal\.pendingNotice/);
	assert.match(controller, /deriveComposerAgentMode/);
});

test("goal/plan composer chrome uses an inset accent rail and an in-chip exit", () => {
	// 身份条画在圆角盒内侧：贴外沿的 3px 实心条在默认近黑 accent 下会像一根粗棍。
	const rail = timelineCss.match(/\.composer-box::before \{[\s\S]*?\n\}/)?.[0] ?? "";
	assert.match(rail, /left:\s*8px/);
	assert.match(rail, /width:\s*2px/);
	assert.match(rail, /border-radius:\s*999px/);
	assert.doesNotMatch(rail, /left:\s*-1px/);
	assert.doesNotMatch(rail, /width:\s*3px/);
	assert.match(timelineCss, /\.composer-box\.goal-mode::before \{[\s\S]*?color-mix\(in srgb, var\(--color-accent\) 55%/);
	assert.match(composerComponents, /composer-mode-cluster/);
	assert.match(composerComponents, /composer-mode-exit/);
	assert.match(composerComponents, /composer-maestro-mode-indicator[^"]*size-7/);
	assert.match(composerComponents, /<ListChecks size=\{15\}/);
	assert.match(composerComponents, /<Wrench size=\{15\}/);
	assert.match(composerComponents, /title=\{`\$\{t\(isPlanMode/);
	assert.doesNotMatch(composerComponents, /composer-maestro-mode-indicator[\s\S]{0,500}<span/);
	assert.match(composerComponents, /<X size=\{12\}/);
	assert.doesNotMatch(composerComponents, /mode-cancel/);
});

test("send path keeps DSH off agentMessage and uses /goal transform", () => {
	assert.match(sendHook, /applyDshGoalSendTransform/);
	assert.match(sendHook, /isDshSend \? "normal" : sendMode/);
});
