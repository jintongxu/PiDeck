/**
 * 主分支保守同步编排：只做 fetch + fast-forward。
 *
 * 硬约束（绝不做）：
 * - 不 stash / commit / reset / clean / merge（非 ff）/ rebase / force-push；
 * - 脏、冲突、被占用、分叉的 worktree 一律跳过并给出结构化原因；
 * - 本地领先（local-ahead）时不覆盖本地提交。
 */
import type {
	GitMainSyncOptions,
	GitMainSyncSkipReason,
	GitMainSyncSnapshot,
	GitMainSyncSource,
	GitMainSyncStatus,
	GitMainSyncWorktreeResult,
} from "../../shared/types/gitSync";
import type { Project } from "../../shared/types/project";
import type { WorktreeEntry } from "../../shared/types/git";
import type { GitOperationCoordinator } from "./GitOperationCoordinator";
import type { GitService } from "./GitService";
import type { WorktreeService } from "./WorktreeService";

export type MainBranchSyncServiceDeps = {
	gitService: GitService;
	worktreeService: WorktreeService;
	coordinator: GitOperationCoordinator;
	/** 按 id 取项目；返回 undefined 视为 missing-project。 */
	getProject: (projectId: string) => Project | undefined;
	/** 项目/ worktree 路径 → git 可用的主机路径（WSL 转换由调用方注入）。 */
	toHostPath: (path: string, project?: Project) => string;
	/**
	 * worktree 是否正被运行中的 Agent 使用（running/starting）。
	 * 为 true 时该 worktree 不可变，只上报 active。
	 */
	isActive: (projectId: string, worktreePath?: string) => boolean;
	log?: (message: string, error?: unknown) => void;
};

function blockedWorktree(
	path: string,
	branch: string,
	isMain: boolean,
	reason: GitMainSyncSkipReason,
	detail?: string,
): GitMainSyncWorktreeResult {
	return { path, branch, isMain, status: "blocked", reason, detail };
}

export class MainBranchSyncService {
	private readonly snapshots = new Map<string, GitMainSyncSnapshot>();

	constructor(private readonly deps: MainBranchSyncServiceDeps) {}

	/** 取上次同步快照（内存态，无记录时返回 idle 空快照）。 */
	getSnapshot(projectId: string): GitMainSyncSnapshot {
		return (
			this.snapshots.get(projectId) ?? {
				projectId,
				startedAt: 0,
				source: "manual",
				status: "idle",
				worktrees: [],
			}
		);
	}

	/**
	 * 对单个项目执行一次同步尝试。
	 * 同一仓库并发进入时返回 failed/busy，不排队等待。
	 */
	async syncOne(
		projectId: string,
		source: GitMainSyncSource = "manual",
		opts: GitMainSyncOptions = {},
	): Promise<GitMainSyncSnapshot> {
		const startedAt = Date.now();
		const finish = (snapshot: Omit<GitMainSyncSnapshot, "projectId" | "startedAt" | "finishedAt">): GitMainSyncSnapshot => {
			const full: GitMainSyncSnapshot = {
				...snapshot,
				projectId,
				startedAt,
				finishedAt: Date.now(),
			};
			this.snapshots.set(projectId, full);
			return full;
		};

		const project = this.deps.getProject(projectId);
		if (!project) {
			return finish({ source, status: "blocked", worktrees: [], error: "missing-project" });
		}
		const cwd = this.deps.toHostPath(project.path, project);
		if (!(await this.deps.gitService.isGitRepo(cwd))) {
			return finish({ source, status: "blocked", worktrees: [], error: "not-git-repository" });
		}
		// 同一仓库串行：拿不到锁直接报 busy，不等待（定时任务不應堆积）。
		const release = this.deps.coordinator.tryAcquire(cwd);
		if (!release) {
			return finish({ source, status: "failed", worktrees: [], error: "busy" });
		}
		try {
			try {
				await this.deps.gitService.fetchOrigin(cwd);
			} catch (error) {
				this.deps.log?.("main branch sync fetch failed", error);
				return finish({ source, status: "failed", worktrees: [], error: "remote-failed" });
			}
			const target = await this.deps.gitService.getDefaultBranchName(cwd);
			if (!target) {
				return finish({ source, status: "blocked", worktrees: [], error: "no-main-branch" });
			}
			const remoteRef = `origin/${target}`;
			const entries = await this.deps.worktreeService.listAll(cwd).catch(() => [] as WorktreeEntry[]);
			const main = entries[0];
			if (!main) {
				return finish({
					source,
					status: "blocked",
					targetBranch: target,
					worktrees: [],
					error: "missing-worktree",
				});
			}
			const mainHostPath = this.deps.toHostPath(main.path, project);
			const mainResult = await this.syncMainBranch(
				projectId,
				main,
				mainHostPath,
				target,
				remoteRef,
			);
			let worktrees: GitMainSyncWorktreeResult[] = [mainResult.row];
			let status: GitMainSyncStatus = mainResult.row.status === "updated"
				? "updated"
				: mainResult.row.status === "unchanged"
					? "unchanged"
					: mainResult.row.status === "failed"
						? "failed"
						: "blocked";
			// 只有主分支已就绪（已更新或已是最新）且调用方允许时，才处理 linked worktree。
			if (opts.syncWorktrees && (mainResult.row.status === "updated" || mainResult.row.status === "unchanged")) {
				const linked = await this.syncLinkedWorktrees(
					projectId,
					project,
					entries.slice(1),
					target,
					remoteRef,
				);
				worktrees = [...worktrees, ...linked];
				if (status === "unchanged" && linked.some((row) => row.status === "updated")) {
					status = "updated";
				}
			}
			return finish({
				source,
				status,
				targetBranch: target,
				upstream: mainResult.upstream ?? undefined,
				worktrees,
				error: mainResult.row.reason ?? undefined,
			});
		} finally {
			release();
		}
	}

	/**
	 * 同步主分支引用。
	 * 主 worktree 正在目标分支上 → merge --ff-only；
	 * 否则走 fetch 直写未 checkout 的分支引用（git 会拒绝已 checkout 的分支，不会改写活工作区）。
	 */
	private async syncMainBranch(
		projectId: string,
		main: WorktreeEntry,
		mainHostPath: string,
		target: string,
		remoteRef: string,
	): Promise<{ row: GitMainSyncWorktreeResult; upstream?: string | null }> {
		const row = (status: GitMainSyncWorktreeResult["status"], reason?: GitMainSyncSkipReason, detail?: string): GitMainSyncWorktreeResult => ({
			path: main.path,
			branch: main.branch,
			isMain: true,
			status,
			...(reason ? { reason } : {}),
			...(detail ? { detail } : {}),
		});
		// 主 worktree 目录不可读/已消失：报 unavailable，不碰其他分支。
		const summary = await this.deps.gitService.getPorcelainSummary(mainHostPath).catch(() => null);
		if (!summary) {
			return { row: row("blocked", "unavailable", "main worktree is not accessible") };
		}
		if (summary.conflicted) return { row: row("blocked", "conflicted", "main worktree has merge conflicts") };
		if (summary.dirty) return { row: row("blocked", "dirty", "main worktree has uncommitted changes") };
		if (this.deps.isActive(projectId, mainHostPath)) {
			return { row: row("blocked", "active", "an agent is running in the main worktree") };
		}
		const upstream = await this.deps.gitService.getUpstreamRef(mainHostPath).catch(() => null);
		if (upstream !== `refs/remotes/${remoteRef}`) {
			return { row: row("blocked", "no-upstream", `expected ${remoteRef}`), upstream };
		}
		const localHash = await this.deps.gitService.resolveRefHash(mainHostPath, target);
		const remoteHash = await this.deps.gitService.resolveRefHash(mainHostPath, remoteRef);
		if (!remoteHash) {
			return { row: row("blocked", "no-upstream", `${remoteRef} does not exist`), upstream };
		}
		if (localHash && localHash === remoteHash) {
			return { row: row("unchanged"), upstream };
		}
		const localIsAncestorOfRemote = localHash
			? await this.deps.gitService.isAncestor(mainHostPath, localHash, remoteHash)
			: true;
		const remoteIsAncestorOfLocal = localHash
			? await this.deps.gitService.isAncestor(mainHostPath, remoteHash, localHash)
			: false;
		if (localHash && remoteIsAncestorOfLocal && !localIsAncestorOfRemote) {
			return { row: row("blocked", "local-ahead", "local branch has commits not on the remote"), upstream };
		}
		if (!localIsAncestorOfRemote) {
			return { row: row("blocked", "diverged", "local and remote have diverged"), upstream };
		}
		// 可安全快进。目标分支正在主 worktree 上 → merge --ff-only；
		// 否则直写分支引用（该分支若在别处 checkout，git 会拒绝，落 failed）。
		const current = await this.deps.gitService.getCurrentBranch(mainHostPath);
		try {
			if (current === target) {
				await this.deps.gitService.fastForwardCurrentBranch(mainHostPath, remoteRef);
			} else {
				await this.deps.gitService.fetchBranchIntoLocal(mainHostPath, target, target);
			}
		} catch (error) {
			this.deps.log?.("main branch fast-forward failed", error);
			return {
				row: row(
					"failed",
					current === target ? "failed" : "target-not-checked-out",
					error instanceof Error ? error.message : String(error),
				),
				upstream,
			};
		}
		return { row: row("updated"), upstream };
	}

	/**
	 * 只处理与主分支同名的 linked worktree（功能分支一律跳过，不自动合并）。
	 * 同名且干净可快进 → 在该 worktree 内 merge --ff-only（当前分支即目标分支才执行，
	 * 否则直写引用同样受 git 的 checkout 保护）。
	 */
	private async syncLinkedWorktrees(
		projectId: string,
		project: Project,
		entries: WorktreeEntry[],
		target: string,
		remoteRef: string,
	): Promise<GitMainSyncWorktreeResult[]> {
		const results: GitMainSyncWorktreeResult[] = [];
		for (const entry of entries) {
			const hostPath = this.deps.toHostPath(entry.path, project);
			const row = (status: GitMainSyncWorktreeResult["status"], reason?: GitMainSyncSkipReason, detail?: string): GitMainSyncWorktreeResult => ({
				path: entry.path,
				branch: entry.branch,
				isMain: false,
				status,
				...(reason ? { reason } : {}),
				...(detail ? { detail } : {}),
			});
			const summary = await this.deps.gitService.getPorcelainSummary(hostPath).catch(() => null);
			if (!summary) {
				results.push(row("skipped", "unavailable", "worktree is not accessible"));
				continue;
			}
			if (summary.conflicted) {
				results.push(row("skipped", "conflicted", "worktree has merge conflicts"));
				continue;
			}
			if (summary.dirty) {
				results.push(row("skipped", "dirty", "worktree has uncommitted changes"));
				continue;
			}
			if (this.deps.isActive(projectId, hostPath)) {
				results.push(row("skipped", "active", "an agent is running in this worktree"));
				continue;
			}
			const current = await this.deps.gitService.getCurrentBranch(hostPath);
			if (!current || current !== entry.branch) {
				results.push(row("skipped", "target-not-checked-out", "worktree branch changed during inspection"));
				continue;
			}
			const localHash = await this.deps.gitService.resolveRefHash(hostPath, "HEAD");
			const remoteHash = await this.deps.gitService.resolveRefHash(hostPath, remoteRef);
			if (!localHash || !remoteHash) {
				results.push(row("skipped", "unavailable", "cannot resolve branch tips"));
				continue;
			}
			if (localHash === remoteHash) {
				results.push(row("unchanged"));
				continue;
			}
			const canFastForward = await this.deps.gitService.isAncestor(hostPath, localHash, remoteHash);
			if (!canFastForward) {
				const remoteIsAncestor = await this.deps.gitService.isAncestor(hostPath, remoteHash, localHash);
				results.push(
					row(
						remoteIsAncestor ? "skipped" : "blocked",
						remoteIsAncestor ? "local-ahead" : "diverged",
					),
				);
				continue;
			}
			try {
				// 当前分支只要是 remote main 的祖先，就能安全快进；
				// feature 分支若已经有自己的提交，会在上面的 ancestry 检查中被跳过。
				await this.deps.gitService.fastForwardCurrentBranch(hostPath, remoteRef);
				results.push(row("updated"));
			} catch (error) {
				this.deps.log?.("linked worktree fast-forward failed", error);
				results.push(row("failed", "failed", error instanceof Error ? error.message : String(error)));
			}
		}
		return results;
	}
}
