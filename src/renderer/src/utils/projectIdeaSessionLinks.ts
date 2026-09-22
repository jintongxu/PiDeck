/**
 * “继续处理”只针对最近一次关联会话。
 * linkedSessionIds 还可能包含最初保存想法时的来源会话；若最新实现会话已删除，
 * 不能因为更早的来源会话仍存在而继续显示入口。
 */
export function hasLiveLatestLinkedSession(
	linkedSessionIds: readonly string[],
	availableSessionIds: readonly string[],
): boolean {
	const latestSessionId = linkedSessionIds.at(-1);
	return Boolean(latestSessionId && availableSessionIds.includes(latestSessionId));
}
