import type { Project, ProjectIdea, ProjectIdeaViewScope, WorktreeEntry } from "../../../shared/types";
import { projectIdeaScopeWorkspaces } from "./projectIdeaScope";

export type ProjectIdeaWorkspaceLoad = {
	workspaceId: string;
	ideas?: ProjectIdea[];
	error?: string;
};

/** Project overview is an active-work view: completed ideas are hidden entirely. */
export function projectIdeaOverviewIdeas(ideas: readonly ProjectIdea[]): ProjectIdea[] {
	return ideas.filter((idea) => idea.status !== "done");
}

function workspacePathKey(path: string): string {
	const raw = path.trim();
	const isUncPath = /^[\\/]{2}/.test(raw);
	const normalized = raw.replace(/[\\/]+/g, "/").replace(/\/$/, "") || "/";
	return /^[A-Za-z]:\//.test(normalized) || isUncPath ? normalized.toLowerCase() : normalized;
}

/**
 * Refreshes registered worktree projects before building the aggregate. Git discovery
 * owns registration, while ideas continue to use the resulting stable Project IDs.
 */
export async function synchronizeProjectIdeaWorkspaces(
	projects: readonly Project[],
	scope: ProjectIdeaViewScope,
	dependencies: {
		listProjects: () => Promise<Project[]>;
		scanWorktrees: (rootProjectId: string) => Promise<WorktreeEntry[]>;
	},
): Promise<{ projects: Project[]; workspaces: Project[] }> {
	const requested = scope.kind === "project"
		? projects.find((project) => project.id === scope.projectId)
		: undefined;
	const rootId = requested?.worktreeParentId ?? requested?.id;
	const root = rootId ? projects.find((project) => project.id === rootId) : undefined;
	let discoveredWorktrees: WorktreeEntry[] | undefined;
	let scanSucceeded = false;
	if (root?.worktreeEnabled && !root.missing && root.kind !== "chat") {
		try {
			discoveredWorktrees = await dependencies.scanWorktrees(root.id);
			scanSucceeded = true;
		} catch {
			// A Git scan failure must not hide already registered workspaces or their ideas.
		}
	}
	let refreshedProjects = [...projects];
	if (scanSucceeded) {
		// Registration happens inside the scan IPC. Its refreshed catalog is mandatory:
		// cached records cannot provide stable IDs for newly discovered worktrees.
		refreshedProjects = await dependencies.listProjects();
	} else {
		try {
			refreshedProjects = await dependencies.listProjects();
		} catch {
			// Only the degraded scan-failure/no-scan path may retain the renderer snapshot.
		}
	}
	const registeredWorkspaces = projectIdeaScopeWorkspaces(refreshedProjects, scope);
	const workspaces = discoveredWorktrees === undefined
		? registeredWorkspaces
		: [
			...(registeredWorkspaces[0] ? [registeredWorkspaces[0]] : []),
			...registeredWorkspaces.slice(1).filter((workspace) => {
				const workspacePath = workspacePathKey(workspace.path);
				return discoveredWorktrees?.some((entry) => workspacePathKey(entry.path) === workspacePath);
			}),
		];
	return { projects: refreshedProjects, workspaces };
}

/**
 * Loads every workspace independently so one missing worktree cannot turn successful
 * buckets into a misleading project-wide empty state.
 */
export async function loadProjectIdeaWorkspaces(
	workspaces: readonly Project[],
	listIdeas: (workspaceId: string) => Promise<ProjectIdea[]>,
): Promise<ProjectIdeaWorkspaceLoad[]> {
	return Promise.all(workspaces.map(async (workspace) => {
		try {
			return { workspaceId: workspace.id, ideas: await listIdeas(workspace.id) };
		} catch (reason) {
			const message = typeof reason === "object"
				&& reason !== null
				&& "message" in reason
				&& typeof reason.message === "string"
				? reason.message
				: String(reason);
			return { workspaceId: workspace.id, error: message };
		}
	}));
}
