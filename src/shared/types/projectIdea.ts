/** Lightweight project-scoped idea workflow persisted by PiDeck on the local machine. */
export type ProjectIdeaStatus = "inbox" | "planned" | "doing" | "done";
export type ProjectIdeaSourceKind = "message" | "selection";

/** AI-generated, user-editable clarification of an informal idea. */
export type ProjectIdeaRefinement = {
	summary: string;
	problem: string;
	goal: string;
	expectedOutcome: string;
	scope: string[];
	acceptanceCriteria: string[];
	openQuestions: string[];
	generatedAt: number;
	confirmedAt?: number;
};

export type ProjectIdeaCapture = {
	sessionId: string;
	text: string;
	messageId?: string;
	sourceKind: ProjectIdeaSourceKind;
};

export type ProjectIdea = {
	id: string;
	projectId: string;
	title: string;
	body: string;
	/** The latest AI clarification; raw body remains the source of truth for the original note. */
	refinement?: ProjectIdeaRefinement;
	status: ProjectIdeaStatus;
	tags: string[];
	linkedSessionIds: string[];
	/** Optional origin metadata; absent on ideas created before message capture was added. */
	sourceSessionId?: string;
	sourceMessageId?: string;
	sourceKind?: ProjectIdeaSourceKind;
	createdAt: number;
	updatedAt: number;
	completedAt?: number;
};

export type CreateProjectIdeaInput = {
	projectId: string;
	title: string;
	body?: string;
	refinement?: ProjectIdeaRefinement | null;
	status?: ProjectIdeaStatus;
	tags?: string[];
	linkedSessionIds?: string[];
	sourceSessionId?: string;
	sourceMessageId?: string;
	sourceKind?: ProjectIdeaSourceKind;
};

export type UpdateProjectIdeaInput = Partial<Pick<
	ProjectIdea,
	| "title"
	| "body"
	| "status"
	| "tags"
	| "linkedSessionIds"
>> & {
	refinement?: ProjectIdeaRefinement | null;
	sourceSessionId?: string | null;
	sourceMessageId?: string | null;
	sourceKind?: ProjectIdeaSourceKind | null;
};
