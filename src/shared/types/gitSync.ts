/**
 * 主分支自动同步的跨进程共享契约。
 *
 * 保守策略（硬约束）：只做 fetch + fast-forward，绝不自动 stash / commit /
 * reset / clean / merge / rebase / force-push。无法安全快进时返回结构化
 * skip/blocked 原因，由用户手动处理。
 */

/** 一次同步尝试的触发来源。 */
export type GitMainSyncSource = "manual" | "startup" | "schedule";

/** 单个 worktree 条目的同步结果。 */
export type GitMainSyncWorktreeState =
	| "updated"
	| "unchanged"
	| "skipped"
	| "blocked"
	| "failed";

/** 整个项目一次同步的汇总状态。 */
export type GitMainSyncStatus =
	| "idle"
	| "running"
	| "updated"
	| "unchanged"
	| "blocked"
	| "failed";

/**
 * 保守同步被跳过/阻塞的结构化原因。
 * 脏/冲突/占用/分叉一律不自动处理，只上报。
 */
export type GitMainSyncSkipReason =
	| "disabled"
	| "not-git-repository"
	| "missing-project"
	| "missing-worktree"
	| "dirty"
	| "conflicted"
	| "active"
	| "diverged"
	| "local-ahead"
	| "no-upstream"
	| "no-main-branch"
	| "remote-failed"
	| "busy"
	| "not-fast-forward"
	| "different-branch"
	| "target-not-checked-out"
	| "unavailable"
	| "failed";

/** 单个 worktree（含主工作区）的同步结果。 */
export type GitMainSyncWorktreeResult = {
	path: string;
	branch: string;
	isMain: boolean;
	status: GitMainSyncWorktreeState;
	reason?: GitMainSyncSkipReason;
	detail?: string;
};

/** 一次项目同步尝试的完整快照（内存态，不持久化）。 */
export type GitMainSyncSnapshot = {
	projectId: string;
	startedAt: number;
	finishedAt?: number;
	source: GitMainSyncSource;
	status: GitMainSyncStatus;
	targetBranch?: string;
	upstream?: string;
	worktrees: GitMainSyncWorktreeResult[];
	error?: string;
};

/** 同步 linked worktree 时的调用方选项。 */
export type GitMainSyncOptions = {
	/** 仅当主分支已就绪且调用方显式允许时，才快进干净的同名 worktree。 */
	syncWorktrees?: boolean;
};
