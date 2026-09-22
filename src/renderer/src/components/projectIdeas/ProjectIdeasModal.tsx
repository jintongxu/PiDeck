import { useCallback, useEffect, useMemo, useRef, useState, type ClipboardEvent } from "react";
import { ChevronDown, Eye, EyeOff, Lightbulb, LoaderCircle, Plus, Sparkles, Trash2 } from "lucide-react";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import type { AvailableModel, ModelListReport, ProjectIdea, ProjectIdeaRefinement, ProjectIdeaStatus } from "../../../../shared/types";
import {
	closeProjectIdeasModalAtom,
	projectIdeasByProjectAtom,
	projectIdeasModalOpenAtom,
	projectIdeasPrefillAtom,
	projectIdeasModalProjectIdAtom,
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
import { cn } from "../../lib/utils";
import { showNotice } from "../../utils/notice";
import { MarkdownStream } from "../session/MarkdownStream";
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
import { buildProjectIdeaRefinementPrompt, formatProjectIdeaForExecution } from "../../utils/projectIdeaRefinement";
import { hasLiveLatestLinkedSession } from "../../utils/projectIdeaSessionLinks";

const STATUSES: readonly ProjectIdeaStatus[] = ["inbox", "planned", "doing", "done"];
const STATUS_LABEL_KEYS: Record<ProjectIdeaStatus, TranslationKey> = {
	inbox: "projectIdeas.status.inbox",
	planned: "projectIdeas.status.planned",
	doing: "projectIdeas.status.doing",
	done: "projectIdeas.status.done",
};

function statusLabel(status: ProjectIdeaStatus): string {
	return t(STATUS_LABEL_KEYS[status]);
}

function emptyDraft() {
	return { title: "", body: "", tags: "" };
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
export function ProjectIdeasModal({ onContinue, onExecute, refinementModel, refinementThinkingLevel, currentSessionId, currentSessionProjectId, currentSessionContext = [], availableSessionIds = [] }: {
	onContinue?: (projectId: string, prompt: string) => void;
	onExecute?: (projectId: string, prompt: string, model?: { provider: string; modelId: string }, thinkingLevel?: string) => Promise<string | null>;
	refinementModel?: { provider: string; modelId: string };
	refinementThinkingLevel?: string;
	currentSessionId?: string;
	currentSessionProjectId?: string;
	currentSessionContext?: readonly { role: string; text: string }[];
	availableSessionIds?: readonly string[];
}) {
	const [open, setOpen] = useAtom(projectIdeasModalOpenAtom);
	const projectId = useAtomValue(projectIdeasModalProjectIdAtom);
	const prefill = useAtomValue(projectIdeasPrefillAtom);
	const close = useSetAtom(closeProjectIdeasModalAtom);
	const [ideasByProject, setIdeasByProject] = useAtom(projectIdeasByProjectAtom);
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [filter, setFilter] = useState<ProjectIdeaStatus | "active">("active");
	const [draft, setDraft] = useState(emptyDraft);
	const [editing, setEditing] = useState(false);
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
	const [implementationModels, setImplementationModels] = useState<AvailableModel[]>([]);
	const [implementationModelsReport, setImplementationModelsReport] = useState<ModelListReport | null>(null);
	const [implementationModelPickerOpen, setImplementationModelPickerOpen] = useState(false);
	const bodyRef = useRef<HTMLTextAreaElement | null>(null);
	const refinement = useProjectIdeaRefinement();
	const ideas = projectId ? ideasByProject[projectId] ?? [] : [];
	const visibleIdeas = useMemo(
		() => filter === "active"
			? ideas.filter((idea) => idea.status !== "done")
			: ideas.filter((idea) => idea.status === filter),
		[filter, ideas],
	);
	const selected = ideas.find((idea) => idea.id === selectedId) ?? null;
	const selectedHasLinkedSession = Boolean(selected && hasLiveLatestLinkedSession(selected.linkedSessionIds, availableSessionIds));
	const executionInFlight = executingIdeaId !== null;
	const refinementTargetKey = `${projectId ?? ""}:${selectedId ?? "new"}:${draft.title}:${draft.body}`;
	const draftRef = useRef(draft);
	const refinementDraftRef = useRef(refinementDraft);
	const refinementTargetKeyRef = useRef(refinementTargetKey);
	const selectedIdRef = useRef(selectedId);
	draftRef.current = draft;
	refinementDraftRef.current = refinementDraft;
	refinementTargetKeyRef.current = refinementTargetKey;
	selectedIdRef.current = selectedId;
	const loadRequestRef = useRef(0);

	const load = useCallback(async (id: string) => {
		const requestId = loadRequestRef.current + 1;
		loadRequestRef.current = requestId;
		const result = await desktopApi.projects.ideas.list(id);
		if (loadRequestRef.current !== requestId || projectId !== id) return;
		setIdeasByProject((current) => ({ ...current, [id]: result }));
		setSelectedId((previous) => {
			if (prefill?.projectId === id) return null;
			return previous && result.some((idea) => idea.id === previous) ? previous : result[0]?.id ?? null;
		});
	}, [prefill?.projectId, projectId, setIdeasByProject]);

	useEffect(() => {
		if (!open || !projectId) return;
		setFilter("active");
		void load(projectId).catch(() => undefined);
		return () => {
			loadRequestRef.current += 1;
		};
	}, [load, open, projectId]);

	useEffect(() => {
		if (!open || !projectId) return;
		void desktopApi.projects.listModelsReport(projectId ?? undefined, false).then((report) => {
			setImplementationModels(report.models);
			setImplementationModelsReport(report);
		}).catch(() => undefined);
	}, [open, projectId]);

	const refreshImplementationModels = useCallback(() => {
		void desktopApi.projects.listModelsReport(projectId ?? undefined, true).then((report) => {
			setImplementationModels(report.models);
			setImplementationModelsReport(report);
		}).catch(() => undefined);
	}, [projectId]);

	useEffect(() => {
		if (!selected) return;
		setDraft({ title: selected.title, body: selected.body, tags: selected.tags.join(", ") });
		setRefinementDraft(selected.refinement);
		setRefinementOpen(Boolean(selected.refinement));
		setEditing(false);
		setBodyPreview(true);
	}, [selected]);

	useEffect(() => {
		if (!open || !projectId || !prefill || prefill.projectId !== projectId) return;
		setSelectedId(null);
		setEditing(true);
		setBodyPreview(false);
		setRefinementDraft(undefined);
		setRefinementOpen(false);
		setDraft({ title: prefill.title, body: prefill.body, tags: "" });
	}, [open, prefill, projectId]);

	useEffect(() => {
		if (refinement.result && refinement.resultTargetKey === refinementTargetKey) {
			setRefinementDraft(refinement.result);
			setRefinementOpen(true);
		}
	}, [refinement.result, refinement.resultTargetKey, refinementTargetKey]);

	useEffect(() => {
		refinement.cancel();
	}, [draft.body, draft.title, refinement.cancel, selectedId]);

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
		const image = Array.from(event.clipboardData.items).find((item) => item.kind === "file" && item.type.startsWith("image/"));
		if (!image) return;
		const file = image.getAsFile();
		if (!file) return;
		event.preventDefault();
		setUploadingImage(true);
		try {
			const url = await desktopApi.projects.ideas.uploadImage(await dataUrlFromBlob(file));
			insertBodyAtSelection(`![${file.name || "image"}](${url})`);
		} catch {
			showNotice(t("projectIdeas.imageUploadFailed"), 4000, "error");
		} finally {
			setUploadingImage(false);
		}
	}, [dataUrlFromBlob, insertBodyAtSelection]);

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
			prompt: buildProjectIdeaRefinementPrompt({ title: draft.title, body: draft.body }, context ?? undefined),
		});
	}, [currentSessionContext, draft.body, draft.title, projectId, refinement, refinementModel, refinementTargetKey, refinementThinkingLevel, refinementUseContext]);

	const acceptRefinement = useCallback(async () => {
		if (!projectId || !refinementDraft?.summary.trim()) return;
		const confirmed = { ...refinementDraft, confirmedAt: Date.now() };
		try {
			if (selected) {
				const updated = await desktopApi.projects.ideas.update(selected.id, projectId, {
					title: draft.title,
					body: draft.body,
					tags: draft.tags.split(",").map((tag) => tag.trim()).filter(Boolean),
					refinement: confirmed,
				});
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
				refinement: confirmed,
				tags: draft.tags.split(",").map((tag) => tag.trim()).filter(Boolean),
				...(prefill?.sessionId ? { linkedSessionIds: [prefill.sessionId], sourceSessionId: prefill.sessionId } : {}),
				...(prefill?.messageId ? { sourceMessageId: prefill.messageId } : {}),
				...(prefill?.sourceKind ? { sourceKind: prefill.sourceKind } : {}),
			});
			setIdeasByProject((current) => ({ ...current, [projectId]: [idea, ...(current[projectId] ?? [])] }));
			setSelectedId(idea.id);
			setEditing(false);
			setRefinementDraft(idea.refinement);
			setSaveState("saved");
		} catch (reason) {
			showNotice(reason instanceof Error ? reason.message : String(reason), 5000, "error");
		}
	}, [draft, editing, prefill, projectId, refinementDraft, selected, setIdeasByProject]);

	const createIdea = useCallback(async () => {
		if (!projectId || !draft.title.trim()) return;
		setSaveState("saving");
		try {
			const idea = await desktopApi.projects.ideas.create({
				projectId,
				title: draft.title,
				body: draft.body,
				tags: draft.tags.split(",").map((tag) => tag.trim()).filter(Boolean),
				...(prefill?.sessionId ? { linkedSessionIds: [prefill.sessionId], sourceSessionId: prefill.sessionId } : {}),
				...(prefill?.messageId ? { sourceMessageId: prefill.messageId } : {}),
				...(prefill?.sourceKind ? { sourceKind: prefill.sourceKind } : {}),
			});
			setIdeasByProject((current) => ({ ...current, [projectId]: [idea, ...(current[projectId] ?? [])] }));
			setSelectedId(idea.id);
			setBodyPreview(true);
			setRefinementDraft(undefined);
			setDraft(emptyDraft());
			setSaveState("saved");
		} catch (reason) {
			setSaveState("error");
			showNotice(reason instanceof Error ? reason.message : String(reason), 5000, "error");
		}
	}, [draft, prefill, projectId, setIdeasByProject]);

	const save = useCallback(async () => {
		if (!selected) return;
		setSaveState("saving");
		try {
			const updated = await desktopApi.projects.ideas.update(selected.id, projectId ?? "", {
				title: draft.title,
				body: draft.body,
				tags: draft.tags.split(",").map((tag) => tag.trim()).filter(Boolean),
				refinement: refinementDraft?.confirmedAt ? refinementDraft : null,
			});
			if (projectId) setIdeasByProject((current) => ({ ...current, [projectId]: (current[projectId] ?? []).map((idea) => idea.id === updated.id ? updated : idea) }));
			setRefinementDraft(updated.refinement);
			setSaveState("saved");
			setEditing(false);
			setBodyPreview(true);
		} catch (reason) {
			setSaveState("error");
			showNotice(reason instanceof Error ? reason.message : String(reason), 5000, "error");
		}
	}, [draft, projectId, refinementDraft, selected, setIdeasByProject]);

	const changeStatus = useCallback(async (idea: ProjectIdea, status: ProjectIdeaStatus) => {
		const updated = await desktopApi.projects.ideas.update(idea.id, projectId ?? "", { status });
		if (projectId) setIdeasByProject((current) => ({ ...current, [projectId]: (current[projectId] ?? []).map((item) => item.id === updated.id ? updated : item) }));
	}, [projectId, setIdeasByProject]);

	const continueIdea = useCallback((idea: ProjectIdea) => {
		if (!projectId) return;
		onContinue?.(projectId, t("projectIdeas.continuePrompt", { title: idea.title, body: idea.body }));
		close();
	}, [close, onContinue, projectId]);

	const executeIdea = useCallback(async (idea: ProjectIdea) => {
		const snapshotRefinement = cloneRefinement(refinementDraft);
		if (!projectId || !onExecute || !snapshotRefinement?.confirmedAt || !draft.title.trim() || executionInFlight) return;
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
			}), implementationModel, implementationThinkingLevel);
			if (!targetSessionId) return;
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
				status: "doing",
				linkedSessionIds,
			});
			setIdeasByProject((current) => ({ ...current, [projectId]: (current[projectId] ?? []).map((item) => item.id === updated.id ? updated : item) }));
			close();
		} catch (reason) {
			showNotice(reason instanceof Error ? reason.message : String(reason), 5000, "error");
			void load(projectId).catch(() => undefined);
		} finally {
			setExecutingIdeaId((current) => current === snapshot.ideaId ? null : current);
		}
	}, [draft, executionInFlight, load, onExecute, projectId, refinementDraft, refinementTargetKey, setIdeasByProject]);

	const remove = useCallback(async (idea: ProjectIdea) => {
		await desktopApi.projects.ideas.delete(idea.id, projectId ?? "");
		if (projectId) setIdeasByProject((current) => ({ ...current, [projectId]: (current[projectId] ?? []).filter((item) => item.id !== idea.id) }));
		setSelectedId((current) => current === idea.id ? null : current);
	}, [projectId, setIdeasByProject]);

	useEffect(() => {
		if (!open) refinement.cancel();
	}, [open, refinement.cancel]);

	return (
		<Dialog open={open} onOpenChange={(next) => { if (!next) { if (executionInFlight) return; refinement.cancel(); setPendingDelete(null); close(); } else setOpen(next); }}>
			<DialogContent size="xl" showCloseButton className="flex h-[min(720px,calc(100vh-64px))] max-w-[min(960px,calc(100vw-48px))] flex-col overflow-hidden p-0">
				<DialogHeader className="border-b border-border-subtle px-6 py-4 text-left">
					<DialogTitle className="flex items-center gap-2"><Lightbulb className="size-4 text-primary" />{t("projectIdeas.title")}</DialogTitle>
				</DialogHeader>
				<div className="flex min-h-0 flex-1">
					<section className="flex w-[38%] min-w-0 flex-col border-r border-border-subtle">
						<div className="flex flex-wrap gap-1 border-b border-border-subtle p-3">
							<Button type="button" size="sm" disabled={executionInFlight} onClick={() => { setSelectedId(null); setEditing(true); setBodyPreview(false); setRefinementOpen(false); setRefinementDraft(undefined); setDraft(emptyDraft()); }}><Plus className="size-3.5" />{t("projectIdeas.new")}</Button>
							{(["active", ...STATUSES] as const).map((value) => <Button key={value} type="button" size="sm" variant={filter === value ? "secondary" : "ghost"} onClick={() => setFilter(value)}>{value === "active" ? t("projectIdeas.all") : statusLabel(value)}</Button>)}
						</div>
						<div className="min-h-0 flex-1 overflow-y-auto p-2">
							{visibleIdeas.length === 0 ? <p className="p-4 text-sm text-muted-foreground">{t("projectIdeas.empty")}</p> : visibleIdeas.map((idea) => <button key={idea.id} type="button" className={cn("mb-1 w-full rounded-md border border-transparent p-3 text-left hover:bg-muted", selectedId === idea.id && "border-border bg-muted")} onClick={() => { if (executionInFlight) return; setSelectedId(idea.id); setEditing(false); setBodyPreview(true); }}><span className="block truncate text-sm font-medium">{idea.title}</span><span className="mt-1 block truncate text-xs text-muted-foreground">{statusLabel(idea.status)} · {idea.body || t("projectIdeas.noBody")}</span></button>)}
						</div>
					</section>
					<section className="min-w-0 flex-1 overflow-y-auto p-6">
						{(selected || editing) ? <div className="flex min-h-0 flex-col gap-4">
							<div className="flex items-center justify-between gap-2"><h3 className="truncate text-base font-semibold">{selected ? t("projectIdeas.edit") : t("projectIdeas.new")}</h3><div className="flex items-center gap-1">{(selected || editing) && <Button type="button" variant="ghost" size="sm" onClick={() => { setRefinementOpen(true); refineIdea(); }} disabled={executionInFlight || refinement.running || !draft.title.trim()}><Sparkles className="size-3.5" />{refinement.running ? t("projectIdeas.refining") : t("projectIdeas.refinementTitle")}</Button>}{selected && selectedHasLinkedSession && <Button type="button" variant="ghost" size="sm" disabled={executionInFlight} onClick={() => continueIdea(selected)}>{t("projectIdeas.continue")}</Button>}{selected && onExecute && <Button type="button" variant="outline" size="sm" disabled={executionInFlight} onClick={() => setImplementationModelPickerOpen(true)}>{implementationModel ? `${implementationModel.provider}/${implementationModel.modelId}` : t("projectIdeas.defaultModel")}{implementationThinkingLevel ? ` · ${implementationThinkingLevel}` : ""}</Button>}{selected && onExecute && <Button type="button" size="sm" onClick={() => void executeIdea(selected)} disabled={executionInFlight || refinement.running || !refinementDraft?.confirmedAt || !draft.title.trim()}>{executionInFlight ? t("projectIdeas.executing") : t("projectIdeas.execute")}</Button>}{selected && <Button type="button" variant="ghost" size="icon" disabled={executionInFlight} aria-label={t("projectIdeas.delete")} onClick={() => setPendingDelete(selected)}><Trash2 className="size-4 text-destructive" /></Button>}</div></div>
							<Input disabled={executionInFlight} value={draft.title} placeholder={t("projectIdeas.titlePlaceholder")} onChange={(event) => { invalidateConfirmedRefinement(); setDraft((current) => ({ ...current, title: event.target.value })); }} />
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
							{implementationModelPickerOpen && <ModelPicker models={implementationModels} report={implementationModelsReport} current={implementationModel} onRefresh={refreshImplementationModels} onClose={() => setImplementationModelPickerOpen(false)} onPick={(model) => { setImplementationModel({ provider: model.provider, modelId: model.id }); setImplementationThinkingConfirmed(false); }} footer={<div className="border-t border-border-subtle bg-muted/20 px-3 py-2"><div className="flex items-center justify-end gap-2"><div className="inline-flex h-7 items-center gap-1.5"><span className="px-0.5 text-xs font-medium text-muted-foreground">{t("projectIdeas.thinkingLevel")}</span><DropdownMenu><DropdownMenuTrigger asChild><button type="button" className="group flex h-full min-w-20 items-center justify-between gap-1.5 rounded-md border border-input bg-background px-2.5 font-mono text-xs font-medium text-foreground shadow-xs transition-[background-color,border-color,box-shadow] duration-150 hover:border-primary/30 hover:bg-muted/60 focus-visible:border-primary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/10 disabled:cursor-not-allowed disabled:opacity-50" disabled={executionInFlight}><span>{implementationThinkingLevel ?? t("projectIdeas.defaultThinking")}</span><ChevronDown className="size-3 text-muted-foreground transition-transform duration-150 group-data-[state=open]:rotate-180" /></button></DropdownMenuTrigger><DropdownMenuContent align="end" side="top" sideOffset={6} className="min-w-40"><DropdownMenuRadioGroup value={implementationThinkingLevel ?? "default"} onValueChange={(value) => { setImplementationThinkingLevel(value === "default" ? undefined : value); setImplementationThinkingConfirmed(false); }}><DropdownMenuRadioItem value="default">{t("projectIdeas.defaultThinking")}</DropdownMenuRadioItem>{THINKING_LEVELS.map((level) => <DropdownMenuRadioItem key={level.value} value={level.value}>{t(level.labelKey)}</DropdownMenuRadioItem>)}</DropdownMenuRadioGroup></DropdownMenuContent></DropdownMenu></div><Button type="button" size="sm" className="h-7 min-w-14 px-2.5 text-xs transition-[background-color,color,box-shadow,transform] duration-150 active:scale-[0.97]" variant={implementationThinkingConfirmed ? "secondary" : "default"} disabled={executionInFlight} onClick={() => { setImplementationThinkingConfirmed(true); showNotice(t("projectIdeas.thinkingConfirmed"), 2500); setImplementationModelPickerOpen(false); }}>{implementationThinkingConfirmed ? t("projectIdeas.thinkingConfirmedShort") : t("projectIdeas.confirmThinking")}</Button></div></div>} />}
							{refinementOpen && <ProjectIdeaRefinementPanel
								value={refinementDraft}
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
							<div className="flex items-center justify-end gap-2">{saveState !== "idle" && <span className={cn("text-xs", saveState === "error" ? "text-destructive" : "text-muted-foreground")}>{saveState === "saving" ? t("projectIdeas.saving") : saveState === "saved" ? t("projectIdeas.saved") : t("projectIdeas.saveFailed")}</span>}<Button type="button" variant="ghost" disabled={executionInFlight} onClick={() => { refinement.cancel(); setEditing(false); setBodyPreview(Boolean(selected)); if (selected) { setDraft({ title: selected.title, body: selected.body, tags: selected.tags.join(", ") }); setRefinementDraft(selected.refinement); setRefinementOpen(Boolean(selected.refinement)); } }}>{t("projectIdeas.cancel")}</Button><Button type="button" disabled={executionInFlight || !draft.title.trim()} onClick={() => void (selected ? save() : createIdea())}>{t("projectIdeas.save")}</Button></div>
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
