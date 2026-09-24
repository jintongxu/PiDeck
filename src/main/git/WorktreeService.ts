import { execFile } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
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
 * 工作树目录统一创建在 PiDeck 的应用数据管理目录中：
 * {userData}/worktrees/{repo-key}/{slug}，避免影响项目本身及项目同级目录。
 * 未注入应用数据根时（例如纯服务测试）回退到仓库内 .pideck/worktrees。
 */
export class WorktreeService {
	constructor(
		private readonly translate: WorktreeCopy = () => "Worktree operation failed.",
		private readonly managedWorktreeRoot?: string,
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
	 * 以 Git 本地分支为事实源补齐 linked worktree，并把历史上已创建但没有 ref 的
	 * 空仓库 worktree 修复为可见分支。`main` 是主工作区保留分支，不自动创建子工作区。
	 * skipBranches 用于保护删除失败后等待重试的 PiDeck managed binding，避免扫描时把
	 * 残留分支重新创建成新的 worktree。
	 */
	async listAndEnsureBranches(
		projectPath: string,
		skipBranches: readonly string[] = [],
	): Promise<WorktreeEntry[]> {
		const skip = new Set(skipBranches);
		const initialEntries = await this.listAllOrThrow(projectPath);
		const existingBranches = new Set(
			initialEntries
				.map((entry) => entry.branch)
				.filter((branch): branch is string => branch !== "detached"),
		);

		// 旧版本的空仓库 fallback 让 branch ref 消失，但 porcelain 仍保留 symbolic HEAD；
		// 先补回一个空 bootstrap commit，后续 Git branch API 和 ProjectStore 才能对账。
		for (const entry of initialEntries) {
			if (entry.branch === "detached" || entry.branch === "main" || skip.has(entry.branch)) continue;
			if (!(await this.hasLocalBranch(projectPath, entry.branch))) {
				await this.materializeEmptyBranch(projectPath, entry.branch);
			}
		}

		const localBranches = await this.listLocalBranches(projectPath);
		for (const branch of localBranches) {
			if (branch === "main" || skip.has(branch) || existingBranches.has(branch)) continue;
			await this.create(projectPath, "", branch, true);
			existingBranches.add(branch);
		}

		return (await this.listOrThrow(projectPath)).filter((entry) => entry.branch !== "main");
	}

	/**
	 * 基于当前 HEAD 创建新的 worktree。
	 * 常规仓库使用 OpenCode 的方式：--no-checkout 创建后再 reset --hard 填充；
	 * 尚无首个提交的仓库没有可解析的 HEAD，必须创建独立的 orphan worktree。
	 */
	async create(
		projectPath: string,
		projectId: string,
		branchName: string,
		exactBranchName = false,
	): Promise<{ path: string; branch: string }> {
		const baseSlug = exactBranchName ? branchName : worktreeSlugify(branchName);
		// 所有 PiDeck worktree 统一放在应用数据目录，并按 Git 仓库身份分桶：
		// 不同项目可以使用同名分支，也不会在项目同级目录产生“1”等普通文件夹。
		const mainWorktree = await this.getMainWorktreeOrThrow(projectPath);
		const parentDir = this.getManagedWorktreeRoot(mainWorktree);
		mkdirSync(parentDir, { recursive: true });
		if (!this.managedWorktreeRoot) await this.ensureWorktreeRootIgnored(mainWorktree);

		const { worktreeDir, branch, createBranch } = await this.allocateWorktreeTarget(
			projectPath,
			parentDir,
			baseSlug,
			exactBranchName ? branchName : undefined,
		);
		let createOrphan: boolean;
		try {
			createOrphan = createBranch && !(await this.hasHeadCommit(projectPath));
		} catch (error) {
			console.error("[WorktreeService] git HEAD probe failed", error);
			throw new Error(this.translate("mainWorktree.createFailed"));
		}

		// 同名分支若是旧版删除遗留、且未被任何 worktree 使用，则直接复用；新名称才用 -b 创建。
		// 空仓库的兼容路径使用 Git 2.41 也支持的 plumbing，避免依赖 2.42 才加入的 --orphan。
		try {
			if (createOrphan) {
				await this.createEmptyWorktree(projectPath, worktreeDir, branch);
			} else {
				await execFileAsync(
					currentGitExecutable(),
					createBranch
						? ["worktree", "add", "--no-checkout", "-b", branch, worktreeDir]
						: ["worktree", "add", "--no-checkout", worktreeDir, branch],
					{ cwd: projectPath },
				);
			}
		} catch (error) {
			console.error("[WorktreeService] git worktree add failed", error);
			if (error instanceof WorktreeCreateCleanupError) throw error;
			throw new Error(this.translate("mainWorktree.createFailed"));
		}

		if (!createOrphan) {
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

	/** 检查 HEAD 是否已指向提交；退出码 1 仅表示仓库仍处于 unborn 状态。 */
	private async hasHeadCommit(projectPath: string): Promise<boolean> {
		try {
			await execFileAsync(
				currentGitExecutable(),
				["rev-parse", "--verify", "--quiet", "HEAD^{commit}"],
				{ cwd: projectPath },
			);
			return true;
		} catch (error) {
			if (
				typeof error === "object" &&
				error !== null &&
				"code" in error &&
				error.code === 1
			) return false;
			throw error;
		}
	}

	/** 查询本地 branch ref 是否仍存在，供扫描清理 stale ProjectStore binding。 */
	async hasBranch(projectPath: string, branch: string): Promise<boolean> {
		return this.hasLocalBranch(projectPath, branch);
	}

	/** 列出共享仓库中的本地分支，严格区分查询失败和“没有该分支”。 */
	private async listLocalBranches(projectPath: string): Promise<string[]> {
		const { stdout } = await execFileAsync(
			currentGitExecutable(),
			["for-each-ref", "--format=%(refname:short)", "refs/heads"],
			{ cwd: projectPath },
		);
		return stdout.split(/\r?\n/).map((branch) => branch.trim()).filter(Boolean);
	}

	private async hasLocalBranch(projectPath: string, branch: string): Promise<boolean> {
		try {
			await execFileAsync(
				currentGitExecutable(),
				["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
				{ cwd: projectPath },
			);
			return true;
		} catch (error) {
			if (
				typeof error === "object" &&
				error !== null &&
				"code" in error &&
				error.code === 1
			) return false;
			throw error;
		}
	}

	/** 为旧版真正 unborn worktree 生成并保留一个可见的空 bootstrap commit。 */
	private async materializeEmptyBranch(projectPath: string, branch: string): Promise<void> {
		const temporaryDir = mkdtempSync(join(tmpdir(), "pideck-worktree-bootstrap-"));
		const emptyTreeFile = join(temporaryDir, "empty-tree");
		const messageFile = join(temporaryDir, "anchor-message");
		try {
			writeFileSync(emptyTreeFile, "", "utf8");
			writeFileSync(messageFile, `PiDeck migrated empty worktree anchor ${randomUUID()}\n`, "utf8");
			const { stdout: treeOutput } = await execFileAsync(
				currentGitExecutable(),
				["hash-object", "-w", "-t", "tree", emptyTreeFile],
				{ cwd: projectPath },
			);
			const tree = treeOutput.trim();
			const { stdout: commitOutput } = await execFileAsync(
				currentGitExecutable(),
				["commit-tree", tree, "-F", messageFile],
				{
					cwd: projectPath,
					env: {
						...process.env,
						GIT_AUTHOR_NAME: "PiDeck",
						GIT_AUTHOR_EMAIL: "pideck@localhost",
						GIT_COMMITTER_NAME: "PiDeck",
						GIT_COMMITTER_EMAIL: "pideck@localhost",
					},
				},
			);
			const anchor = commitOutput.trim();
			if (!tree || !anchor) throw new Error("Git returned an empty empty-worktree anchor");
			await execFileAsync(
				currentGitExecutable(),
				["update-ref", `refs/heads/${branch}`, anchor, ""],
				{ cwd: projectPath },
			);
		} finally {
			try {
				rmSync(temporaryDir, { recursive: true, force: true });
			} catch (cleanupError) {
				console.warn("[WorktreeService] bootstrap migration temp cleanup failed", cleanupError);
			}
		}
	}

	/**
	 * 在没有首个提交的仓库中创建带可见 Git 分支的 linked worktree。
	 *
	 * Git 2.42 才提供 `worktree add --orphan`，而真正的 unborn 分支没有
	 * `refs/heads/<branch>`，Git 分支列表也无法显示它。这里创建一个只含空树的
	 * bootstrap commit 并保留目标 ref：主工作区仍保持 unborn，新工作区和 Git
	 * 分支列表则能稳定地一一对应；用户首次提交时会自然地从这个空提交继续。
	 */
	private async createEmptyWorktree(
		projectPath: string,
		worktreeDir: string,
		branch: string,
	): Promise<void> {
		const temporaryDir = mkdtempSync(join(tmpdir(), "pideck-worktree-bootstrap-"));
		const emptyTreeFile = join(temporaryDir, "empty-tree");
		const messageFile = join(temporaryDir, "anchor-message");
		const ref = `refs/heads/${branch}`;
		let anchor: string | null = null;
		let worktreeAdded = false;

		try {
			writeFileSync(emptyTreeFile, "", "utf8");
			writeFileSync(messageFile, `PiDeck empty worktree anchor ${randomUUID()}\n`, "utf8");
			const { stdout: treeOutput } = await execFileAsync(
				currentGitExecutable(),
				["hash-object", "-w", "-t", "tree", emptyTreeFile],
				{ cwd: projectPath },
			);
			const tree = treeOutput.trim();
			if (!tree) throw new Error("Git returned an empty bootstrap tree object");

			const { stdout: commitOutput } = await execFileAsync(
				currentGitExecutable(),
				["commit-tree", tree, "-F", messageFile],
				{
					cwd: projectPath,
					env: {
						...process.env,
						GIT_AUTHOR_NAME: "PiDeck",
						GIT_AUTHOR_EMAIL: "pideck@localhost",
						GIT_COMMITTER_NAME: "PiDeck",
						GIT_COMMITTER_EMAIL: "pideck@localhost",
					},
				},
			);
			anchor = commitOutput.trim();
			if (!anchor) throw new Error("Git returned an empty bootstrap commit object");

			await execFileAsync(
				currentGitExecutable(),
				["-c", "core.logAllRefUpdates=false", "worktree", "add", "--no-checkout", "-b", branch, worktreeDir, anchor],
				{ cwd: projectPath },
			);
			worktreeAdded = true;
		} catch (error) {
			// `-b` 已经创建 ref 时，失败补偿必须带 anchor 条件，不能删除外部进程
			// 在竞态窗口中移动到其他提交的同名分支。
			if (anchor) {
				let cleanupError: unknown = null;
				if (worktreeAdded) {
					try {
						await execFileAsync(
							currentGitExecutable(),
							["worktree", "remove", "--force", worktreeDir],
							{ cwd: projectPath },
						);
					} catch (errorDuringRemove) {
						cleanupError = errorDuringRemove;
					}
				}
				if (!cleanupError) {
					try {
						await execFileAsync(
							currentGitExecutable(),
							["update-ref", "-d", ref, anchor],
							{ cwd: projectPath },
						);
					} catch (errorDuringRefCleanup) {
						cleanupError = errorDuringRefCleanup;
					}
				}
				if (cleanupError) {
					throw new WorktreeCreateCleanupError(
						this.translate("mainWorktree.createFailed"),
						worktreeDir,
						branch,
						{ cause: new AggregateError([error, cleanupError], "Empty worktree cleanup failed") },
					);
				}
			}
			throw error;
		} finally {
			// 临时文件只承载 commit-tree 输入；清理失败不应让已经成功的 Git 操作
			// 被错误地报告为失败，后续启动扫描仍能以 Git 状态恢复 ProjectStore。
			try {
				rmSync(temporaryDir, { recursive: true, force: true });
			} catch (cleanupError) {
				console.warn("[WorktreeService] bootstrap temp cleanup failed", cleanupError);
			}
		}
	}

	/**
	 * 生成目标目录名和分支名。
	 * 不再静默追加 -a/-b：用户输入 test 就只尝试创建 test，
	 * 若同级目录或分支已存在则明确报错，避免最终出现非用户预期的 test-a。
	 */
	private async allocateWorktreeTarget(
		projectPath: string,
		parentDir: string,
		baseSlug: string,
		branchOverride?: string,
	) {
		// exact branch 扫描保留 refs 的层级（feature/ui → .pideck/worktrees/feature/ui），
		// 避免 feature/ui 与 feature-ui 这类不同分支映射到同一目录。
		const slug = baseSlug;
		const worktreeDir = join(parentDir, ...slug.split("/"));
		const branch = branchOverride ?? slug;
		if (existsSync(worktreeDir)) {
			throw new Error(this.translate("mainWorktree.folderExists"));
		}

		// unborn 分支没有 refs/heads/<branch>，因此必须先检查所有 worktree 的 symbolic HEAD，
		// 否则在空仓库中以主分支名新建工作区会把同一分支绑定两次。
		const branchInUse = (await this.listAllOrThrow(projectPath)).some(
			(entry) => entry.branch === branch,
		);
		if (branchInUse) throw new Error(this.translate("mainWorktree.branchExists"));

		const ref = await execFileAsync(
			currentGitExecutable(),
			["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
			{ cwd: projectPath },
		)
			.then(() => true)
			.catch((error) => {
				if (
					typeof error === "object" &&
					error !== null &&
					"code" in error &&
					error.code === 1
				) return false;
				throw error;
			});
		if (ref) {
			// 兼容旧版删除只移除目录、遗留同名分支的情况：未被任何 worktree checkout 的
			// 本地分支可以安全复用；仍在主/其他 worktree 使用时已在上面明确报冲突。
			return { worktreeDir, branch, createBranch: false };
		}
		return { worktreeDir, branch, createBranch: true };
	}


	/** 返回按 Git 仓库身份隔离的工作区目录；不同项目允许使用相同分支名。 */
	private getManagedWorktreeRoot(mainWorktree: string): string {
		if (!this.managedWorktreeRoot) return join(mainWorktree, ".pideck", "worktrees");
		const repoKey = createHash("sha256")
			.update(this.canonicalSync(mainWorktree), "utf8")
			.digest("hex")
			.slice(0, 16);
		return join(this.managedWorktreeRoot, `${worktreeSlugify(basename(mainWorktree))}-${repoKey}`);
	}

	/**
	 * 将测试/兼容回退目录加入 Git 私有 exclude，避免主工作区 status
	 * 把仓库内管理目录显示为用户未跟踪文件；生产路径位于 userData，不会走这里。
	 */
	private async ensureWorktreeRootIgnored(mainWorktree: string): Promise<void> {
		const { stdout } = await execFileAsync(
			currentGitExecutable(),
			["rev-parse", "--git-path", "info/exclude"],
			{ cwd: mainWorktree },
		);
		const excludePath = resolve(mainWorktree, stdout.trim());
		const marker = ".pideck/worktrees/";
		const existing = existsSync(excludePath) ? readFileSync(excludePath, "utf8") : "";
		if (existing.split(/\r?\n/).some((line) => line.trim() === marker)) return;
		appendFileSync(excludePath, `${existing.endsWith("\n") || existing.length === 0 ? "" : "\n"}# PiDeck managed worktrees\n${marker}\n`, "utf8");
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
