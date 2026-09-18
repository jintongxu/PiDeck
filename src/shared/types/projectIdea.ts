/** Lightweight project-scoped idea workflow persisted by PiDeck on the local machine. */
export type ProjectIdeaStatus = "inbox" | "planned" | "doing" | "done";
export type ProjectIdeaSourceKind = "message" | "selection";

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
	| "sourceSessionId"
	| "sourceMessageId"
	| "sourceKind"
>>;
