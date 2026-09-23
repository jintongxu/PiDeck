/** Lightweight project-scoped idea workflow persisted by PiDeck on the local machine. */
export type ProjectIdeaStatus = "inbox" | "planned" | "doing" | "done";
/** Determines whether a project idea may enter implementation or discussion only. */
export type ProjectIdeaKind = "implementation" | "brainstorm";
export type ProjectIdeaSourceKind = "message" | "selection";

/** A structured option extracted from a complete brainstorm session. */
export type ProjectIdeaPlan = {
	id: string;
	title: string;
	summary: string;
	goal: string;
	scope: string[];
	advantages: string[];
	disadvantages: string[];
	risks: string[];
	openQuestions: string[];
};

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
	/** Legacy records without a kind are normalized to implementation by the store. */
	kind: ProjectIdeaKind;
	/** The latest AI clarification; raw body remains the source of truth for the original note. */
	refinement?: ProjectIdeaRefinement;
	status: ProjectIdeaStatus;
	tags: string[];
	linkedSessionIds: string[];
	/** Optional origin metadata; absent on ideas created before message capture was added. */
	sourceSessionId?: string;
	/** Source brainstorm idea and selected plan when this implementation idea was adopted. */
	derivedFromIdeaId?: string;
	selectedPlanId?: string;
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
	kind?: ProjectIdeaKind;
	refinement?: ProjectIdeaRefinement | null;
	status?: ProjectIdeaStatus;
	tags?: string[];
	linkedSessionIds?: string[];
	sourceSessionId?: string;
	derivedFromIdeaId?: string;
	selectedPlanId?: string;
	sourceMessageId?: string;
	sourceKind?: ProjectIdeaSourceKind;
};

export type UpdateProjectIdeaInput = Partial<Pick<
	ProjectIdea,
	| "title"
	| "body"
	| "kind"
	| "status"
	| "tags"
	| "linkedSessionIds"
>> & {
	refinement?: ProjectIdeaRefinement | null;
	derivedFromIdeaId?: string | null;
	selectedPlanId?: string | null;
	sourceSessionId?: string | null;
	sourceMessageId?: string | null;
	sourceKind?: ProjectIdeaSourceKind | null;
};
