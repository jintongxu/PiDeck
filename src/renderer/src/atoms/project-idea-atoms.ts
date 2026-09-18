import { atom } from "jotai";
import type { ProjectIdea, ProjectIdeaSourceKind } from "../../../shared/types";

export type ProjectIdeaPrefill = {
	projectId: string;
	title: string;
	body: string;
	sessionId?: string;
	messageId?: string;
	sourceKind?: ProjectIdeaSourceKind;
};

export const projectIdeasByProjectAtom = atom<Record<string, ProjectIdea[]>>({});
export const projectIdeasModalProjectIdAtom = atom<string | null>(null);
export const projectIdeasModalOpenAtom = atom(false);
export const projectIdeasPrefillAtom = atom<ProjectIdeaPrefill | null>(null);

export const openProjectIdeasModalAtom = atom(
	null,
	(_get, set, projectId: string, prefill?: Omit<ProjectIdeaPrefill, "projectId">) => {
		set(projectIdeasModalProjectIdAtom, projectId);
		set(projectIdeasPrefillAtom, prefill ? { projectId, ...prefill } : null);
		set(projectIdeasModalOpenAtom, true);
	},
);

export const closeProjectIdeasModalAtom = atom(null, (_get, set) => {
	set(projectIdeasModalOpenAtom, false);
	set(projectIdeasPrefillAtom, null);
});
