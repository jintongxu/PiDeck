import { atom } from "jotai";
import type { ProjectIdea, ProjectIdeaSourceKind, ProjectIdeaViewScope } from "../../../shared/types";

export type ProjectIdeaPrefill = {
	projectId: string;
	title: string;
	body: string;
	sessionId?: string;
	messageId?: string;
	sourceKind?: ProjectIdeaSourceKind;
};

export const projectIdeasByProjectAtom = atom<Record<string, ProjectIdea[]>>({});
export const projectIdeasModalScopeAtom = atom<ProjectIdeaViewScope | null>(null);
/** Compatibility selector for the existing workspace editor modal. */
export const projectIdeasModalProjectIdAtom = atom((get) => {
	const scope = get(projectIdeasModalScopeAtom);
	return scope?.kind === "workspace" ? scope.workspaceId : null;
});
export const projectIdeasModalOpenAtom = atom(false);
export const projectIdeasPrefillAtom = atom<ProjectIdeaPrefill | null>(null);

export type OpenProjectIdeasInput = string | ProjectIdeaViewScope;

export const openProjectIdeasModalAtom = atom(
	null,
	(_get, set, input: OpenProjectIdeasInput, prefill?: Omit<ProjectIdeaPrefill, "projectId">) => {
		// String callers are session/message capture paths and remain workspace-scoped.
		const scope: ProjectIdeaViewScope = typeof input === "string"
			? { kind: "workspace", workspaceId: input }
			: input;
		const workspaceId = scope.kind === "workspace" ? scope.workspaceId : undefined;
		set(projectIdeasModalScopeAtom, scope);
		set(projectIdeasPrefillAtom, prefill && workspaceId ? { projectId: workspaceId, ...prefill } : null);
		set(projectIdeasModalOpenAtom, true);
	},
);

export const closeProjectIdeasModalAtom = atom(null, (_get, set) => {
	set(projectIdeasModalOpenAtom, false);
	set(projectIdeasPrefillAtom, null);
});
