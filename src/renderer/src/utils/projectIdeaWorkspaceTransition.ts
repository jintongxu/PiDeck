export type ProjectIdeaWorkspaceRequestToken = {
	workspaceId: string;
	generation: number;
};

/** Keeps async workspace resources from committing after navigation changes scope. */
export function createProjectIdeaWorkspaceRequestGate() {
	let generation = 0;
	let currentWorkspaceId: string | null = null;
	return {
		begin(workspaceId: string): ProjectIdeaWorkspaceRequestToken {
			generation += 1;
			currentWorkspaceId = workspaceId;
			return { workspaceId, generation };
		},
		capture(workspaceId: string): ProjectIdeaWorkspaceRequestToken | null {
			return currentWorkspaceId === workspaceId ? { workspaceId, generation } : null;
		},
		invalidate(): void {
			generation += 1;
			currentWorkspaceId = null;
		},
		isCurrent(token: ProjectIdeaWorkspaceRequestToken | null): boolean {
			return Boolean(token && token.generation === generation && token.workspaceId === currentWorkspaceId);
		},
	};
}
