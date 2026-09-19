export type SidebarSessionOrderScope = "active" | "chat";
export type SidebarDropPosition = "before" | "after";

/**
 * Normalize user-controlled sidebar session ids at the settings boundary.
 * Unknown ids are intentionally retained so sessions loaded later can recover
 * their position without another migration.
 */
export function normalizeSidebarSessionOrder(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	const ids = new Set<string>();
	for (const candidate of value) {
		if (typeof candidate !== "string") continue;
		const id = candidate.trim();
		if (id) ids.add(id);
	}
	return [...ids];
}

/** Move one stable id before or after the target id, preserving all other ids. */
export function reorderStableIds(
	order: readonly string[],
	sourceId: string,
	targetId: string,
	position: SidebarDropPosition = "before",
): string[] {
	if (!sourceId || !targetId || sourceId === targetId) return [...order];
	const next = normalizeSidebarSessionOrder(order);
	if (!next.includes(sourceId)) next.push(sourceId);
	if (!next.includes(targetId)) next.push(targetId);
	const withoutSource = next.filter((id) => id !== sourceId);
	const targetIndex = withoutSource.indexOf(targetId);
	if (targetIndex < 0) return withoutSource;
	withoutSource.splice(targetIndex + (position === "after" ? 1 : 0), 0, sourceId);
	return withoutSource;
}

/** Backward-compatible semantic alias for the activity/chat sidebar order. */
export const reorderSidebarSessionIds = reorderStableIds;

/** Return a stable ordering index; unknown sessions sort after ordered ones. */
export function sidebarSessionOrderIndex(
	order: readonly string[],
	sessionId: string | undefined,
): number {
	if (!sessionId) return Number.MAX_SAFE_INTEGER;
	const index = order.indexOf(sessionId);
	return index >= 0 ? index : Number.MAX_SAFE_INTEGER;
}
