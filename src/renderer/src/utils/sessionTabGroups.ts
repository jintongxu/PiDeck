/**
 * 会话 Tab 栏「按项目分组」纯逻辑（浏览器标签组风格）。
 *
 * 不变量：
 * - 分组只作用于普通 Tab；固定（pinned）Tab 保持平铺在最前，分组不拆固定区；
 * - 组顺序 = 该组第一个 Tab 在 tabs 中的出现顺序；组内按 tabs 原序 ——
 *   「新打开的会话追加到它所属项目分组的末尾」由这个顺序语义天然保证，
 *   不需要改动 tabs 数组本身；
 * - 无项目归属（projectId 缺失 / 项目已删除）的会话不包组，平铺在组后。
 *
 * 颜色：按 projectId 稳定哈希取色（同一项目恒同色），色值与分屏组色板同源，
 * 见 SPLIT_GROUP_COLOR_PALETTE（SessionTabsBar 引用本常量构建）。
 */

/** 分组色板（浏览器标签组风格 8 色；分屏组与项目分组共用，保证视觉一致）。 */
export const GROUP_COLOR_VALUES = [
	"#0091ff", // blue（默认色，与 SPLIT_GROUP_DEFAULT_COLOR 一致）
	"#30a46c", // green
	"#f5d90a", // yellow
	"#f76b15", // orange
	"#e5484d", // red
	"#8e4ec6", // purple
	"#d6409f", // pink
	"#8d8d8d", // gray
] as const;

export type SessionProjectRef = {
	projectId: string;
	/** 项目显示名（空则回退 projectId） */
	name?: string;
};

export type ProjectTabGroup = {
	projectId: string;
	name: string;
	color: string;
	sessionIds: string[];
};

/**
 * projectId → 稳定色：FNV-1a 风格 31 倍哈希取模色板。
 * 纯展示用，同一 id 永远同色；不同 id 碰撞不影响正确性（只是同色）。
 */
export function projectGroupColor(projectId: string): string {
	let hash = 0;
	for (let i = 0; i < projectId.length; i += 1) {
		hash = (hash * 31 + projectId.charCodeAt(i)) | 0;
	}
	return GROUP_COLOR_VALUES[Math.abs(hash) % GROUP_COLOR_VALUES.length];
}

/** 构建项目分组视图（分组开关开启时 Tab 栏的整体布局数据）。 */
export function buildProjectTabGroups(
	tabs: readonly string[],
	pinned: readonly string[],
	projectOf: (sessionId: string) => SessionProjectRef | undefined,
): { pinned: string[]; groups: ProjectTabGroup[]; loose: string[] } {
	const pinnedOut: string[] = [];
	const loose: string[] = [];
	const groupsByProject = new Map<string, ProjectTabGroup>();
	for (const sessionId of tabs) {
		// 固定 Tab 平铺前置，不参与分组（与「固定 Tab 前置、无关闭按钮」语义一致）。
		if (pinned.includes(sessionId)) {
			pinnedOut.push(sessionId);
			continue;
		}
		const ref = projectOf(sessionId);
		if (!ref || !ref.projectId) {
			// 会话未关联项目（如纯聊天、目录已删除）：不包组，平铺展示。
			loose.push(sessionId);
			continue;
		}
		let group = groupsByProject.get(ref.projectId);
		if (!group) {
			group = {
				projectId: ref.projectId,
				name: ref.name?.trim() || ref.projectId,
				color: projectGroupColor(ref.projectId),
				sessionIds: [],
			};
			groupsByProject.set(ref.projectId, group);
		}
		group.sessionIds.push(sessionId);
	}
	return { pinned: pinnedOut, groups: [...groupsByProject.values()], loose };
}

/**
 * 按 Tab 栏的实际项目分组顺序重排。
 *
 * 渲染层会把同项目会话合并成一个连续节点，因此普通的「把单个 id 插到
 * target 前/后」在跨项目拖动时会被下一次渲染重新聚合，看起来像移动失效。
 * 这里把项目组视为可移动单元；组内拖动仍只调整单个会话，保证数据顺序与
 * 用户看到的顺序始终一致。
 */
export function reorderProjectGroupedSessionTabs(
	tabs: readonly string[],
	pinned: readonly string[],
	sourceId: string,
	targetId: string,
	position: "before" | "after",
	projectOf: (sessionId: string) => SessionProjectRef | undefined,
	specialGroupIds: readonly string[] = [],
): { tabs: string[]; pinned: string[] } {
	if (sourceId === targetId) return { tabs: [...tabs], pinned: [...pinned] };

	const pinnedSet = new Set(pinned);
	const sourcePinned = pinnedSet.has(sourceId);
	const targetPinned = pinnedSet.has(targetId);
	const nextPinned = sourcePinned === targetPinned
		? [...pinned]
		: sourcePinned
			? pinned.filter((id) => id !== sourceId)
			: [...pinned, sourceId];
	const rest = tabs.filter((id) => id !== sourceId);
	const nextPinnedTabs = rest.filter((id) => nextPinned.includes(id));
	const nextNormalTabs = rest.filter((id) => !nextPinned.includes(id));

	if (targetPinned) {
		const index = nextPinnedTabs.indexOf(targetId);
		const at = index < 0 ? nextPinnedTabs.length : index + (position === "after" ? 1 : 0);
		const reorderedPinned = [
			...nextPinnedTabs.slice(0, at),
			sourceId,
			...nextPinnedTabs.slice(at),
		];
		return { tabs: [...reorderedPinned, ...nextNormalTabs], pinned: reorderedPinned };
	}

	const normalInput = [...nextNormalTabs];
	if (sourcePinned) {
		normalInput.push(sourceId);
	} else {
		const sourceIndex = tabs.filter((id) => !pinnedSet.has(id)).indexOf(sourceId);
		normalInput.splice(Math.max(0, Math.min(sourceIndex, normalInput.length)), 0, sourceId);
	}
	const reorderedNormal = reorderNormalTabs(
		normalInput,
		sourceId,
		targetId,
		position,
		projectOf,
		specialGroupIds,
	);
	return {
		tabs: [...nextPinnedTabs, ...reorderedNormal],
		pinned: nextPinned,
	};
}

function reorderNormalTabs(
	tabs: readonly string[],
	sourceId: string,
	targetId: string,
	position: "before" | "after",
	projectOf: (sessionId: string) => SessionProjectRef | undefined,
	specialGroupIds: readonly string[],
): string[] {
	const specialSet = new Set(specialGroupIds);
	const specialIds = specialGroupIds.filter((id) => tabs.includes(id));
	const groupKey = (sessionId: string): string => {
		if (specialSet.has(sessionId)) return "special";
		const projectId = projectOf(sessionId)?.projectId;
		return projectId ? `project:${projectId}` : `loose:${sessionId}`;
	};
	const units: Array<{ key: string; ids: string[] }> = [];
	const unitByKey = new Map<string, { key: string; ids: string[] }>();
	const specialAnchor = specialIds[0];
	for (const sessionId of tabs) {
		const key = groupKey(sessionId);
		if (key === "special" && sessionId !== specialAnchor) continue;
		let unit = unitByKey.get(key);
		if (!unit) {
			const ids = key === "special"
				? specialIds
				: [];
			unit = { key, ids: [...ids] };
			unitByKey.set(key, unit);
			units.push(unit);
		}
		if (key.startsWith("project:") && !unit.ids.includes(sessionId)) {
			unit.ids.push(sessionId);
		} else if (key.startsWith("loose:") && !unit.ids.length) {
			unit.ids.push(sessionId);
		}
	}

	const sourceKey = groupKey(sourceId);
	const targetKey = groupKey(targetId);
	const sourceUnit = units.find((unit) => unit.key === sourceKey);
	const targetUnit = units.find((unit) => unit.key === targetKey);
	if (!sourceUnit || !targetUnit) return [...tabs];

	if (sourceKey === targetKey) {
		const ids = sourceUnit.ids.filter((id) => id !== sourceId);
		const index = ids.indexOf(targetId);
		const at = index < 0 ? ids.length : index + (position === "after" ? 1 : 0);
		sourceUnit.ids = [...ids.slice(0, at), sourceId, ...ids.slice(at)];
	} else {
		const sourceIndex = units.indexOf(sourceUnit);
		units.splice(sourceIndex, 1);
		const targetIndex = units.indexOf(targetUnit);
		const at = targetIndex < 0 ? units.length : targetIndex + (position === "after" ? 1 : 0);
		units.splice(at, 0, sourceUnit);
	}
	return units.flatMap((unit) => unit.ids);
}
