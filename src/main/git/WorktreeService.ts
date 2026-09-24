import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { trashPath } from "../fs/trash";
import { currentGitExecutable } from "./gitExecutable";
import { worktreeSlugify } from "../../shared/worktreeSlug";
import type { WorktreeEntry } from "../../shared/types";
import type { MainProcessTranslationKey } from "../../shared/i18n/mainProcessCopy";

const execFileAsync = promisify(execFile);
type WorktreeCopy = (
	key: MainProcessTranslationKey,
	params?: Record<string, string | number>,
) => string;

/** 创建已失败且补偿清理也未完成；IPC 用携带的 binding 持久化安全重试入口。 */
export class WorktreeCreateCleanupError extends Error {
	constructor(
		message: string,
		readonly worktreePath: string,
		readonly branch: string,
		options: { cause: unknown },
	) {
		super(message, options);
		this.name = "WorktreeCreateCleanupError";
	}
}

/**
 * 管理 git worktree 的创建、查询、删除。
 *
 * 工作树目录创建在项目目录的同级位置（标准 git worktree 行为）：
 * {dirname(projectPath)}/{slug}，目录名与分支名一致，
 * 用户可以直接在文件管理器中找到 worktree 文件。
 */
export class WorktreeService {
	constructor(
		private readonly translate: WorktreeCopy = () => "Worktree operation failed.",
	) {}

	/**
	 * 获取指定项目仓库的所有 worktree（排除主工作区）。
	 * 使用 git worktree list --porcelain 解析。
	 *
	 * 主工作区 = git 仓库根 checkout（由 --git-common-dir 推导），而非当前 projectPath：
	 * 当 PiDeck 从某个子 worktree 打开时，projectPath 是 worktree 目录，主工作区
	 * 会作为普通条目出现在列表中；若不排除，用户误点删除会整目录 rm -rf（曾导致
	 * 主工作区 40G 数据丢失）。
	 */
	async list(projectPath: string): Promise<WorktreeEntry[]> {
		try {
			return await this.listOrThrow(projectPath);
		} catch {
			return [];
		}
	}

	/**
	 * 严格列出 linked worktrees。删除链必须使用此方法，不能把 Git 查询失败的空数组
	 * 误判为“目标已不存在”并向用户报告成功。
	 */
	async listOrThrow(projectPath: string): Promise<WorktreeEntry[]> {
		const entries = await this.listAllOrThrow(projectPath);
		const mainWorktree = await this.getMainWorktreeOrThrow(projectPath);
		return entries.filter((entry) => !this.samePath(entry.path, mainWorktree));
	}

	/** List the main checkout and all linked worktrees for read-only status aggregation. */
	async listAll(projectPath: string): Promise<WorktreeEntry[]> {
		try {
			return await this.listAllOrThrow(projectPath);
		} catch {
			return [];
		}
	}

	private async listAllOrThrow(projectPath: string): Promise<WorktreeEntry[]> {
		const { stdout } = await execFileAsync(
			currentGitExecutable(),
			["worktree", "list", "--porcelain"],
			{ cwd: projectPath },
		);
		const entries = this.parseWorktreeList(stdout, "");
		// Git normally prints the main checkout first, but make that ordering an
		// explicit contract so `isMain` remains correct across Git versions.
		const mainWorktree = await this.getMainWorktreeOrThrow(projectPath);
		const mainIndex = entries.findIndex((entry) => this.samePath(entry.path, mainWorktree));
		if (mainIndex <= 0) return entries;
		const [main] = entries.splice(mainIndex, 1);
		entries.unshift(main);
		return entries;
	}

	/**
	 * 基于当前 HEAD 创建新的 worktree。
	 * 使用 OpenCode 的方式：--no-checkout -b {branch} 创建分支，再 git reset --hard 填充。
	 */
	async create(
		projectPath: string,
		projectId: string,
		branchName: string,
	): Promise<{ path: string; branch: string }> {
		const baseSlug = worktreeSlugify(branchName);
		// worktree 放在项目目录的同级位置：{dirname(projectPath)}/{slug}
		// 这样用户可以在项目同级目录下直接找到 worktree 文件，符合标准 git worktree 习惯。
		const parentDir = resolve(projectPath, "..");

		const { worktreeDir, branch, createBranch } = await this.allocateWorktreeTarget(projectPath, parentDir, baseSlug);

		// 同名分支若是旧版删除遗留、且未被任何 worktree 使用，则直接复用；新名称才用 -b 创建。
		// 两条路径都先 --no-checkout，再 reset --hard 填充工作区。
		try {
			await execFileAsync(
				currentGitExecutable(),
				createBranch
					? ["worktree", "add", "--no-checkout", "-b", branch, worktreeDir]
					: ["worktree", "add", "--no-checkout", worktreeDir, branch],
				{ cwd: projectPath },
			);
		} catch (error) {
			console.error("[WorktreeService] git worktree add failed", error);
			throw new Error(this.translate("mainWorktree.createFailed"));
		}

		try {
			await execFileAsync(currentGitExecutable(), ["reset", "--hard"], { cwd: worktreeDir });
		} catch (error) {
			// reset 失败时补偿清理刚创建的 worktree 与分支。清理失败不能吞掉：携带显式
			// managed binding 交给 IPC 持久化，避免同名创建永久被无主残留分支阻塞。
			try {
				const cleaned = await this.remove(worktreeDir, projectPath, {
					branch,
					managed: true,
					preserveBranch: !createBranch,
				});
				if (!cleaned) throw new Error("Incomplete worktree cleanup was rejected by Git");
			} catch (cleanupError) {
				throw new WorktreeCreateCleanupError(
					this.translate("mainWorktree.createFailed"),
					worktreeDir,
					branch,
					{
						cause: new AggregateError(
							[error, cleanupError],
							"Worktree initialization and compensating cleanup both failed",
						),
					},
				);
			}
			console.error("[WorktreeService] git reset failed for new worktree", error);
			throw new Error(this.translate("mainWorktree.createFailed"));
		}

		return { path: worktreeDir, branch };
	}

	/**
	 * 删除指定 worktree。
	 * 先 git worktree remove --force，再清理目录，最后删除对应的分支。
	 *
	 * 安全约束（防止误删主工作区/非 worktree 目录）：
	 * 1. 目标必须出现在严格 Git 列表中（已排除主工作区），查询失败直接抛错；
	 * 2. 目标与仓库主工作区 realpath 相等时直接拒绝（硬性兜底，即使 list 过滤被绕过）；
	 * 3. git worktree remove 失败时：目录仍存在则拒绝物理删除——旧实现 catch 后
	 *    无条件 rm -rf，若 git 因“不能移除主工作区”等拒绝，会把主项目目录整个删掉；
	 *    目录已不存在（外部删过的残留记录）则继续清理，rm 无物理内容可删。
	 */
	async remove(
		worktreePath: string,
		projectPath: string,
		persistedBinding?: { branch: string; managed: boolean; preserveBranch?: boolean },
	): Promise<boolean> {
		const entries = await this.listOrThrow(projectPath);
		// 统一 resolve 路径空间（与 porcelain 解析/同一台机器 8.3 短名一致）；
		// 此前 canonical（realpath 长名）与 samePath（resolve 空间）混用，
		// Windows 短路径下 entry 永远匹配不上 → 删除按钮静默失效。
		const normalizedTarget = this.canonicalSync(worktreePath);
		const entry = entries.find(asyncEntry => this.samePath(asyncEntry.path, normalizedTarget));
		if (!entry) {
			// Git 已不跟踪且目录也不存在时，仅持久化的精确 branch binding 能支持重试。
			// binding 来自此前的 Git porcelain 记录，并由 IPC 校验父项目归属，不按目录名猜测。
			if (existsSync(worktreePath) || !persistedBinding) return false;
			if (persistedBinding.branch !== "detached") {
				await this.deleteBranch(projectPath, persistedBinding.branch);
			}
			return true;
		}

		// 硬性防护：目标与仓库主工作区相同时拒绝删除（realpath 比较，兼容 junction/8.3 短路径）。
		const mainWorktree = await this.getMainWorktreeOrThrow(projectPath);
		if (this.samePath(this.canonicalSync(mainWorktree), normalizedTarget)) {
			return false;
		}

		try {
			await execFileAsync(currentGitExecutable(), ["worktree", "remove", "--force", worktreePath], { cwd: projectPath });
		} catch {
			// git 拒绝移除：目录仍存在 → 拒绝物理删除（安全优先，删不掉也比删错强）；
			// 目录已不存在 → 残留记录清理场景，无需回收站（无内容可删），继续视为成功。
			if (existsSync(worktreePath)) return false;
		}

		// git 已确认移除后，把仍残留的物理目录移入系统回收站（可恢复删除）。
		// 正常情况下 git worktree remove 会直接移除目录；不能因此提前返回，否则下面的
		// 分支清理永远不会执行，同名工作区再次创建时就会被残留分支阻塞。
		if (existsSync(worktreePath)) {
			// 回收站不可用时 trashPath 抛错：删除失败比永久丢失安全（历史教训：误删 40G）。
			await trashPath(worktreePath, { source: "git:worktree-remove" });
		}

		// 用户删除链会删除 Git 当前精确绑定的分支；仅“复用历史孤儿分支后初始化失败”的
		// 补偿清理显式 preserveBranch，避免回滚误删原有分支。
		if (!persistedBinding?.preserveBranch && entry.branch !== "detached") {
			await this.deleteBranch(projectPath, entry.branch);
		}

		return true;
	}

	/**
	 * 强制删除 PiDeck 管理的本地分支。失败时仅在 ref 已确认不存在时视为成功；
	 * 否则向上抛错，让 IPC 保留项目 binding，用户可再次删除重试。
	 */
	private async deleteBranch(projectPath: string, branch: string): Promise<void> {
		try {
			await execFileAsync(currentGitExecutable(), ["branch", "-D", branch], { cwd: projectPath });
		} catch (error) {
			try {
				await execFileAsync(
					currentGitExecutable(),
					["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
					{ cwd: projectPath },
				);
			} catch (verifyError) {
				// show-ref 的退出码 1 才能证明 ref 不存在；Git/权限等其他错误不能伪装成成功。
				if (
					typeof verifyError === "object" &&
					verifyError !== null &&
					"code" in verifyError &&
					verifyError.code === 1
				) return;
			}
			throw error;
		}
	}

	/**
	 * 生成目标目录名和分支名。
	 * 不再静默追加 -a/-b：用户输入 test 就只尝试创建 test，
	 * 若同级目录或分支已存在则明确报错，避免最终出现非用户预期的 test-a。
	 */
	private async allocateWorktreeTarget(projectPath: string, parentDir: string, baseSlug: string) {
		const slug = baseSlug;
		const worktreeDir = join(parentDir, slug);
		const branch = slug;
		if (existsSync(worktreeDir)) {
			throw new Error(this.translate("mainWorktree.folderExists"));
		}
		const ref = await execFileAsync(currentGitExecutable(), ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: projectPath })
			.then(() => true)
			.catch(() => false);
		if (ref) {
			// 兼容旧版删除只移除目录、遗留同名分支的情况：未被任何 worktree checkout 的
			// 本地分支可以安全复用；仍在主/其他 worktree 使用时继续明确报冲突。
			const branchInUse = (await this.listAllOrThrow(projectPath)).some(
				(entry) => entry.branch === branch,
			);
			if (branchInUse) throw new Error(this.translate("mainWorktree.branchExists"));
			return { worktreeDir, branch, createBranch: false };
		}
		return { worktreeDir, branch, createBranch: true };
	}


	/** 通过共享 .git 目录严格推导主工作区；Git 查询失败必须向删除链传播。 */
	private async getMainWorktreeOrThrow(projectPath: string): Promise<string> {
		const { stdout } = await execFileAsync(
			currentGitExecutable(),
			["rev-parse", "--git-common-dir"],
			{ cwd: projectPath },
		);
		const commonDir = stdout.trim();
		if (!commonDir) throw new Error("Git returned an empty common directory");
		return dirname(resolve(projectPath, commonDir));
	}

	/**
	 * 解析 git worktree list --porcelain 输出。
	 * 过滤掉主工作区（rootPath，由 getMainWorktree 推导的仓库根），只返回其他 worktree。
	 */
	private parseWorktreeList(stdout: string, rootPath: string): WorktreeEntry[] {
		const entries: WorktreeEntry[] = [];
		// 规范化路径用于比较（Windows 忽略大小写）
		const normalizedRoot = rootPath ? this.canonicalSync(rootPath) : null;

		const lines = stdout.split(/\r?\n/);
		let current: Partial<WorktreeEntry> | null = null;

		for (const line of lines) {
			const trimmed = line.trim();
			if (!trimmed) {
				// 空行 = 条目结束
				if (current) {
					const path = current.path ? resolve(current.path) : "";
					if (!normalizedRoot || !this.samePath(path, normalizedRoot)) {
						entries.push({
							path,
							branch: current.branch?.replace(/^refs\/heads\//, "") ?? "detached",
						});
					}
					current = null;
				}
				continue;
			}

			if (trimmed.startsWith("worktree ")) {
				current = { path: trimmed.slice("worktree ".length).trim() };
				continue;
			}

			if (current && trimmed.startsWith("branch ")) {
				current.branch = trimmed.slice("branch ".length).trim();
			}
		}

		// 处理最后一条（文件可能不以空行结尾）
		if (current) {
			const path = current.path ? resolve(current.path) : "";
			if (!normalizedRoot || !this.samePath(path, normalizedRoot)) {
				entries.push({
					path,
					branch: current.branch?.replace(/^refs\/heads\//, "") ?? "detached",
				});
			}
		}

		return entries;
	}

	private canonicalSync(input: string) {
		const normalized = resolve(input);
		return process.platform === "win32" ? normalized.toLowerCase() : normalized;
	}

	private samePath(a: string, b: string) {
		return this.canonicalSync(a) === this.canonicalSync(b);
	}
}
