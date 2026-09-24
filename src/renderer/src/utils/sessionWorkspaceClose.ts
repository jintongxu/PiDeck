export type CloseAllSessionTabsInput = {
  activeProjectId: string | undefined;
};

export type CloseAllSessionTabsResult = {
  sessionTabIds: [];
  previewSessionTabId: null;
  splitLayout: null;
  focusProjectId: string | undefined;
};

/**
 * “关闭全部”只清理会话工作区 chrome，不改变项目或 Git worktree 生命周期。
 * 保持为纯策略函数，避免今后把关闭标签错误接入物理工作区删除链。
 */
export function closeAllSessionTabs(
  input: CloseAllSessionTabsInput,
): CloseAllSessionTabsResult {
  return {
    sessionTabIds: [],
    previewSessionTabId: null,
    splitLayout: null,
    focusProjectId: input.activeProjectId,
  };
}
