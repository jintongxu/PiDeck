import { dialog, ipcMain, type BrowserWindow } from "electron";
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { ipcChannels } from "../../shared/ipc";
import type {
	CreateProjectIdeaInput,
	FeedbackProjectContext,
	ProjectIdeaStatus,
	UpdateProjectIdeaInput,
} from "../../shared/types";
import type { ProjectStore } from "../projects/ProjectStore";
import type { ProjectIdeaStore } from "../projects/ProjectIdeaStore";
import type { SettingsStore } from "../settings/SettingsStore";
import type { GitService } from "../git/GitService";
import type { WorktreeService } from "../git/WorktreeService";
import type { AgentManager } from "../pi/AgentManager";
import type { AppLogger } from "../logging/AppLogger";
import type { ProjectResourceManager } from "../projects/ProjectResourceManager";
import type { SessionCatalog } from "../sessions/SessionCatalog";
import { attachProjectPresence } from "../projects/projectPresence";
import { registerProjectResourceIpc } from "./projectResourceIpc";
import {
	normalizeSelectedWslProjectPath,
	toWindowsHostPath,
	type WslEnvironment,
} from "../wsl/WslPaths";
import { uploadImageToPicGo } from "../projects/picgoUpload";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isProjectIdeaStatus(value: unknown): value is ProjectIdeaStatus {
	return value === "inbox" || value === "planned" || value === "doing" || value === "done";
}

function isProjectIdeaSourceKind(value: unknown): value is "message" | "selection" {
	return value === "message" || value === "selection";
}

function parseStringArray(value: unknown, field: string): string[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
		throw new Error(`INVALID_PROJECT_IDEA_${field.toUpperCase()}`);
	}
	return value.filter((item): item is string => typeof item === "string");
}

function parseCreateProjectIdea(value: unknown): CreateProjectIdeaInput {
	if (!isRecord(value) || typeof value.projectId !== "string" || typeof value.title !== "string") {
		throw new Error("INVALID_PROJECT_IDEA");
	}
	if (value.status !== undefined && !isProjectIdeaStatus(value.status)) throw new Error("PROJECT_IDEA_STATUS_INVALID");
	if (value.sourceKind !== undefined && !isProjectIdeaSourceKind(value.sourceKind)) throw new Error("PROJECT_IDEA_SOURCE_KIND_INVALID");
	if (value.sourceMessageId !== undefined && value.sourceSessionId === undefined) {
		throw new Error("PROJECT_IDEA_SOURCE_SESSION_REQUIRED");
	}
	return {
		projectId: value.projectId,
		title: value.title,
		body: value.body === undefined ? undefined : typeof value.body === "string" ? value.body : (() => { throw new Error("INVALID_PROJECT_IDEA_BODY"); })(),
		status: value.status,
		tags: parseStringArray(value.tags, "tags"),
		linkedSessionIds: parseStringArray(value.linkedSessionIds, "linked_session_ids"),
		sourceSessionId: value.sourceSessionId === undefined ? undefined : typeof value.sourceSessionId === "string" ? value.sourceSessionId : (() => { throw new Error("INVALID_PROJECT_IDEA_SOURCE_SESSION"); })(),
		sourceMessageId: value.sourceMessageId === undefined ? undefined : typeof value.sourceMessageId === "string" ? value.sourceMessageId : (() => { throw new Error("INVALID_PROJECT_IDEA_SOURCE_MESSAGE"); })(),
		sourceKind: value.sourceKind,
	};
}

function parseUpdateProjectIdea(value: unknown): UpdateProjectIdeaInput {
	if (!isRecord(value)) throw new Error("INVALID_PROJECT_IDEA");
	const patch: UpdateProjectIdeaInput = {};
	if ("title" in value) {
		if (typeof value.title !== "string") throw new Error("INVALID_PROJECT_IDEA_TITLE");
		patch.title = value.title;
	}
	if ("body" in value) {
		if (typeof value.body !== "string") throw new Error("INVALID_PROJECT_IDEA_BODY");
		patch.body = value.body;
	}
	if ("status" in value) {
		if (!isProjectIdeaStatus(value.status)) throw new Error("PROJECT_IDEA_STATUS_INVALID");
		patch.status = value.status;
	}
	if ("tags" in value) patch.tags = parseStringArray(value.tags, "tags");
	if ("linkedSessionIds" in value) patch.linkedSessionIds = parseStringArray(value.linkedSessionIds, "linked_session_ids");
	if ("sourceSessionId" in value) {
		if (typeof value.sourceSessionId !== "string") throw new Error("INVALID_PROJECT_IDEA_SOURCE_SESSION");
		patch.sourceSessionId = value.sourceSessionId;
	}
	if ("sourceMessageId" in value) {
		if (typeof value.sourceMessageId !== "string") throw new Error("INVALID_PROJECT_IDEA_SOURCE_MESSAGE");
		patch.sourceMessageId = value.sourceMessageId;
		if (!("sourceSessionId" in value)) throw new Error("PROJECT_IDEA_SOURCE_SESSION_REQUIRED");
	}
	if ("sourceKind" in value) {
		if (!isProjectIdeaSourceKind(value.sourceKind)) throw new Error("PROJECT_IDEA_SOURCE_KIND_INVALID");
		patch.sourceKind = value.sourceKind;
	}
	return patch;
}

export type ProjectsIpcDeps = {
	projectStore: ProjectStore;
	projectIdeaStore: ProjectIdeaStore;
	settingsStore: SettingsStore;
	gitService: GitService;
	worktreeService: WorktreeService;
	agentManager: AgentManager;
	appLogger: AppLogger;
	projectResourceManager: ProjectResourceManager;
	sessionCatalog?: SessionCatalog;
	mainCopy: (key: string, params?: Record<string, string | number>) => string;
	getMainWindow: () => BrowserWindow | null;
	/** 添加 WSL 项目前解析当前发行版/用户；缺失时 chooseAndAdd 会拒绝（#155）。 */
	resolveWslEnvironment?: (distro: string, user: string) => Promise<WslEnvironment>;
};

export function registerProjectsIpc({
	projectStore,
	projectIdeaStore,
	settingsStore,
	gitService,
	worktreeService,
	agentManager,
	appLogger,
	projectResourceManager,
	sessionCatalog,
	mainCopy,
	getMainWindow,
	resolveWslEnvironment,
}: ProjectsIpcDeps): void {
	// Windows Node 只能 stat/打开主机路径；WSL 项目在 store 里可能是 Linux 路径。
	const resolveProjectHostPath = (project: { path: string; environment?: string }) => {
		const settings = settingsStore.get();
		if (
			process.platform !== "win32" ||
			project.environment !== "wsl" ||
			!settings.wslEnabled ||
			!settings.wslDistro
		) {
			return project.path;
		}
		try {
			return toWindowsHostPath(project.path, { distro: settings.wslDistro });
		} catch {
			// Presence / git 探测不应把临时 WSL 不可用升级成 IPC 硬失败。
			return project.path;
		}
	};

	const resolveProjectStoredPath = (path: string, project: { environment?: string }) => {
		const settings = settingsStore.get();
		if (
			process.platform !== "win32" ||
			project.environment !== "wsl" ||
			!settings.wslEnabled ||
			!settings.wslDistro
		) {
			return path;
		}
		try {
			return normalizeSelectedWslProjectPath(path, { distro: settings.wslDistro });
		} catch {
			return path;
		}
	};

	// 可见项目 = 按环境过滤 + 目录存在性标记（missing 保留记录，见 projectPresence.ts）
	const getVisibleProjects = async () => {
		const settings = settingsStore.get();
		const all = projectStore.list();
		const visible = settings.wslEnabled
			? all.filter((p) => p.kind === "chat" || p.environment === "wsl")
			: all.filter((p) => p.kind === "chat" || !p.environment || p.environment === "windows");
		return attachProjectPresence(visible, undefined, resolveProjectHostPath);
	};

	ipcMain.handle(ipcChannels.projectsList, async () => getVisibleProjects());
	ipcMain.handle(ipcChannels.projectsAdd, async () => {
		const settings = settingsStore.get();
		const env = settings.wslEnabled ? "wsl" as const : "windows" as const;
		// #155：WSL 模式下必须带上当前发行版环境，否则 chooseAndAdd 直接抛 INVALID_WSL_PATH。
		const wslEnvironment = env === "wsl" && settings.wslDistro && settings.wslUser && resolveWslEnvironment
			? await resolveWslEnvironment(settings.wslDistro, settings.wslUser)
			: null;
		const project = await projectStore.chooseAndAdd(env, wslEnvironment);
		void appLogger.info("project", "Project added", { projectId: project?.id, path: project?.path, environment: env });
		return project;
	});
	// 文件夹右键菜单（--open-project）直达：给定路径必须是已存在的目录，
	// 校验通过后直接入库（与选择框添加同一 add 链路：同路径去重/聊天目录特判）。
	ipcMain.handle(ipcChannels.projectsAddByPath, async (_event, path: unknown) => {
		if (typeof path !== "string" || path.trim().length === 0) {
			throw new Error("INVALID_PROJECT_PATH");
		}
		const stats = await stat(path).catch(() => null);
		if (!stats || !stats.isDirectory()) {
			throw new Error("INVALID_PROJECT_PATH");
		}
		const project = await projectStore.add(path.trim());
		void appLogger.info("project", "Project added via explorer context menu", { projectId: project.id, path: project.path });
		// 与重命名/删除一致：入库后广播可见项目清单，侧栏（含 LAN Web 端）立即刷新，否则新增项目不显示。
		const visible = await getVisibleProjects();
		getMainWindow()?.webContents.send(ipcChannels.projectsChanged, visible);
		return project;
	});
	ipcMain.handle(ipcChannels.projectsRemove, async (_event, id: string) => {
		// 删除前拦截：项目仍有运行中的 Agent（pi 子进程）时禁止删除，避免进程悬挂后台继续占用资源。
		if (agentManager.hasAgentForProject(id)) {
			throw new Error("PROJECT_HAS_RUNNING_AGENT");
		}
		const removed = projectStore.get(id);
		const childIds = removed
			? projectStore.listWorktreeChildren(removed.id).map((child) => child.id)
			: [];
		await projectStore.remove(id);
		await projectIdeaStore.deleteByProjectIds([id, ...childIds]);
		// 侧栏项目删了，catalog 映射也必须走：否则启动 DSH 自动导入按 cwd 再把项目/会话加回来。
		if (sessionCatalog) {
			for (const projectId of [id, ...childIds]) {
				await sessionCatalog.removeByProjectId(projectId).catch(() => 0);
			}
		}
		void appLogger.info("project", "Project removed", { projectId: id, path: removed?.path });
		return getVisibleProjects();
	});
	ipcMain.handle(
		ipcChannels.projectsReorder,
		async (_event, projectIds: unknown) => {
			if (!Array.isArray(projectIds) || projectIds.some((id) => typeof id !== "string" || !id.trim())) {
				throw new Error("INVALID_PROJECT_ORDER");
			}
			await projectStore.reorder(projectIds);
			void appLogger.info("project", "Projects reordered", { count: projectIds.length });
			return getVisibleProjects();
		},
	);

	// 重命名项目显示名：仅改 label 不动磁盘目录。聊天项目 / worktree 子项目由
	// ProjectStore.rename 拒绝（PROJECT_RENAME_NOT_ALLOWED）。广播 + 返回全量列表，
	// 让其他渲染实例（LAN Web）与当前窗口都拿到最新 name。
	ipcMain.handle(
		ipcChannels.projectsRename,
		async (_event, id: unknown, name: unknown) => {
			if (typeof id !== "string" || !id) throw new Error("invalid projectId");
			if (typeof name !== "string") throw new Error("invalid name");
			const project = await projectStore.rename(id, name);
			if (!project) throw new Error(`Project not found: ${id}`);
			const visible = await getVisibleProjects();
			getMainWindow()?.webContents.send(ipcChannels.projectsChanged, visible);
			void appLogger.info("project", "Project renamed", { projectId: id, name: project.name });
			return visible;
		},
	);

	// ── 项目想法（仅存 userData，不写项目目录） ──
	ipcMain.handle(ipcChannels.projectIdeasList, async (_event, projectId: unknown) => {
		if (typeof projectId !== "string" || !projectId) throw new Error("INVALID_PROJECT_ID");
		if (!projectStore.get(projectId)) throw new Error("PROJECT_NOT_FOUND");
		return projectIdeaStore.list(projectId);
	});
	const assertIdeaProject = (projectId: unknown) => {
		if (typeof projectId !== "string" || !projectId || !projectStore.get(projectId)) {
			throw new Error("PROJECT_NOT_FOUND");
		}
		return projectId;
	};
	const assertSourceSessionProject = (sourceSessionId: string | undefined, projectId: string) => {
		if (!sourceSessionId) return;
		if (!sessionCatalog) throw new Error("PROJECT_IDEA_SOURCE_SESSION_UNAVAILABLE");
		const sourceSession = sessionCatalog.get(sourceSessionId);
		if (!sourceSession || sourceSession.projectId !== projectId) {
			throw new Error("PROJECT_IDEA_SOURCE_SESSION_INVALID");
		}
	};

	ipcMain.handle(ipcChannels.projectIdeasCreate, async (_event, input: unknown) => {
		const parsed = parseCreateProjectIdea(input);
		assertIdeaProject(parsed.projectId);
		if (!parsed.title.trim()) throw new Error("PROJECT_IDEA_TITLE_REQUIRED");
		assertSourceSessionProject(parsed.sourceSessionId, parsed.projectId);
		return projectIdeaStore.create(parsed);
	});
	ipcMain.handle(ipcChannels.projectIdeasUpdate, async (_event, id: unknown, projectId: unknown, patch: unknown) => {
		if (typeof id !== "string" || !id) throw new Error("INVALID_PROJECT_IDEA");
		const ownerProjectId = assertIdeaProject(projectId);
		const existing = await projectIdeaStore.get(id);
		if (!existing) throw new Error("PROJECT_IDEA_NOT_FOUND");
		if (existing.projectId !== ownerProjectId) throw new Error("PROJECT_IDEA_PROJECT_MISMATCH");
		const parsedPatch = parseUpdateProjectIdea(patch);
		const sourceSessionId = parsedPatch.sourceSessionId ?? existing.sourceSessionId;
		assertSourceSessionProject(sourceSessionId, ownerProjectId);
		return projectIdeaStore.update(id, parsedPatch);
	});
	ipcMain.handle(ipcChannels.projectIdeasDelete, async (_event, id: unknown, projectId: unknown) => {
		if (typeof id !== "string" || !id) throw new Error("INVALID_PROJECT_IDEA");
		const ownerProjectId = assertIdeaProject(projectId);
		const existing = await projectIdeaStore.get(id);
		if (!existing) throw new Error("PROJECT_IDEA_NOT_FOUND");
		if (existing.projectId !== ownerProjectId) throw new Error("PROJECT_IDEA_PROJECT_MISMATCH");
		return projectIdeaStore.delete(id);
	});
	ipcMain.handle(ipcChannels.projectIdeasUploadImage, async (_event, dataUrl: unknown) => {
		if (typeof dataUrl !== "string") throw new Error("PICGO_IMAGE_INVALID");
		return uploadImageToPicGo(dataUrl);
	});

	// ── Worktree 项目管理 ──

	ipcMain.handle(ipcChannels.projectsListRoot, () => {
		return projectStore.listRoot();
	});

	ipcMain.handle(
		ipcChannels.projectsListWorktreeChildren,
		async (_event, parentId: string) => {
			return projectStore.listWorktreeChildren(parentId);
		},
	);

	ipcMain.handle(
		ipcChannels.projectsToggleWorktreeEnabled,
		async (_event, projectId: string) => {
			const existing = projectStore.get(projectId);
			if (!existing) throw new Error(`Project not found: ${projectId}`);
			// 即将启用时先校验是否 git 仓库；非 git 项目开启工作区模式没有意义，
			// 只会看到空列表并在创建时报错，这里提前给出明确错误让前端提示用户。
			if (!existing.worktreeEnabled) {
				const isRepo = await gitService.isGitRepo(resolveProjectHostPath(existing));
				if (!isRepo) {
					throw new Error("NOT_A_GIT_REPO");
				}
			}
			const project = await projectStore.toggleWorktreeEnabled(projectId);
			if (!project) throw new Error(`Project not found: ${projectId}`);
			// 开启 worktree 模式时，自动注册已有的 git worktree
			if (project.worktreeEnabled) {
				try {
					const entries = await worktreeService.list(resolveProjectHostPath(project));
					for (const wt of entries) {
						// findByPath 必须用 store 里的 Linux/规范化路径，不能拿 git 返回的 UNC。
						const storedPath = resolveProjectStoredPath(wt.path, project);
						if (!projectStore.findByPath(storedPath)) {
							await projectStore.add(storedPath, projectId, project.environment);
						}
					}
				} catch {
					// worktree 查询失败不阻塞 toggle
				}
			}
			return project;
		},
	);

	// ── 聊天项目目录设置 ──

	ipcMain.handle(ipcChannels.projectsChooseChatPath, async () => {
		// 系统文件选择器，默认定位到当前聊天目录，便于用户就地切换。
		const result = await dialog.showOpenDialog({
			title: mainCopy("dialog.chooseChatHistoryFolder"),
			defaultPath: projectStore.getChatProjectPath(),
			properties: ["openDirectory"],
		});
		if (result.canceled || result.filePaths.length === 0) return null;
		return result.filePaths[0];
	});

	ipcMain.handle(
		ipcChannels.projectsSetChatPath,
		async (_event, path: string) => {
			if (typeof path !== "string" || path.length === 0) throw new Error("Invalid chat path");
			const project = await projectStore.setChatProjectPath(path);
			// 路径变更后广播项目列表变化，渲染端据此刷新聊天项目的会话。
			const mainWindow = getMainWindow();
			mainWindow?.webContents.send(ipcChannels.projectsChanged, await getVisibleProjects());
			void appLogger.info("project", "Chat project path updated", { path });
			return project;
		},
	);

	registerProjectResourceIpc({
		appLogger,
		projectResourceManager,
	});

	// ── 问题反馈「新建会话分析」的项目上下文 ──
	// 读取项目根 AGENTS.md（大小截断）与项目级技能目录名，供 AI 提示词携带工程规范。
	// 只读文件内容，不写任何数据；路径来自 projectStore（用户已信任的项目），无需再次弹信任。

	const FEEDBACK_AGENTS_MD_MAX_CHARS = 14_000;
	ipcMain.handle(
		ipcChannels.appFeedbackProjectContext,
		async (_event, projectId: unknown): Promise<FeedbackProjectContext> => {
			if (typeof projectId !== "string" || !projectId) {
				throw new Error("invalid projectId");
			}
			const project = projectStore.get(projectId);
			if (!project) throw new Error(`Project not found: ${projectId}`);
			const hostPath = resolveProjectHostPath(project);
			// AGENTS.md 缺失时返回空串而非报错：不是所有项目都写了规范文件
			let agentsMd = "";
			try {
				agentsMd = await readFile(join(hostPath, "AGENTS.md"), "utf8");
			} catch {
				agentsMd = "";
			}
			const agentsMdTruncated = agentsMd.length > FEEDBACK_AGENTS_MD_MAX_CHARS;
			if (agentsMdTruncated) {
				// 在字符上限处往前截到行尾，避免提示词里出现半截代码行
				const capped = agentsMd.slice(0, FEEDBACK_AGENTS_MD_MAX_CHARS);
				const lastBreak = capped.lastIndexOf("\n");
				agentsMd = lastBreak > 0 ? capped.slice(0, lastBreak) : capped;
			}
			// 项目级技能：.pi/agent/skills 与 .agents/skills 下的子目录名（读取失败视为无技能）
			const skillNames = new Set<string>();
			for (const skillsDir of [".pi/agent/skills", ".agents/skills"]) {
				try {
					const entries = await readdir(join(hostPath, skillsDir), { withFileTypes: true });
					for (const entry of entries) {
						if (entry.isDirectory()) skillNames.add(entry.name);
					}
				} catch {
					// 目录不存在/不可读都视为无技能，不把项目上下文拉垮
				}
			}
			return {
				projectId,
				projectName: project.name,
				agentsMd,
				agentsMdTruncated,
				skills: [...skillNames].sort(),
			};
		},
	);
}
