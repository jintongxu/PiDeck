import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type {
	CreateProjectIdeaInput,
	ProjectIdea,
	ProjectIdeaKind,
	ProjectIdeaStatus,
	UpdateProjectIdeaInput,
} from "../../shared/types";
import { renameWithRetry } from "../utils/fsRetry";

const SCHEMA_VERSION = 1;
const MAX_TITLE_LENGTH = 200;
const MAX_BODY_LENGTH = 50_000;
const MAX_TAG_LENGTH = 40;
const MAX_TAGS = 20;
const MAX_LINKED_SESSIONS = 50;
const MAX_SOURCE_ID_LENGTH = 160;
const MAX_REFINEMENT_LIST_ITEMS = 20;
const MAX_REFINEMENT_FIELD_LENGTH = 20_000;
const STATUSES: readonly ProjectIdeaStatus[] = ["inbox", "planned", "doing", "done"];

type PersistedProjectIdeas = {
	version: number;
	ideas: ProjectIdea[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isStatus(value: unknown): value is ProjectIdeaStatus {
	return typeof value === "string" && STATUSES.some((status) => status === value);
}

function isKind(value: unknown): value is ProjectIdeaKind {
	return value === "implementation" || value === "brainstorm";
}

function isSourceKind(value: unknown): value is "message" | "selection" {
	return value === "message" || value === "selection";
}

function text(value: unknown, maxLength: number): string {
	return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function stringList(value: unknown, maxItems: number, maxLength: number): string[] {
	if (!Array.isArray(value)) return [];
	const result: string[] = [];
	for (const item of value) {
		if (typeof item !== "string") continue;
		const normalized = item.trim().slice(0, maxLength);
		if (normalized && !result.includes(normalized)) result.push(normalized);
		if (result.length >= maxItems) break;
	}
	return result;
}

function normalizeRefinement(value: unknown): ProjectIdea["refinement"] {
	if (!isRecord(value)) return undefined;
	const summary = text(value.summary, MAX_REFINEMENT_FIELD_LENGTH);
	if (!summary) return undefined;
	const generatedAt = typeof value.generatedAt === "number" && Number.isFinite(value.generatedAt)
		? value.generatedAt
		: Date.now();
	const confirmedAt = typeof value.confirmedAt === "number" && Number.isFinite(value.confirmedAt)
		? value.confirmedAt
		: undefined;
	return {
		summary,
		problem: text(value.problem, MAX_REFINEMENT_FIELD_LENGTH),
		goal: text(value.goal, MAX_REFINEMENT_FIELD_LENGTH),
		expectedOutcome: text(value.expectedOutcome, MAX_REFINEMENT_FIELD_LENGTH),
		scope: stringList(value.scope, MAX_REFINEMENT_LIST_ITEMS, MAX_REFINEMENT_FIELD_LENGTH),
		acceptanceCriteria: stringList(value.acceptanceCriteria, MAX_REFINEMENT_LIST_ITEMS, MAX_REFINEMENT_FIELD_LENGTH),
		openQuestions: stringList(value.openQuestions, MAX_REFINEMENT_LIST_ITEMS, MAX_REFINEMENT_FIELD_LENGTH),
		generatedAt,
		...(confirmedAt === undefined ? {} : { confirmedAt }),
	};
}

function cloneRefinement(refinement: NonNullable<ProjectIdea["refinement"]>) {
	return {
		...refinement,
		scope: [...refinement.scope],
		acceptanceCriteria: [...refinement.acceptanceCriteria],
		openQuestions: [...refinement.openQuestions],
	};
}

function normalizeIdea(value: unknown): ProjectIdea | null {
	if (!isRecord(value)) return null;
	const candidate = value;
	const id = text(candidate.id, 100);
	const projectId = text(candidate.projectId, 100);
	const title = text(candidate.title, MAX_TITLE_LENGTH);
	if (!id || !projectId || !title) return null;
	const createdAt = typeof candidate.createdAt === "number" && Number.isFinite(candidate.createdAt)
		? candidate.createdAt
		: Date.now();
	const updatedAt = typeof candidate.updatedAt === "number" && Number.isFinite(candidate.updatedAt)
		? candidate.updatedAt
		: createdAt;
	const completedAt = typeof candidate.completedAt === "number" && Number.isFinite(candidate.completedAt)
		? candidate.completedAt
		: undefined;
	const refinement = normalizeRefinement(candidate.refinement);
	return {
		id,
		projectId,
		title,
		body: typeof candidate.body === "string" ? candidate.body.slice(0, MAX_BODY_LENGTH) : "",
		// Existing persisted ideas predate the kind field and remain implementation ideas.
		kind: isKind(candidate.kind) ? candidate.kind : "implementation",
		...(refinement ? { refinement } : {}),
		status: isStatus(candidate.status) ? candidate.status : "inbox",
		tags: stringList(candidate.tags, MAX_TAGS, MAX_TAG_LENGTH),
		linkedSessionIds: stringList(candidate.linkedSessionIds, MAX_LINKED_SESSIONS, MAX_SOURCE_ID_LENGTH),
		...(typeof candidate.sourceSessionId === "string" && candidate.sourceSessionId.trim()
			? { sourceSessionId: candidate.sourceSessionId.trim().slice(0, MAX_SOURCE_ID_LENGTH) }
			: {}),
		...(typeof candidate.derivedFromIdeaId === "string" && candidate.derivedFromIdeaId.trim()
			? { derivedFromIdeaId: candidate.derivedFromIdeaId.trim().slice(0, MAX_SOURCE_ID_LENGTH) }
			: {}),
		...(typeof candidate.selectedPlanId === "string" && candidate.selectedPlanId.trim()
			? { selectedPlanId: candidate.selectedPlanId.trim().slice(0, MAX_SOURCE_ID_LENGTH) }
			: {}),
		...(typeof candidate.sourceMessageId === "string" && candidate.sourceMessageId.trim()
			? { sourceMessageId: candidate.sourceMessageId.trim().slice(0, MAX_SOURCE_ID_LENGTH) }
			: {}),
		...(isSourceKind(candidate.sourceKind) ? { sourceKind: candidate.sourceKind } : {}),
		createdAt,
		updatedAt,
		...(completedAt === undefined ? {} : { completedAt }),
	};
}

function cloneIdea(idea: ProjectIdea): ProjectIdea {
	return {
		...idea,
		...(idea.refinement ? { refinement: cloneRefinement(idea.refinement) } : {}),
		tags: [...idea.tags],
		linkedSessionIds: [...idea.linkedSessionIds],
	};
}

/** Owns the local project-ideas.json store; ideas never enter project folders or pi sessions. */
export class ProjectIdeaStore {
	private ideas: ProjectIdea[] = [];
	private loaded = false;
	private loadPromise: Promise<void> | null = null;
	private saveQueue: Promise<void> = Promise.resolve();

	constructor(private readonly filePath: string) {}

	async load(): Promise<void> {
		if (this.loaded) return;
		if (this.loadPromise) return this.loadPromise;
		this.loadPromise = (async () => {
			try {
				const raw = await readFile(this.filePath, "utf8");
				const parsed: unknown = JSON.parse(raw);
				let entries: unknown[];
				if (Array.isArray(parsed)) {
					entries = parsed;
				} else if (isRecord(parsed) && Array.isArray(parsed.ideas)) {
					entries = parsed.ideas;
				} else {
					throw new Error("PROJECT_IDEAS_FILE_INVALID");
				}
				this.ideas = entries
					.map(normalizeIdea)
					.filter((idea): idea is ProjectIdea => idea !== null);
				this.loaded = true;
			} catch (error) {
				const code = isRecord(error) && typeof error.code === "string" ? error.code : undefined;
				// Only a missing file means a first launch. Permission, transient I/O, and
				// malformed JSON must stop mutations rather than silently replacing user data.
				if (code === "ENOENT") {
					this.ideas = [];
					this.loaded = true;
					return;
				}
				throw error;
			} finally {
				this.loadPromise = null;
			}
		})();
		return this.loadPromise;
	}

	async list(projectId?: string): Promise<ProjectIdea[]> {
		await this.load();
		return this.ideas
			.filter((idea) => projectId === undefined || idea.projectId === projectId)
			.sort((left, right) => right.updatedAt - left.updatedAt)
			.map(cloneIdea);
	}

	async get(id: string): Promise<ProjectIdea | null> {
		await this.load();
		const idea = this.ideas.find((candidate) => candidate.id === id);
		return idea ? cloneIdea(idea) : null;
	}

	async create(input: CreateProjectIdeaInput, now = Date.now()): Promise<ProjectIdea> {
		await this.load();
		const title = text(input.title, MAX_TITLE_LENGTH);
		if (!input.projectId || !title) throw new Error("PROJECT_IDEA_TITLE_REQUIRED");
		const parentId = text(input.derivedFromIdeaId, MAX_SOURCE_ID_LENGTH) || undefined;
		if (parentId) this.validateParent(input.projectId, parentId);
		const status = isStatus(input.status) ? input.status : "inbox";
		const kind = isKind(input.kind) ? input.kind : "implementation";
		const refinement = normalizeRefinement(input.refinement);
		const idea: ProjectIdea = {
			id: randomUUID(),
			projectId: input.projectId,
			title,
			body: typeof input.body === "string" ? input.body.slice(0, MAX_BODY_LENGTH) : "",
			kind,
			...(refinement ? { refinement } : {}),
			status,
			tags: stringList(input.tags, MAX_TAGS, MAX_TAG_LENGTH),
			linkedSessionIds: stringList(input.linkedSessionIds, MAX_LINKED_SESSIONS, MAX_SOURCE_ID_LENGTH),
			...(typeof input.sourceSessionId === "string" && input.sourceSessionId.trim()
				? { sourceSessionId: input.sourceSessionId.trim().slice(0, MAX_SOURCE_ID_LENGTH) }
				: {}),
			...(parentId ? { derivedFromIdeaId: parentId } : {}),
			...(typeof input.selectedPlanId === "string" && input.selectedPlanId.trim()
				? { selectedPlanId: input.selectedPlanId.trim().slice(0, MAX_SOURCE_ID_LENGTH) }
				: {}),
			...(typeof input.sourceMessageId === "string" && input.sourceMessageId.trim()
				? { sourceMessageId: input.sourceMessageId.trim().slice(0, MAX_SOURCE_ID_LENGTH) }
				: {}),
			...(isSourceKind(input.sourceKind) ? { sourceKind: input.sourceKind } : {}),
			createdAt: now,
			updatedAt: now,
			...(status === "done" ? { completedAt: now } : {}),
		};
		this.ideas.unshift(idea);
		await this.persist();
		return cloneIdea(idea);
	}

	async update(id: string, patch: UpdateProjectIdeaInput, now = Date.now()): Promise<ProjectIdea> {
		await this.load();
		const idea = this.ideas.find((candidate) => candidate.id === id);
		if (!idea) throw new Error("PROJECT_IDEA_NOT_FOUND");
		// Validate parent changes before mutating the in-memory record or scheduling persistence.
		if (patch.derivedFromIdeaId !== undefined && patch.derivedFromIdeaId !== null) {
			const parentId = text(patch.derivedFromIdeaId, MAX_SOURCE_ID_LENGTH);
			if (parentId) this.validateParent(idea.projectId, parentId, id);
		}
		if (patch.title !== undefined) {
			const title = text(patch.title, MAX_TITLE_LENGTH);
			if (!title) throw new Error("PROJECT_IDEA_TITLE_REQUIRED");
			idea.title = title;
		}
		if (patch.body !== undefined) idea.body = typeof patch.body === "string" ? patch.body.slice(0, MAX_BODY_LENGTH) : "";
		if (patch.kind !== undefined) {
			if (!isKind(patch.kind)) throw new Error("PROJECT_IDEA_KIND_INVALID");
			idea.kind = patch.kind;
		}
		if (patch.refinement !== undefined) {
			const refinement = normalizeRefinement(patch.refinement);
			if (refinement) idea.refinement = refinement;
			else delete idea.refinement;
		}
		if (patch.status !== undefined) {
			if (!isStatus(patch.status)) throw new Error("PROJECT_IDEA_STATUS_INVALID");
			idea.status = patch.status;
			if (patch.status === "done") idea.completedAt = now;
			else delete idea.completedAt;
		}
		if (patch.tags !== undefined) idea.tags = stringList(patch.tags, MAX_TAGS, MAX_TAG_LENGTH);
		if (patch.linkedSessionIds !== undefined) idea.linkedSessionIds = stringList(patch.linkedSessionIds, MAX_LINKED_SESSIONS, MAX_SOURCE_ID_LENGTH);
		if (patch.sourceSessionId !== undefined) idea.sourceSessionId = text(patch.sourceSessionId, MAX_SOURCE_ID_LENGTH) || undefined;
		if (patch.derivedFromIdeaId !== undefined) {
			const parentId = patch.derivedFromIdeaId === null ? "" : text(patch.derivedFromIdeaId, MAX_SOURCE_ID_LENGTH);
			if (parentId) idea.derivedFromIdeaId = parentId;
			else delete idea.derivedFromIdeaId;
		}
		if (patch.selectedPlanId !== undefined) idea.selectedPlanId = text(patch.selectedPlanId, MAX_SOURCE_ID_LENGTH) || undefined;
		if (patch.sourceMessageId !== undefined) idea.sourceMessageId = text(patch.sourceMessageId, MAX_SOURCE_ID_LENGTH) || undefined;
		if (patch.sourceKind !== undefined) {
			if (patch.sourceKind === null) delete idea.sourceKind;
			else {
				if (!isSourceKind(patch.sourceKind)) throw new Error("PROJECT_IDEA_SOURCE_KIND_INVALID");
				idea.sourceKind = patch.sourceKind;
			}
		}
		idea.updatedAt = now;
		await this.persist();
		return cloneIdea(idea);
	}

	async delete(id: string): Promise<boolean> {
		await this.load();
		const before = this.ideas.length;
		this.ideas = this.ideas.filter((idea) => idea.id !== id);
		if (this.ideas.length === before) return false;
		await this.persist();
		return true;
	}

	async deleteByProjectIds(projectIds: readonly string[]): Promise<number> {
		await this.load();
		const ids = new Set(projectIds.filter((id) => typeof id === "string" && id.length > 0));
		if (ids.size === 0) return 0;
		const before = this.ideas.length;
		this.ideas = this.ideas.filter((idea) => !ids.has(idea.projectId));
		const deleted = before - this.ideas.length;
		if (deleted > 0) await this.persist();
		return deleted;
	}

	/** Ensures a parent exists in the same project and does not introduce a cycle. */
	private validateParent(projectId: string, parentId: string, childId?: string): void {
		if (childId !== undefined && parentId === childId) throw new Error("PROJECT_IDEA_PARENT_CYCLE");
		const parent = this.ideas.find((candidate) => candidate.id === parentId);
		if (!parent) throw new Error("PROJECT_IDEA_PARENT_NOT_FOUND");
		if (parent.projectId !== projectId) throw new Error("PROJECT_IDEA_PARENT_PROJECT_MISMATCH");
		const visited = new Set<string>();
		let current: ProjectIdea | undefined = parent;
		while (current?.derivedFromIdeaId) {
			if (visited.has(current.id)) throw new Error("PROJECT_IDEA_PARENT_CYCLE");
			visited.add(current.id);
			const nextId: string = current.derivedFromIdeaId;
			if (nextId === childId) throw new Error("PROJECT_IDEA_PARENT_CYCLE");
			current = this.ideas.find((candidate) => candidate.id === nextId);
		}
	}

	private async persist(): Promise<void> {
		const snapshot: PersistedProjectIdeas = {
			version: SCHEMA_VERSION,
			ideas: this.ideas.map(cloneIdea),
		};
		const operation = this.saveQueue.then(async () => {
			await mkdir(dirname(this.filePath), { recursive: true });
			const tempPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
			try {
				await writeFile(tempPath, JSON.stringify(snapshot, null, 2), "utf8");
				await renameWithRetry(tempPath, this.filePath);
			} catch (error) {
				await rm(tempPath, { force: true }).catch(() => undefined);
				throw error;
			}
		});
		// A failed write must not poison later saves; the failed operation still rejects its caller.
		this.saveQueue = operation.catch(() => undefined);
		return operation;
	}
}
