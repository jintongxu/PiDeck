import { useCallback, useEffect, useMemo, useRef, useState, type ClipboardEvent } from "react";
import { ArrowLeft, ChevronDown, Eye, EyeOff, Lightbulb, LoaderCircle, Plus, Sparkles, Trash2 } from "lucide-react";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import type { AvailableModel, ModelListReport, ProjectIdea, ProjectIdeaKind, ProjectIdeaRefinement, ProjectIdeaStatus } from "../../../../shared/types";
import {
	closeProjectIdeasModalAtom,
	projectIdeasByProjectAtom,
	projectIdeasModalOpenAtom,
	projectIdeasPrefillAtom,
	projectIdeasModalProjectIdAtom,
	projectIdeasModalScopeAtom,
	openProjectIdeasModalAtom,
} from "../../atoms/project-idea-atoms";
import { desktopApi } from "../../desktopApi";
import { t, type TranslationKey } from "../../i18n";
import { Button } from "../ui-shadcn/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../ui-shadcn/dialog";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "../ui-shadcn/alert-dialog";
import { Input } from "../ui-shadcn/input";
import { Textarea } from "../ui-shadcn/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui-shadcn/select";
import { cn } from "../../lib/utils";
import { showNotice } from "../../utils/notice";
import { MarkdownStream } from "../session/MarkdownStream";
import { ProjectIdeaTree } from "./ProjectIdeaTree";
import { buildProjectIdeaHierarchy } from "../../utils/projectIdeaHierarchy";
import { ProjectIdeaRefinementPanel } from "./ProjectIdeaRefinementPanel";
import { ModelPicker } from "../session/ComposerComponents";
import { THINKING_LEVELS } from "../session/sessionPickerOptions";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuTrigger,
} from "../ui-shadcn/dropdown-menu";
import { useProjectIdeaRefinement } from "../../hooks/useProjectIdeaRefinement";
import { useProjectIdeaPlans } from "../../hooks/useProjectIdeaPlans";
import {
	buildProjectIdeaRefinementPrompt,
	buildProjectIdeaSessionTitle,
	formatProjectIdeaForDiscussion,
	formatProjectIdeaForExecution,
} from "../../utils/projectIdeaRefinement";
import { hasLiveLatestLinkedSession } from "../../utils/projectIdeaSessionLinks";
import { createProjectIdeaWorkspaceRequestGate } from "../../utils/projectIdeaWorkspaceTransition";

const STATUSES: readonly ProjectIdeaStatus[] = ["inbox", "planned", "doing", "done"];
const IDEA_KINDS: readonly ProjectIdeaKind[] = ["implementation", "brainstorm"];
const DEFAULT_IDEA_KIND: ProjectIdeaKind = "implementation";
const IDEA_KIND_LABEL_KEYS: Record<ProjectIdeaKind, TranslationKey> = {
	implementation: "projectIdeas.kind.implementation",
	brainstorm: "projectIdeas.kind.brainstorm",
};
const STATUS_LABEL_KEYS: Record<ProjectIdeaStatus, TranslationKey> = {
	inbox: "projectIdeas.status.inbox",
	planned: "projectIdeas.status.planned",
	doing: "projectIdeas.status.doing",
	done: "projectIdeas.status.done",
};

function statusLabel(status: ProjectIdeaStatus): string {
	return t(STATUS_LABEL_KEYS[status]);
}

function kindLabel(kind: ProjectIdeaKind): string {
	return t(IDEA_KIND_LABEL_KEYS[kind]);
}

function parseIdeaKind(value: string): ProjectIdeaKind | undefined {
	return IDEA_KINDS.find((kind) => kind === value);
}

function projectIdeaPlansError(error: string | null): string | null {
	if (!error) return null;
	if (error === "PROJECT_IDEA_PLANS_SOURCE_SESSION_EMPTY") return t("projectIdeas.plansSourceEmpty");
	if (error === "PROJECT_IDEA_PLANS_SOURCE_SESSION_BUSY") return t("projectIdeas.plansSourceBusy");
	if (error === "PROJECT_IDEA_PLANS_SOURCE_SESSION_UNAVAILABLE") return t("projectIdeas.plansSourceUnavailable");
	if (error === "PROJECT_IDEA_PLANS_RESPONSE_INVALID") return t("projectIdeas.plansInvalid");
	if (error === "PROJECT_IDEA_PLANS_TIMEOUT" || error === "PROJECT_IDEA_PLANS_RUNTIME_TIMEOUT") return t("projectIdeas.plansTimeout");
	return error;
}

function projectIdeaError(error: unknown): string {
	const code = error instanceof Error ? error.message : String(error);
	if (code === "PROJECT_IDEA_PARENT_NOT_FOUND") return t("projectIdeas.parentNotFound");
	if (code === "PROJECT_IDEA_PARENT_PROJECT_MISMATCH") return t("projectIdeas.parentProjectMismatch");
	if (code === "PROJECT_IDEA_PARENT_CYCLE") return t("projectIdeas.parentCycle");
	return code;
}

function emptyDraft() {
	return { title: "", body: "", tags: "", kind: DEFAULT_IDEA_KIND };
}

function cloneRefinement(refinement: ProjectIdeaRefinement | undefined): ProjectIdeaRefinement | undefined {
	return refinement
		? {
				...refinement,
				scope: [...refinement.scope],
				acceptanceCriteria: [...refinement.acceptanceCriteria],
				openQuestions: [...refinement.openQuestions],
			}
		: undefined;
}

/** Project-scoped lightweight idea inbox. Persistence stays behind the preload API. */
export function ProjectIdeasModal({ onContinue, onBrainstorm, onPlansStarted, onExecute, refinementModel, refinementThinkingLevel, currentSessionId, currentSessionProjectId, currentSessionContext = [], availableSessionIds = [] }: {
	onContinue?: (projectId: string, prompt: string) => void;
	onPlansStarted?: (projectId: string, sessionId: string) => void;
	onBrainstorm?: (projectId: string, prompt: string, model?: { provider: string; modelId: string }, thinkingLevel?: string) => Promise<string | null>;
	onExecute?: (
		projectId: string,
		prompt: string,
		model?: { provider: string; modelId: string },
		thinkingLevel?: string,
		sessionTitle?: string,
	) => Promise<string | null>;
	refinementModel?: { provider: string; modelId: string };
	refinementThinkingLevel?: string;
	currentSessionId?: string;
	currentSessionProjectId?: string;
	currentSessionContext?: readonly { role: string; text: string }[];
	availableSessionIds?: readonly string[];
}) {
	const [modalOpen, setOpen] = useAtom(projectIdeasModalOpenAtom);
	const scope = useAtomValue(projectIdeasModalScopeAtom);
	const open = modalOpen && scope?.kind === "workspace";
	const requestedIdeaId = scope?.kind === "workspace" ? scope.ideaId : undefined;
	const overviewProjectId = scope?.kind === "workspace" ? scope.overviewProjectId : undefined;
	const projectId = useAtomValue(projectIdeasModalProjectIdAtom);
	const prefill = useAtomValue(projectIdeasPrefillAtom);
	const close = useSetAtom(closeProjectIdeasModalAtom);
	const openProjectIdeas = useSetAtom(openProjectIdeasModalAtom);
	const [ideasByProject, setIdeasByProject] = useAtom(projectIdeasByProjectAtom);
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [filter, setFilter] = useState<ProjectIdeaStatus | "active">("active");
	const [draft, setDraft] = useState(emptyDraft);
	const [editing, setEditing] = useState(false);
	const [parentDraft, setParentDraft] = useState<ProjectIdea | null>(null);
	const [pendingDelete, setPendingDelete] = useState<ProjectIdea | null>(null);
	const [bodyPreview, setBodyPreview] = useState(false);
	const [uploadingImage, setUploadingImage] = useState(false);
	const [refinementDraft, setRefinementDraft] = useState<ProjectIdeaRefinement | undefined>();
	const [refinementOpen, setRefinementOpen] = useState(false);
	const [refinementUseContext, setRefinementUseContext] = useState(false);
	const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
	const [executingIdeaId, setExecutingIdeaId] = useState<string | null>(null);
	const [implementationModel, setImplementationModel] = useState<{ provider: string; modelId: string } | undefined>();
	const [implementationThinkingLevel, setImplementationThinkingLevel] = useState<string | undefined>();
	const [implementationThinkingConfirmed, setImplementationThinkingConfirmed] = useState(false);
	const [startingPlansSource, setStartingPlansSource] = useState(false);
	const [implementationModels, setImplementationModels] = useState<AvailableModel[]>([]);
	const [implementationModelsReport, setImplementationModelsReport] = useState<ModelListReport | null>(null);
	const [implementationModelPickerOpen, setImplementationModelPickerOpen] = useState(false);
	const bodyRef = useRef<HTMLTextAreaElement | null>(null);
	const workspaceRequestGateRef = useRef(createProjectIdeaWorkspaceRequestGate());
	const modelRequestRef = useRef(0);
	const refinement = useProjectIdeaRefinement();
	const plans = useProjectIdeaPlans();
	const ideas = projectId ? ideasByProject[projectId] ?? [] : [];
	const visibleIdeas = useMemo(() => buildProjectIdeaHierarchy(ideas, filter), [filter, ideas]);
	const selected = ideas.find((idea) => idea.id === selectedId) ?? null;
	const selectedHasLinkedSession = Boolean(selected && hasLiveLatestLinkedSession(selected.linkedSessionIds, availableSessionIds));
	const latestLinkedSessionId = selected?.linkedSessionIds.at(-1);
	const selectedCanExtractPlans = selected?.kind === "brainstorm"
		&& hasLiveLatestLinkedSession(selected.linkedSessionIds, availableSessionIds);
	const executionInFlight = executingIdeaId !== null;
	const refinementTargetKey = `${projectId ?? ""}:${selectedId ?? "new"}:${draft.kind}:${draft.title}:${draft.body}`;
	const draftRef = useRef(draft);
	const refinementDraftRef = useRef(refinementDraft);
	const refinementTargetKeyRef = useRef(refinementTargetKey);
	const selectedIdRef = useRef(selectedId);
	draftRef.current = draft;
	refinementDraftRef.current = refinementDraft;
	refinementTargetKeyRef.current = refinementTargetKey;
	selectedIdRef.current = selectedId;
	const loadRequestRef = useRef(0);

	/** A workspace transition starts with clean editor/model state and cancels private runtimes. */
	const resetWorkspaceState = useCallback(() => {
		loadRequestRef.current += 1;
		workspaceRequestGateRef.current.invalidate();
		modelRequestRef.current += 1;
		refinement.cancel();
		plans.cancel();
		setSelectedId(null);
		setFilter("active");
		setDraft(emptyDraft());
		setEditing(false);
		setParentDraft(null);
		setPendingDelete(null);
		setBodyPreview(false);
		setUploadingImage(false);
		setRefinementDraft(undefined);
		setRefinementOpen(false);
		setRefinementUseContext(false);
		setSaveState("idle");
		setExecutingIdeaId(null);
		setImplementationModel(undefined);
		setImplementationThinkingLevel(undefined);
		setImplementationThinkingConfirmed(false);
		setStartingPlansSource(false);
		setImplementationModels([]);
		setImplementationModelsReport(null);
		setImplementationModelPickerOpen(false);
	}, [plans.cancel, refinement.cancel]);

	const load = useCallback(async (id: string) => {
		const requestId = loadRequestRef.current + 1;
		loadRequestRef.current = requestId;
		const result = await desktopApi.projects.ideas.list(id);
		if (loadRequestRef.current !== requestId || projectId !== id) return;
		setIdeasByProject((current) => ({ ...current, [id]: result }));
		const requestedIdea = requestedIdeaId ? result.find((idea) => idea.id === requestedIdeaId) : undefined;
		if (requestedIdeaId) setFilter(requestedIdea?.status === "done" ? "done" : "active");
		setSelectedId((previous) => {
			if (prefill?.projectId === id) return null;
			if (requestedIdeaId) return requestedIdea?.id ?? result[0]?.id ?? null;
			return previous && result.some((idea) => idea.id === previous) ? previous : result[0]?.id ?? null;
		});
	}, [prefill?.projectId, projectId, requestedIdeaId, setIdeasByProject]);

	useEffect(() => {
		if (!open || !projectId) return;
		resetWorkspaceState();
		workspaceRequestGateRef.current.begin(projectId);
	}, [open, projectId, resetWorkspaceState]);

	useEffect(() => {
		if (!open || !projectId) return;
		if (!requestedIdeaId) setFilter("active");
		void load(projectId).catch(() => undefined);
		return () => {
			loadRequestRef.current += 1;
		};
	}, [load, open, projectId, requestedIdeaId]);

	useEffect(() => {
		if (!open || !projectId) return;
		const token = workspaceRequestGateRef.current.capture(projectId);
		const requestId = modelRequestRef.current + 1;
		modelRequestRef.current = requestId;
		void desktopApi.projects.listModelsReport(projectId, false).then((report) => {
			if (modelRequestRef.current !== requestId || !workspaceRequestGateRef.current.isCurrent(token)) return;
			setImplementationModels(report.models);
			setImplementationModelsReport(report);
		}).catch(() => undefined);
		return () => { modelRequestRef.current += 1; };
	}, [open, projectId]);

	const refreshImplementationModels = useCallback(() => {
		if (!projectId) return;
		const token = workspaceRequestGateRef.current.capture(projectId);
		const requestId = modelRequestRef.current + 1;
		modelRequestRef.current = requestId;
		void desktopApi.projects.listModelsReport(projectId, true).then((report) => {
			if (modelRequestRef.current !== requestId || !workspaceRequestGateRef.current.isCurrent(token)) return;
			setImplementationModels(report.models);
			setImplementationModelsReport(report);
		}).catch(() => undefined);
	}, [projectId]);

	useEffect(() => {
		if (!selected) return;
		setDraft({ title: selected.title, body: selected.body, tags: selected.tags.join(", "), kind: selected.kind ?? "implementation" });
		setRefinementDraft(selected.refinement);
		setRefinementOpen(Boolean(selected.refinement));
		setEditing(false);
		setBodyPreview(true);
	}, [selected]);

	useEffect(() => {
		if (!open || !projectId || !prefill || prefill.projectId !== projectId) return;
		setSelectedId(null);
		setParentDraft(null);
		setEditing(true);
		setBodyPreview(false);
		setRefinementDraft(undefined);
		setRefinementOpen(false);
		setDraft({ title: prefill.title, body: prefill.body, tags: "", kind: "implementation" });
	}, [open, prefill, projectId]);

	useEffect(() => {
		if (refinement.result && refinement.resultTargetKey === refinementTargetKey) {
			setRefinementDraft(refinement.result);
			setRefinementOpen(true);
		}
	}, [refinement.result, refinement.resultTargetKey, refinementTargetKey]);

	useEffect(() => {
		refinement.cancel();
	}, [draft.body, draft.kind, draft.title, refinement.cancel, selectedId]);

	const insertBodyAtSelection = useCallback((value: string) => {
		const textarea = bodyRef.current;
		setDraft((current) => {
			if (!textarea) return { ...current, body: `${current.body}${value}` };
			const start = textarea.selectionStart ?? current.body.length;
			const end = textarea.selectionEnd ?? start;
			return { ...current, body: `${current.body.slice(0, start)}${value}${current.body.slice(end)}` };
		});
		requestAnimationFrame(() => {
			if (!textarea) return;
			const position = (textarea.selectionStart ?? 0) + value.length;
			textarea.focus();
			textarea.setSelectionRange(position, position);
		});
	}, []);

	const dataUrlFromBlob = useCallback(async (blob: Blob): Promise<string> => {
		const bytes = new Uint8Array(await blob.arrayBuffer());
		let binary = "";
		for (let index = 0; index < bytes.length; index += 0x8000) {
			binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
		}
		return `data:${blob.type || "image/png"};base64,${btoa(binary)}`;
	}, []);

	const handleBodyPaste = useCallback(async (event: ClipboardEvent<HTMLTextAreaElement>) => {
		if (!projectId) return;
		const image = Array.from(event.clipboardData.items).find((item) => item.kind === "file" && item.type.startsWith("image/"));
		if (!image) return;
		const file = image.getAsFile();
		if (!file) return;
		const token = workspaceRequestGateRef.current.capture(projectId);
		if (!token) return;
		event.preventDefault();
		setUploadingImage(true);
		try {
			const url = await desktopApi.projects.ideas.uploadImage(await dataUrlFromBlob(file));
			if (!workspaceRequestGateRef.current.isCurrent(token)) return;
			insertBodyAtSelection(`![${file.name || "image"}](${url})`);
		} catch {
			if (workspaceRequestGateRef.current.isCurrent(token)) showNotice(t("projectIdeas.imageUploadFailed"), 4000, "error");
		} finally {
			if (workspaceRequestGateRef.current.isCurrent(token)) setUploadingImage(false);
		}
	}, [dataUrlFromBlob, insertBodyAtSelection, projectId]);

	const invalidateConfirmedRefinement = useCallback(() => {
		setRefinementDraft(undefined);
		setRefinementOpen(false);
	}, []);

	const refineIdea = useCallback(() => {
		if (!projectId || !draft.title.trim()) return;
		const context = refinementUseContext && currentSessionContext.length > 0
			? refinement.contextBuilder(currentSessionContext)
			: undefined;
		void refinement.refine({
			projectId,
			targetKey: refinementTargetKey,
			...(refinementModel ? { model: refinementModel } : {}),
			...(refinementThinkingLevel ? { thinkingLevel: refinementThinkingLevel } : {}),
			prompt: buildProjectIdeaRefinementPrompt({ title: draft.title, body: draft.body }, context ?? undefined, draft.kind),
		});
	}, [currentSessionContext, draft.body, draft.kind, draft.title, projectId, refinement, refinementModel, refinementTargetKey, refinementThinkingLevel, refinementUseContext]);

	const acceptRefinement = useCallback(async () => {
		if (!projectId || !refinementDraft?.summary.trim()) return;
		const token = workspaceRequestGateRef.current.capture(projectId);
		if (!token) return;
		const confirmed = { ...refinementDraft, confirmedAt: Date.now() };
		try {
			if (selected) {
				const updated = await desktopApi.projects.ideas.update(selected.id, projectId, {
					title: draft.title,
					body: draft.body,
					kind: draft.kind,
					tags: draft.tags.split(",").map((tag) => tag.trim()).filter(Boolean),
					refinement: confirmed,
				});
				if (!workspaceRequestGateRef.current.isCurrent(token)) return;
				setIdeasByProject((current) => ({ ...current, [projectId]: (current[projectId] ?? []).map((idea) => idea.id === updated.id ? updated : idea) }));
				setRefinementDraft(updated.refinement);
				setSaveState("saved");
				setEditing(false);
				return;
			}
			if (!editing || !draft.title.trim()) return;
			const idea = await desktopApi.projects.ideas.create({
				projectId,
				title: draft.title,
				body: draft.body,
				kind: draft.kind,
				refinement: confirmed,
				tags: draft.tags.split(",").map((tag) => tag.trim()).filter(Boolean),
				...(prefill?.sessionId ? { linkedSessionIds: [prefill.sessionId], sourceSessionId: prefill.sessionId } : {}),
				...(prefill?.messageId ? { sourceMessageId: prefill.messageId } : {}),
				...(prefill?.sourceKind ? { sourceKind: prefill.sourceKind } : {}),
				...(parentDraft ? { derivedFromIdeaId: parentDraft.id } : {}),
			});
			if (!workspaceRequestGateRef.current.isCurrent(token)) return;
			setIdeasByProject((current) => ({ ...current, [projectId]: [idea, ...(current[projectId] ?? [])] }));
			setSelectedId(idea.id);
			setParentDraft(null);
			setEditing(false);
			setRefinementDraft(idea.refinement);
			setSaveState("saved");
		} catch (reason) {
			if (workspaceRequestGateRef.current.isCurrent(token)) showNotice(projectIdeaError(reason), 5000, "error");
		}
	}, [draft, editing, parentDraft, prefill, projectId, refinementDraft, selected, setIdeasByProject]);

	const createIdea = useCallback(async () => {
		if (!projectId || !draft.title.trim()) return;
		const token = workspaceRequestGateRef.current.capture(projectId);
		if (!token) return;
		setSaveState("saving");
		try {
			const idea = await desktopApi.projects.ideas.create({
				projectId,
				title: draft.title,
				body: draft.body,
				kind: draft.kind,
				tags: draft.tags.split(",").map((tag) => tag.trim()).filter(Boolean),
				...(prefill?.sessionId ? { linkedSessionIds: [prefill.sessionId], sourceSessionId: prefill.sessionId } : {}),
				...(prefill?.messageId ? { sourceMessageId: prefill.messageId } : {}),
				...(prefill?.sourceKind ? { sourceKind: prefill.sourceKind } : {}),
				...(parentDraft ? { derivedFromIdeaId: parentDraft.id } : {}),
			});
			if (!workspaceRequestGateRef.current.isCurrent(token)) return;
			setIdeasByProject((current) => ({ ...current, [projectId]: [idea, ...(current[projectId] ?? [])] }));
			setSelectedId(idea.id);
			setParentDraft(null);
			setBodyPreview(true);
			setRefinementDraft(undefined);
			setDraft(emptyDraft());
			setSaveState("saved");
		} catch (reason) {
			if (!workspaceRequestGateRef.current.isCurrent(token)) return;
			setSaveState("error");
			showNotice(projectIdeaError(reason), 5000, "error");
		}
	}, [draft, parentDraft, prefill, projectId, setIdeasByProject]);

	const save = useCallback(async () => {
		if (!selected || !projectId) return;
		const token = workspaceRequestGateRef.current.capture(projectId);
		if (!token) return;
		setSaveState("saving");
		try {
			const updated = await desktopApi.projects.ideas.update(selected.id, projectId, {
				title: draft.title,
				body: draft.body,
				kind: draft.kind,
				tags: draft.tags.split(",").map((tag) => tag.trim()).filter(Boolean),
				refinement: refinementDraft?.confirmedAt ? refinementDraft : null,
			});
			if (!workspaceRequestGateRef.current.isCurrent(token)) return;
			setIdeasByProject((current) => ({ ...current, [projectId]: (current[projectId] ?? []).map((idea) => idea.id === updated.id ? updated : idea) }));
			setRefinementDraft(updated.refinement);
			setSaveState("saved");
			setEditing(false);
			setBodyPreview(true);
		} catch (reason) {
			if (!workspaceRequestGateRef.current.isCurrent(token)) return;
			setSaveState("error");
			showNotice(projectIdeaError(reason), 5000, "error");
		}
	}, [draft, projectId, refinementDraft, selected, setIdeasByProject]);

	const changeStatus = useCallback(async (idea: ProjectIdea, status: ProjectIdeaStatus) => {
		if (!projectId) return;
		const token = workspaceRequestGateRef.current.capture(projectId);
		if (!token) return;
		try {
			const updated = await desktopApi.projects.ideas.update(idea.id, projectId, { status });
			if (!workspaceRequestGateRef.current.isCurrent(token)) return;
			setIdeasByProject((current) => ({ ...current, [projectId]: (current[projectId] ?? []).map((item) => item.id === updated.id ? updated : item) }));
		} catch (reason) {
			if (workspaceRequestGateRef.current.isCurrent(token)) showNotice(projectIdeaError(reason), 5000, "error");
		}
	}, [projectId, setIdeasByProject]);

	const continueIdea = useCallback(async (idea: ProjectIdea) => {
		if (!projectId) return;
		const token = workspaceRequestGateRef.current.capture(projectId);
		if (!token) return;
		const prompt = idea.kind === "brainstorm"
			? formatProjectIdeaForDiscussion({ title: idea.title, body: idea.body, refinement: idea.refinement })
			: t("projectIdeas.continuePrompt", { title: idea.title, body: idea.body });
		if (idea.kind === "brainstorm") {
			const existingSessionId = idea.linkedSessionIds.at(-1);
			if (existingSessionId && availableSessionIds.includes(existingSessionId)) {
				// 方案不满意时回到原头脑风暴会话继续交流，不再隐式创建第二个会话。
				close();
				onPlansStarted?.(projectId, existingSessionId);
				return;
			}
			let sessionId: string | null = null;
			try {
				sessionId = (await onBrainstorm?.(projectId, prompt, refinementModel, refinementThinkingLevel)) ?? null;
				if (!sessionId || !workspaceRequestGateRef.current.isCurrent(token)) return;
				const linkedSessionIds = Array.from(new Set([...idea.linkedSessionIds, sessionId]));
				const updated = await desktopApi.projects.ideas.update(idea.id, projectId, {
					linkedSessionIds,
					status: "doing",
				});
				if (!workspaceRequestGateRef.current.isCurrent(token)) return;
				setIdeasByProject((current) => ({
					...current,
					[projectId]: (current[projectId] ?? []).map((item) => item.id === updated.id ? updated : item),
				}));
			} catch (reason) {
				if (workspaceRequestGateRef.current.isCurrent(token)) showNotice(projectIdeaError(reason), 5000, "error");
				return;
			}
		} else {
			onContinue?.(projectId, prompt);
		}
		if (!workspaceRequestGateRef.current.isCurrent(token)) return;
		close();
	}, [availableSessionIds, close, onBrainstorm, onContinue, onPlansStarted, projectId, refinementModel, refinementThinkingLevel, setIdeasByProject]);

	const executeIdea = useCallback(async (idea: ProjectIdea) => {
		const snapshotRefinement = cloneRefinement(refinementDraft);
		if (!projectId || !onExecute || !snapshotRefinement?.confirmedAt || !draft.title.trim() || executionInFlight) return;
		const token = workspaceRequestGateRef.current.capture(projectId);
		if (!token) return;
		const snapshot = {
			ideaId: idea.id,
			title: draft.title,
			body: draft.body,
			refinement: snapshotRefinement,
			targetKey: refinementTargetKey,
			linkedSessionIds: [...idea.linkedSessionIds],
		};
		setExecutingIdeaId(snapshot.ideaId);
		try {
			const targetSessionId = await onExecute(projectId, formatProjectIdeaForExecution({
				...idea,
				title: snapshot.title,
				body: snapshot.body,
				refinement: snapshot.refinement,
			}), implementationModel, implementationThinkingLevel, buildProjectIdeaSessionTitle({
				title: snapshot.title,
				refinement: snapshot.refinement,
			}));
			if (!targetSessionId || !workspaceRequestGateRef.current.isCurrent(token)) return;
			const stillCurrent = selectedIdRef.current === snapshot.ideaId
				&& refinementTargetKeyRef.current === snapshot.targetKey
				&& draftRef.current.title === snapshot.title
				&& draftRef.current.body === snapshot.body
				&& JSON.stringify(refinementDraftRef.current) === JSON.stringify(snapshot.refinement);
			if (!stillCurrent) return;
			const linkedSessionIds = Array.from(new Set([...snapshot.linkedSessionIds, targetSessionId]));
			const updated = await desktopApi.projects.ideas.update(snapshot.ideaId, projectId, {
				title: snapshot.title,
				body: snapshot.body,
				refinement: snapshot.refinement,
				kind: "implementation",
				status: "doing",
				linkedSessionIds,
			});
			if (!workspaceRequestGateRef.current.isCurrent(token)) return;
			setIdeasByProject((current) => ({ ...current, [projectId]: (current[projectId] ?? []).map((item) => item.id === updated.id ? updated : item) }));
			close();
		} catch (reason) {
			if (workspaceRequestGateRef.current.isCurrent(token)) {
				showNotice(projectIdeaError(reason), 5000, "error");
				void load(projectId).catch(() => undefined);
			}
		} finally {
			if (workspaceRequestGateRef.current.isCurrent(token)) setExecutingIdeaId((current) => current === snapshot.ideaId ? null : current);
		}
	}, [draft, executionInFlight, load, onExecute, projectId, refinementDraft, refinementTargetKey, setIdeasByProject]);

	const extractPlans = useCallback(async () => {
		if (!projectId || !selected || selected.kind !== "brainstorm" || !latestLinkedSessionId || !hasLiveLatestLinkedSession(selected.linkedSessionIds, availableSessionIds) || plans.running || startingPlansSource) return;
		const token = workspaceRequestGateRef.current.capture(projectId);
		if (!token) return;
		const sourceIdeaId = selected.id;
		setStartingPlansSource(true);
		try {
			await plans.summarize({
				projectId,
				sourceSessionId: latestLinkedSessionId,
				title: selected.title,
				body: selected.body,
				...(refinementModel ? { model: refinementModel } : {}),
				...(refinementThinkingLevel ? { thinkingLevel: refinementThinkingLevel } : {}),
				onCompleted: (summary) => {
					if (!workspaceRequestGateRef.current.isCurrent(token) || selectedIdRef.current !== sourceIdeaId) return;
					setRefinementDraft(summary);
					setRefinementOpen(true);
				},
				onError: (error) => { if (workspaceRequestGateRef.current.isCurrent(token)) showNotice(projectIdeaPlansError(error) ?? error, 5000, "error"); },
			});
		} catch (reason) {
			if (workspaceRequestGateRef.current.isCurrent(token)) showNotice(reason instanceof Error ? reason.message : String(reason), 5000, "error");
		} finally {
			if (workspaceRequestGateRef.current.isCurrent(token)) setStartingPlansSource(false);
		}
	}, [availableSessionIds, latestLinkedSessionId, plans, projectId, refinementModel, refinementThinkingLevel, selected, startingPlansSource]);
	const remove = useCallback(async (idea: ProjectIdea) => {
		if (!projectId) return;
		const token = workspaceRequestGateRef.current.capture(projectId);
		if (!token) return;
		if (idea.id === selectedIdRef.current) {
			// Deleting the selected idea must invalidate any source wait or anonymous
			// summary runtime before the idea disappears from the local tree.
			refinement.cancel();
			plans.cancel();
			setRefinementDraft(undefined);
			setRefinementOpen(false);
		}
		try {
			// Keep descendants untouched: the hierarchy builder treats a missing parent as
			// a root, so deleting an idea cannot erase or rewrite its follow-ups.
			await desktopApi.projects.ideas.delete(idea.id, projectId);
			if (!workspaceRequestGateRef.current.isCurrent(token)) return;
			setIdeasByProject((current) => ({
				...current,
				[projectId]: (current[projectId] ?? []).filter((item) => item.id !== idea.id),
			}));
			setSelectedId((current) => current === idea.id ? null : current);
		} catch (reason) {
			if (workspaceRequestGateRef.current.isCurrent(token)) showNotice(projectIdeaError(reason), 5000, "error");
		}
	}, [plans.cancel, projectId, refinement.cancel, setIdeasByProject]);

	useEffect(() => {
		if (!open) resetWorkspaceState();
	}, [open, resetWorkspaceState]);

	return (
		<Dialog open={open} onOpenChange={(next) => { if (!next) { if (executionInFlight) return; resetWorkspaceState(); close(); } else setOpen(next); }}>
			<DialogContent size="xl" showCloseButton className="flex h-[min(720px,calc(100vh-64px))] max-w-[min(960px,calc(100vw-48px))] flex-col overflow-hidden p-0">
				<DialogHeader className="border-b border-border-subtle px-6 py-4 text-left">
					<div className="flex items-center gap-2">
						{overviewProjectId && <Button type="button" size="sm" variant="ghost" disabled={executionInFlight} onClick={() => { resetWorkspaceState(); openProjectIdeas({ kind: "project", projectId: overviewProjectId }); }}><ArrowLeft className="size-3.5" />{t("projectIdeas.backToOverview")}</Button>}
						<DialogTitle className="flex items-center gap-2"><Lightbulb className="size-4 text-primary" />{t("projectIdeas.title")}</DialogTitle>
					</div>
				</DialogHeader>
				<div className="flex min-h-0 flex-1">
					<section className="flex w-[38%] min-w-0 flex-col border-r border-border-subtle">
						<div className="flex flex-wrap gap-1 border-b border-border-subtle p-3">
							<Button type="button" size="sm" disabled={executionInFlight} onClick={() => { setSelectedId(null); setParentDraft(null); setEditing(true); setBodyPreview(false); setRefinementOpen(false); setRefinementDraft(undefined); setDraft(emptyDraft()); }}><Plus className="size-3.5" />{t("projectIdeas.new")}</Button>
							{(["active", ...STATUSES] as const).map((value) => <Button key={value} type="button" size="sm" variant={filter === value ? "secondary" : "ghost"} onClick={() => setFilter(value)}>{value === "active" ? t("projectIdeas.all") : statusLabel(value)}</Button>)}
						</div>
						<div className="min-h-0 flex-1 overflow-y-auto p-2">
							{visibleIdeas.length === 0 ? <p className="p-4 text-sm text-muted-foreground">{t("projectIdeas.empty")}</p> : <ProjectIdeaTree roots={visibleIdeas} selectedId={selectedId} disabled={executionInFlight || plans.running || startingPlansSource} kindLabel={(kind) => kindLabel(kind ?? DEFAULT_IDEA_KIND)} onSelect={(idea) => { setSelectedId(idea.id); setParentDraft(null); setEditing(false); setBodyPreview(true); }} onAddChild={(parent) => { setSelectedId(null); setParentDraft(parent); setEditing(true); setBodyPreview(false); setRefinementOpen(false); setRefinementDraft(undefined); setDraft(emptyDraft()); }} />}
						</div>
					</section>
					<section className="min-w-0 flex-1 overflow-y-auto p-6">
						{(selected || editing) ? <div className="flex min-h-0 flex-col gap-4">
							{parentDraft && <div className="rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-xs text-muted-foreground">{t("projectIdeas.followUpContext", { title: parentDraft.title })}</div>}
							<div className="flex items-center justify-between gap-2"><h3 className="truncate text-base font-semibold">{selected ? t("projectIdeas.edit") : t("projectIdeas.new")}</h3><div className="flex items-center gap-1">{(selected || editing) && <Button type="button" variant="ghost" size="sm" onClick={() => { if (draft.kind === "brainstorm") void extractPlans(); else { setRefinementOpen(true); refineIdea(); } }} disabled={executionInFlight || refinement.running || plans.running || !draft.title.trim()}><Sparkles className="size-3.5" />{refinement.running || plans.running ? t("projectIdeas.refining") : t("projectIdeas.refinementTitle")}</Button>}{selected && (selected.kind === "brainstorm" || selectedHasLinkedSession) && <Button type="button" variant="ghost" size="sm" disabled={executionInFlight} onClick={() => void continueIdea(selected)}>{t("projectIdeas.continue")}</Button>}{selectedCanExtractPlans && <Button type="button" variant="ghost" size="sm" disabled={executionInFlight || plans.running} onClick={() => void extractPlans()}>{plans.running || startingPlansSource ? t("projectIdeas.brainstormSummarizing") : t("projectIdeas.brainstormSummarize")}</Button>}{selected && onExecute && <Button type="button" variant="outline" size="sm" disabled={executionInFlight} onClick={() => setImplementationModelPickerOpen(true)}>{implementationModel ? `${implementationModel.provider}/${implementationModel.modelId}` : t("projectIdeas.defaultModel")}{implementationThinkingLevel ? ` · ${implementationThinkingLevel}` : ""}</Button>}{selected && onExecute && <Button type="button" size="sm" onClick={() => void executeIdea(selected)} disabled={executionInFlight || refinement.running || !refinementDraft?.confirmedAt || !draft.title.trim()}>{executionInFlight ? t("projectIdeas.executing") : t("projectIdeas.execute")}</Button>}{selected && <Button type="button" variant="ghost" size="icon" disabled={executionInFlight} aria-label={t("projectIdeas.delete")} onClick={() => setPendingDelete(selected)}><Trash2 className="size-4 text-destructive" /></Button>}</div></div>
							{selected?.kind === "brainstorm" && selectedCanExtractPlans && <div className="rounded-lg border border-primary/30 bg-primary/5 p-3"><div className="flex items-center justify-between gap-2"><div className="text-sm font-medium"><Sparkles className="mr-1 inline size-4 text-primary" />{t("projectIdeas.brainstormSummaryTitle")}</div><Button type="button" size="sm" variant="ghost" onClick={() => void extractPlans()} disabled={executionInFlight || plans.running || startingPlansSource}>{plans.running || startingPlansSource ? t("projectIdeas.brainstormSummarizing") : t("projectIdeas.brainstormSummarize")}</Button></div><p className="mt-1 text-xs text-muted-foreground">{t("projectIdeas.brainstormSummaryHint")}</p>{plans.error && <p className="mt-2 text-xs text-destructive">{projectIdeaPlansError(plans.error)}</p>}</div>}
							<Input disabled={executionInFlight} value={draft.title} placeholder={t("projectIdeas.titlePlaceholder")} onChange={(event) => { invalidateConfirmedRefinement(); setDraft((current) => ({ ...current, title: event.target.value })); }} />
							<div className="grid gap-1"><span className="text-xs font-medium">{t("projectIdeas.kindLabel")}</span><Select value={draft.kind} disabled={executionInFlight} onValueChange={(value) => { const nextKind = parseIdeaKind(value); if (!nextKind) return; invalidateConfirmedRefinement(); setImplementationModelPickerOpen(false); setDraft((current) => ({ ...current, kind: nextKind })); }}><SelectTrigger className="h-9 text-xs"><SelectValue /></SelectTrigger><SelectContent>{IDEA_KINDS.map((kind) => <SelectItem key={kind} value={kind}>{kindLabel(kind)}</SelectItem>)}</SelectContent></Select></div>
							<div className="flex min-h-48 flex-none flex-col gap-2">
								<div className="flex items-center justify-between gap-2">
									<span className="text-xs text-muted-foreground">{t("projectIdeas.bodyHint")}</span>
									<Button type="button" size="sm" variant="ghost" onClick={() => setBodyPreview((current) => !current)} disabled={executionInFlight || uploadingImage}>
										{bodyPreview ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
										{bodyPreview ? t("projectIdeas.editBody") : t("projectIdeas.previewBody")}
									</Button>
								</div>
								{bodyPreview ? (
									<div className="markdown-body h-48 overflow-y-auto rounded-md border border-input px-3 py-2 text-sm">
										<MarkdownStream text={draft.body || t("projectIdeas.noBody")} light onOpenExternal={(url) => void desktopApi.app.openExternal(url, true)} />
									</div>
								) : (
									<div className="relative flex h-48 flex-none">
										<Textarea disabled={executionInFlight} ref={bodyRef} className="min-h-48 flex-1 resize-none" value={draft.body} placeholder={t("projectIdeas.bodyPlaceholder")} onPaste={(event) => void handleBodyPaste(event)} onChange={(event) => { invalidateConfirmedRefinement(); setDraft((current) => ({ ...current, body: event.target.value })); }} />
										{uploadingImage && <div className="pointer-events-none absolute right-3 top-3 inline-flex items-center gap-1 rounded bg-background/90 px-2 py-1 text-xs text-muted-foreground"><LoaderCircle className="size-3 animate-spin" />{t("projectIdeas.uploadingImage")}</div>}
									</div>
								)}
							</div>
							{implementationModelPickerOpen && <ModelPicker models={implementationModels} report={implementationModelsReport} current={implementationModel} onRefresh={refreshImplementationModels} onClose={() => setImplementationModelPickerOpen(false)} onPick={(model) => { setImplementationModel({ provider: model.provider, modelId: model.id }); setImplementationThinkingConfirmed(false); }} footer={ <div className="border-t border-border-subtle bg-muted/20 px-3 py-2"><div className="flex items-center justify-end gap-2"><div className="inline-flex h-7 items-center gap-1.5"><span className="px-0.5 text-xs font-medium text-muted-foreground">{t("projectIdeas.thinkingLevel")}</span><DropdownMenu><DropdownMenuTrigger asChild><button type="button" className="group flex h-full min-w-20 items-center justify-between gap-1.5 rounded-md border border-input bg-background px-2.5 font-mono text-xs font-medium text-foreground shadow-xs transition-[background-color,border-color,box-shadow] duration-150 hover:border-primary/30 hover:bg-muted/60 focus-visible:border-primary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/10 disabled:cursor-not-allowed disabled:opacity-50" disabled={executionInFlight}><span>{implementationThinkingLevel ?? t("projectIdeas.defaultThinking")}</span><ChevronDown className="size-3 text-muted-foreground transition-transform duration-150 group-data-[state=open]:rotate-180" /></button></DropdownMenuTrigger><DropdownMenuContent align="end" side="top" sideOffset={6} className="min-w-40"><DropdownMenuRadioGroup value={implementationThinkingLevel ?? "default"} onValueChange={(value) => { setImplementationThinkingLevel(value === "default" ? undefined : value); setImplementationThinkingConfirmed(false); }}><DropdownMenuRadioItem value="default">{t("projectIdeas.defaultThinking")}</DropdownMenuRadioItem>{THINKING_LEVELS.map((level) => <DropdownMenuRadioItem key={level.value} value={level.value}>{t(level.labelKey)}</DropdownMenuRadioItem>)}</DropdownMenuRadioGroup></DropdownMenuContent></DropdownMenu></div><Button type="button" size="sm" className="h-7 min-w-14 px-2.5 text-xs transition-[background-color,color,box-shadow,transform] duration-150 active:scale-[0.97]" variant={implementationThinkingConfirmed ? "secondary" : "default"} disabled={executionInFlight} onClick={() => { setImplementationThinkingConfirmed(true); showNotice(t("projectIdeas.thinkingConfirmed"), 2500); setImplementationModelPickerOpen(false); }}>{implementationThinkingConfirmed ? t("projectIdeas.thinkingConfirmedShort") : t("projectIdeas.confirmThinking")}</Button></div></div>} />}
											{refinementOpen && <ProjectIdeaRefinementPanel
								value={refinementDraft}
								kind={draft.kind}
								confirmed={Boolean(refinementDraft?.confirmedAt)}
								disabled={executionInFlight}
								running={refinement.running}
								error={refinement.error}
								canUseContext={Boolean(currentSessionId && currentSessionProjectId === projectId && currentSessionContext.length > 0)}
								useContext={refinementUseContext}
								onUseContextChange={setRefinementUseContext}
								onChange={(value) => setRefinementDraft({ ...value, confirmedAt: undefined })}
								onRefine={refineIdea}
								onAccept={() => void acceptRefinement()}
							/>}
							<Input disabled={executionInFlight} value={draft.tags} placeholder={t("projectIdeas.tagsPlaceholder")} onChange={(event) => setDraft((current) => ({ ...current, tags: event.target.value }))} />
							{selected?.sourceKind && <p className="text-xs text-muted-foreground">{selected.sourceKind === "selection" ? t("projectIdeas.sourceSelection") : t("projectIdeas.sourceMessage")}{selected.sourceMessageId ? ` · ${selected.sourceMessageId}` : ""}</p>}
							{selected && <div className="flex flex-wrap gap-1">{STATUSES.map((status) => <Button key={status} type="button" size="sm" disabled={executionInFlight} variant={selected.status === status ? "secondary" : "ghost"} onClick={() => void changeStatus(selected, status)}>{statusLabel(status)}</Button>)}</div>}
							<div className="flex items-center justify-end gap-2">{saveState !== "idle" && <span className={cn("text-xs", saveState === "error" ? "text-destructive" : "text-muted-foreground")}>{saveState === "saving" ? t("projectIdeas.saving") : saveState === "saved" ? t("projectIdeas.saved") : t("projectIdeas.saveFailed")}</span>}<Button type="button" variant="ghost" disabled={executionInFlight} onClick={() => { refinement.cancel(); setParentDraft(null); setEditing(false); setBodyPreview(Boolean(selected)); if (selected) { setDraft({ title: selected.title, body: selected.body, tags: selected.tags.join(", "), kind: selected.kind ?? "implementation" }); setRefinementDraft(selected.refinement); setRefinementOpen(Boolean(selected.refinement)); } }}>{t("projectIdeas.cancel")}</Button><Button type="button" disabled={executionInFlight || !draft.title.trim()} onClick={() => void (selected ? save() : createIdea())}>{t("projectIdeas.save")}</Button></div>
						</div> : <div className="grid h-full place-items-center text-center text-sm text-muted-foreground"><div><Lightbulb className="mx-auto mb-3 size-8 opacity-50" /><p>{t("projectIdeas.selectHint")}</p></div></div>}
					</section>
				</div>
			</DialogContent>
			<AlertDialog open={pendingDelete !== null} onOpenChange={(next) => { if (!next) setPendingDelete(null); }}>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>{t("projectIdeas.delete")}</AlertDialogTitle>
						<AlertDialogDescription>{t("projectIdeas.deleteConfirm")}</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>{t("projectIdeas.cancel")}</AlertDialogCancel>
						<AlertDialogAction className="bg-[var(--color-danger)] text-white hover:bg-[var(--color-danger)]" onClick={() => {
							const idea = pendingDelete;
							setPendingDelete(null);
							if (idea) void remove(idea);
						}}>{t("common.delete")}</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</Dialog>
	);
}
