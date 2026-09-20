import { useCallback, useEffect, useState } from "react";
import type { AgentBackend, ComposerAgentMode } from "../../../shared/types";
import { desktopApi } from "../desktopApi";

export const MODE_ORDER: ComposerAgentMode[] = ["normal", "plan", "goal"];

/**
 * 计算「+」菜单里可显示的模式（纯函数，供 hook 与单测共用，单一来源）：
 * - 生图不再是「+」菜单里的可切模式（imagegen 是独立后端，不随后端/模式切换混用）：
 *   imagegen 会话（isImageGen=true）模式菜单为空，走专用生图底栏，互不影响；
 *   而 legacy 含生图消息的 pi 会话（imageGenLocked）同样锁定为生图，不展示 LLM 模式；
 * - Pi 的 plan 状态由 pi-maestro-flow 投影，但不提供桌面模式控制项；goal 仅由 DSH 原生 host 提供；
 */
export function computeVisibleModes(options: {
	isImageGen: boolean;
	planModeAvailable: boolean;
	goalModeAvailable: boolean;
	isDsh?: boolean;
}): ComposerAgentMode[] {
	if (options.isImageGen) return [];
	return MODE_ORDER.filter((mode) => {
		if (mode === "plan") return options.isDsh === true && options.planModeAvailable;
		if (mode === "goal") return options.isDsh === true && options.goalModeAvailable;
		return true;
	});
}

/**
 * 「+」菜单里的模式可用性（原 ComposerModeSelect 底栏 chip 的逻辑迁到这里）：
 * - DSH 恒可用 plan/goal。
 * - pi 的 plan 由已配置的 pi-maestro-flow 提供，但模式控制项不在 PiDeck 菜单中；Pi 不再提供 PiDeck Goal 模式。
 *   DSH 的原生模式能力关闭时若当前正处该模式，强制回退到普通模式。
 * - imageGenLocked（legacy pi 会话已有生图消息）或 backend=imagegen：锁定为生图，
 *   「+」菜单不提供 LLM 模式；imagegen 会话走专用生图底栏。
 */
export function useComposerModeAvailability(props: {
	backend?: AgentBackend;
	imageGenLocked?: boolean;
	value: ComposerAgentMode;
	disabled?: boolean;
	onChange: (mode: ComposerAgentMode) => void;
}) {
	const isDsh = props.backend === "dsh";
	const isImageGen = props.backend === "imagegen" || props.imageGenLocked === true;
	const [planModeAvailable, setPlanModeAvailable] = useState(false);
	const [goalModeAvailable, setGoalModeAvailable] = useState(false);

	const refreshAvailability = useCallback(async () => {
		if (isDsh) {
			setPlanModeAvailable(true);
			setGoalModeAvailable(true);
			return;
		}
		try {
			const result = await desktopApi.extensions.list();
			const maestro = result.extensions.find((extension) => {
				const source = extension.source.toLowerCase();
				return source.includes("pi-maestro-flow");
			});
			setPlanModeAvailable(maestro?.enabled !== false);
			setGoalModeAvailable(false);
		} catch {
			// 扩展列表读取失败时保守处理：两个模式都按不可用对待，避免用户选了却无扩展响应。
			setPlanModeAvailable(false);
			setGoalModeAvailable(false);
		}
	}, [isDsh]);

	// 打开菜单时刷新（扩展开关可能刚在设置页改过）。不可用且当前正在用则强制回退，
	// 这属于模式状态流转的边界：不在这里回退，用户会卡在一个扩展已删的模式上。
	useEffect(() => {
		if (isImageGen) return;
		// Pi 的 Plan 是 pi-maestro-flow 自己维护的状态；它没有桌面控制入口，
		// 因此不能因菜单隐藏而把 flow 的 PLAN 状态误退出。DSH 才由本 hook 负责回退。
		if (isDsh && !planModeAvailable && props.value === "plan") props.onChange("normal");
		if (isDsh && !goalModeAvailable && props.value === "goal") props.onChange("normal");
	}, [goalModeAvailable, isImageGen, planModeAvailable, props.onChange, props.value]);

	const visibleModes = computeVisibleModes({
		isImageGen,
		planModeAvailable,
		goalModeAvailable,
		isDsh,
	});

	return { visibleModes, refreshAvailability };
}