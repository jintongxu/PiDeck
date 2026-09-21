import { useCallback, useEffect, useMemo, useRef, useState, type ClipboardEvent } from "react";
import { Eye, EyeOff, Lightbulb, LoaderCircle, Plus, Trash2 } from "lucide-react";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import type { ProjectIdea, ProjectIdeaStatus } from "../../../../shared/types";
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

/** Project-scoped lightweight idea inbox. Persistence stays behind the preload API. */
export function ProjectIdeasModal({ onContinue }: {
	onContinue?: (projectId: string, prompt: string) => void;
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
	const bodyRef = useRef<HTMLTextAreaElement | null>(null);
	const ideas = projectId ? ideasByProject[projectId] ?? [] : [];
	const visibleIdeas = useMemo(
		() => filter === "active"
			? ideas.filter((idea) => idea.status !== "done")
			: ideas.filter((idea) => idea.status === filter),
		[filter, ideas],
	);
	const selected = ideas.find((idea) => idea.id === selectedId) ?? null;

	const load = useCallback(async (id: string) => {
		const result = await desktopApi.projects.ideas.list(id);
		setIdeasByProject((current) => ({ ...current, [id]: result }));
		setSelectedId((previous) => {
			if (prefill?.projectId === id) return null;
			return previous && result.some((idea) => idea.id === previous) ? previous : result[0]?.id ?? null;
		});
	}, [prefill?.projectId, setIdeasByProject]);

	useEffect(() => {
		if (!open || !projectId) return;
		setFilter("active");
		void load(projectId).catch(() => undefined);
	}, [load, open, projectId]);

	useEffect(() => {
		if (!selected) return;
		setDraft({ title: selected.title, body: selected.body, tags: selected.tags.join(", ") });
		setEditing(false);
		setBodyPreview(true);
	}, [selected]);

	useEffect(() => {
		if (!open || !projectId || !prefill || prefill.projectId !== projectId) return;
		setSelectedId(null);
		setEditing(true);
		setBodyPreview(false);
		setDraft({ title: prefill.title, body: prefill.body, tags: "" });
	}, [open, prefill, projectId]);

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

	const createIdea = useCallback(async () => {
		if (!projectId || !draft.title.trim()) return;
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
		setDraft(emptyDraft());
	}, [draft, prefill, projectId, setIdeasByProject]);

	const save = useCallback(async () => {
		if (!selected) return;
		const updated = await desktopApi.projects.ideas.update(selected.id, projectId ?? "", {
			title: draft.title,
			body: draft.body,
			tags: draft.tags.split(",").map((tag) => tag.trim()).filter(Boolean),
		});
		if (projectId) setIdeasByProject((current) => ({ ...current, [projectId]: (current[projectId] ?? []).map((idea) => idea.id === updated.id ? updated : idea) }));
		setEditing(false);
		setBodyPreview(true);
	}, [draft, projectId, selected, setIdeasByProject]);

	const changeStatus = useCallback(async (idea: ProjectIdea, status: ProjectIdeaStatus) => {
		const updated = await desktopApi.projects.ideas.update(idea.id, projectId ?? "", { status });
		if (projectId) setIdeasByProject((current) => ({ ...current, [projectId]: (current[projectId] ?? []).map((item) => item.id === updated.id ? updated : item) }));
	}, [projectId, setIdeasByProject]);

	const continueIdea = useCallback((idea: ProjectIdea) => {
		if (!projectId) return;
		onContinue?.(projectId, t("projectIdeas.continuePrompt", { title: idea.title, body: idea.body }));
		close();
	}, [close, onContinue, projectId]);

	const remove = useCallback(async (idea: ProjectIdea) => {
		await desktopApi.projects.ideas.delete(idea.id, projectId ?? "");
		if (projectId) setIdeasByProject((current) => ({ ...current, [projectId]: (current[projectId] ?? []).filter((item) => item.id !== idea.id) }));
		setSelectedId((current) => current === idea.id ? null : current);
	}, [projectId, setIdeasByProject]);

	return (
		<Dialog open={open} onOpenChange={(next) => { if (!next) close(); else setOpen(next); }}>
			<DialogContent size="xl" showCloseButton className="flex h-[min(720px,calc(100vh-64px))] max-w-[min(960px,calc(100vw-48px))] flex-col overflow-hidden p-0">
				<DialogHeader className="border-b border-border-subtle px-6 py-4 text-left">
					<DialogTitle className="flex items-center gap-2"><Lightbulb className="size-4 text-primary" />{t("projectIdeas.title")}</DialogTitle>
				</DialogHeader>
				<div className="flex min-h-0 flex-1">
					<section className="flex w-[38%] min-w-0 flex-col border-r border-border-subtle">
						<div className="flex flex-wrap gap-1 border-b border-border-subtle p-3">
							<Button type="button" size="sm" onClick={() => { setSelectedId(null); setEditing(true); setBodyPreview(false); setDraft(emptyDraft()); }}><Plus className="size-3.5" />{t("projectIdeas.new")}</Button>
							{(["active", ...STATUSES] as const).map((value) => <Button key={value} type="button" size="sm" variant={filter === value ? "secondary" : "ghost"} onClick={() => setFilter(value)}>{value === "active" ? t("projectIdeas.all") : statusLabel(value)}</Button>)}
						</div>
						<div className="min-h-0 flex-1 overflow-y-auto p-2">
							{visibleIdeas.length === 0 ? <p className="p-4 text-sm text-muted-foreground">{t("projectIdeas.empty")}</p> : visibleIdeas.map((idea) => <button key={idea.id} type="button" className={cn("mb-1 w-full rounded-md border border-transparent p-3 text-left hover:bg-muted", selectedId === idea.id && "border-border bg-muted")} onClick={() => { setSelectedId(idea.id); setEditing(false); setBodyPreview(true); }}><span className="block truncate text-sm font-medium">{idea.title}</span><span className="mt-1 block truncate text-xs text-muted-foreground">{statusLabel(idea.status)} · {idea.body || t("projectIdeas.noBody")}</span></button>)}
						</div>
					</section>
					<section className="min-w-0 flex-1 overflow-y-auto p-6">
						{(selected || editing) ? <div className="flex h-full flex-col gap-4">
							<div className="flex items-center justify-between gap-2"><h3 className="truncate text-base font-semibold">{selected ? t("projectIdeas.edit") : t("projectIdeas.new")}</h3><div className="flex items-center gap-1">{selected && <Button type="button" variant="ghost" size="sm" onClick={() => continueIdea(selected)}>{t("projectIdeas.continue")}</Button>}{selected && <Button type="button" variant="ghost" size="icon" aria-label={t("projectIdeas.delete")} onClick={() => setPendingDelete(selected)}><Trash2 className="size-4 text-destructive" /></Button>}</div></div>
							<Input value={draft.title} placeholder={t("projectIdeas.titlePlaceholder")} onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))} />
							<div className="flex min-h-48 flex-1 flex-col gap-2">
								<div className="flex items-center justify-between gap-2">
									<span className="text-xs text-muted-foreground">{t("projectIdeas.bodyHint")}</span>
									<Button type="button" size="sm" variant="ghost" onClick={() => setBodyPreview((current) => !current)} disabled={uploadingImage}>
										{bodyPreview ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
										{bodyPreview ? t("projectIdeas.editBody") : t("projectIdeas.previewBody")}
									</Button>
								</div>
								{bodyPreview ? (
									<div className="markdown-body min-h-48 flex-1 overflow-y-auto rounded-md border border-input px-3 py-2 text-sm">
										<MarkdownStream text={draft.body || t("projectIdeas.noBody")} light onOpenExternal={(url) => void desktopApi.app.openExternal(url, true)} />
									</div>
								) : (
									<div className="relative flex min-h-48 flex-1">
										<Textarea ref={bodyRef} className="min-h-48 flex-1 resize-none" value={draft.body} placeholder={t("projectIdeas.bodyPlaceholder")} onPaste={(event) => void handleBodyPaste(event)} onChange={(event) => setDraft((current) => ({ ...current, body: event.target.value }))} />
										{uploadingImage && <div className="pointer-events-none absolute right-3 top-3 inline-flex items-center gap-1 rounded bg-background/90 px-2 py-1 text-xs text-muted-foreground"><LoaderCircle className="size-3 animate-spin" />{t("projectIdeas.uploadingImage")}</div>}
									</div>
								)}
							</div>
							<Input value={draft.tags} placeholder={t("projectIdeas.tagsPlaceholder")} onChange={(event) => setDraft((current) => ({ ...current, tags: event.target.value }))} />
							{selected?.sourceKind && <p className="text-xs text-muted-foreground">{selected.sourceKind === "selection" ? t("projectIdeas.sourceSelection") : t("projectIdeas.sourceMessage")}{selected.sourceMessageId ? ` · ${selected.sourceMessageId}` : ""}</p>}
							{selected && <div className="flex flex-wrap gap-1">{STATUSES.map((status) => <Button key={status} type="button" size="sm" variant={selected.status === status ? "secondary" : "ghost"} onClick={() => void changeStatus(selected, status)}>{statusLabel(status)}</Button>)}</div>}
							<div className="flex justify-end gap-2"><Button type="button" variant="ghost" onClick={() => { setEditing(false); setBodyPreview(Boolean(selected)); if (selected) setDraft({ title: selected.title, body: selected.body, tags: selected.tags.join(", ") }); }}>{t("projectIdeas.cancel")}</Button><Button type="button" disabled={!draft.title.trim()} onClick={() => void (selected ? save() : createIdea())}>{t("projectIdeas.save")}</Button></div>
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
