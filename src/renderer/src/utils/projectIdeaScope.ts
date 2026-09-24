import type { Project, ProjectIdeaViewScope } from "../../../shared/types";

/** Resolves the concrete workspaces displayed by an idea view without changing idea ownership. */
export function projectIdeaScopeWorkspaces(
	projects: readonly Project[],
	scope: ProjectIdeaViewScope | null,
): Project[] {
	if (!scope) return [];
	if (scope.kind === "workspace") {
		const workspace = projects.find((project) => project.id === scope.workspaceId);
		return workspace ? [workspace] : [];
	}
	const requested = projects.find((project) => project.id === scope.projectId);
	if (!requested) return [];
	const rootId = requested.worktreeParentId ?? requested.id;
	const root = projects.find((project) => project.id === rootId);
	if (!root) return [];
	return [root, ...projects.filter((project) => project.worktreeParentId === rootId)];
}
