import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FolderKanban, Lightbulb, Plus } from "lucide-react";
import { useAtomValue, useSetAtom } from "jotai";
import type { ProjectIdea } from "../../../../shared/types";
import {
	closeProjectIdeasModalAtom,
	openProjectIdeasModalAtom,
	projectIdeasModalOpenAtom,
	projectIdeasModalScopeAtom,
} from "../../atoms/project-idea-atoms";
import { projectInventoryAtom, replaceProjectInventoryAtom } from "../../atoms/project-atoms";
import { desktopApi } from "../../desktopApi";
import { t } from "../../i18n";
import { projectIdeaScopeWorkspaces } from "../../utils/projectIdeaScope";
import { loadProjectIdeaWorkspaces, projectIdeaOverviewIdeas, synchronizeProjectIdeaWorkspaces } from "../../utils/projectIdeaOverview";
import { Button } from "../ui-shadcn/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../ui-shadcn/dialog";
import { ProjectIdeaTree } from "./ProjectIdeaTree";
import { buildProjectIdeaHierarchy } from "../../utils/projectIdeaHierarchy";

/** Read-only project overview that keeps ideas grouped by their concrete workspace owner. */
export function ProjectIdeasOverview() {
	const modalOpen = useAtomValue(projectIdeasModalOpenAtom);
	const scope = useAtomValue(projectIdeasModalScopeAtom);
	const projects = useAtomValue(projectInventoryAtom);
	const replaceProjects = useSetAtom(replaceProjectInventoryAtom);
	const close = useSetAtom(closeProjectIdeasModalAtom);
	const openWorkspace = useSetAtom(openProjectIdeasModalAtom);
	const [resolvedScope, setResolvedScope] = useState<{ projectId: string; workspaces: typeof projects } | null>(null);
	const [ideasByWorkspace, setIdeasByWorkspace] = useState<Record<string, ProjectIdea[]>>({});
	const [errorsByWorkspace, setErrorsByWorkspace] = useState<Record<string, string>>({});
	const [overviewError, setOverviewError] = useState(false);
	// 打开后的首帧也必须保持加载态，直到 Git 工作区同步、稳定 ID 解析和想法读取全部完成。
	const [loading, setLoading] = useState(true);
	const requestRef = useRef(0);
	const cachedWorkspaces = useMemo(
		() => projectIdeaScopeWorkspaces(projects, scope?.kind === "project" ? scope : null),
		[projects, scope],
	);
	const scopeProjectId = scope?.kind === "project" ? scope.projectId : undefined;
	const openWorkspaceIdeas = useCallback((workspaceId: string, ideaId?: string) => {
		if (!scopeProjectId) return;
		openWorkspace({ kind: "workspace", workspaceId, ideaId, overviewProjectId: scopeProjectId });
	}, [openWorkspace, scopeProjectId]);
	const scopeResolved = Boolean(resolvedScope && resolvedScope.projectId === scopeProjectId);
	const workspaces = resolvedScope && resolvedScope.projectId === scopeProjectId
		? resolvedScope.workspaces
		: cachedWorkspaces;
	const open = modalOpen && scope?.kind === "project";
	const overviewReady = open && scopeResolved && !loading;

	const load = useCallback(async () => {
		if (!scope || scope.kind !== "project") return;
		const requestId = requestRef.current + 1;
		requestRef.current = requestId;
		setLoading(true);
		setOverviewError(false);
		let synchronized;
		try {
			synchronized = await synchronizeProjectIdeaWorkspaces(projects, scope, {
				listProjects: () => desktopApi.projects.list(),
				scanWorktrees: (rootProjectId) => desktopApi.git.worktreeList(rootProjectId),
			});
		} catch {
			if (requestRef.current !== requestId) return;
			setResolvedScope({ projectId: scope.projectId, workspaces: [] });
			setOverviewError(true);
			setLoading(false);
			return;
		}
		if (requestRef.current !== requestId) return;
		replaceProjects(synchronized.projects);
		setResolvedScope({ projectId: scope.projectId, workspaces: synchronized.workspaces });
		const results = await loadProjectIdeaWorkspaces(synchronized.workspaces, (workspaceId) => desktopApi.projects.ideas.list(workspaceId));
		if (requestRef.current !== requestId) return;
		setIdeasByWorkspace(Object.fromEntries(results.flatMap((result) => result.ideas ? [[result.workspaceId, result.ideas]] : [])));
		setErrorsByWorkspace(Object.fromEntries(results.flatMap((result) => result.error ? [[result.workspaceId, result.error]] : [])));
		setLoading(false);
	}, [projects, replaceProjects, scope]);

	useEffect(() => {
		if (!open || !scopeProjectId) {
			requestRef.current += 1;
			setResolvedScope(null);
			setIdeasByWorkspace({});
			setErrorsByWorkspace({});
			setOverviewError(false);
			setLoading(true);
			return;
		}
		void load();
		return () => {
			requestRef.current += 1;
		};
	// Only a scope transition starts discovery. Updating the shared project inventory
	// during this request must not recursively scan and reload the same overview.
	// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [open, scopeProjectId]);

	return (
		<Dialog open={open} onOpenChange={(next) => { if (!next) close(); }}>
			<DialogContent size="xl" showCloseButton className="flex h-[min(720px,calc(100vh-64px))] max-w-[min(960px,calc(100vw-48px))] flex-col overflow-hidden p-0">
				<DialogHeader className="border-b border-border-subtle px-6 py-4 text-left">
					<DialogTitle className="flex items-center gap-2"><FolderKanban className="size-4 text-primary" />{t("projectIdeas.projectOverviewTitle")}</DialogTitle>
					<p className="text-xs text-muted-foreground">{t("projectIdeas.projectOverviewHint")}</p>
				</DialogHeader>
				<div className="min-h-0 flex-1 overflow-y-auto p-5">
					{open && !overviewReady && <p className="py-8 text-center text-sm text-muted-foreground">{t("common.loading")}</p>}
					{overviewReady && overviewError && <div className="flex items-center justify-center gap-3 py-8 text-sm text-destructive"><span>{t("projectIdeas.overviewLoadFailed")}</span><Button type="button" size="sm" variant="outline" onClick={() => void load()}>{t("common.retry")}</Button></div>}
					{overviewReady && !overviewError && workspaces.map((workspace, index) => {
						const ideas = projectIdeaOverviewIdeas(ideasByWorkspace[workspace.id] ?? []);
						const hierarchy = buildProjectIdeaHierarchy(ideas, "all");
						const loadError = errorsByWorkspace[workspace.id];
						return (
							<section key={workspace.id} className="mb-5 overflow-hidden rounded-xl border border-border bg-card shadow-sm">
								<header className="flex items-center justify-between gap-3 border-b border-border-subtle bg-muted/30 px-4 py-3">
									<div className="min-w-0">
										<h3 className="truncate text-sm font-semibold">{index === 0 ? t("app.worktreeMainWorkspace") : workspace.name}</h3>
										<p className="truncate text-xs text-muted-foreground">{workspace.path}{loadError ? "" : ` · ${t("projectIdeas.ideaCount", { count: String(ideas.length) })}`}</p>
									</div>
									<Button type="button" size="sm" variant="outline" onClick={() => openWorkspaceIdeas(workspace.id)}><Plus className="size-3.5" />{t("projectIdeas.manageWorkspace")}</Button>
								</header>
								{loadError ? (
									<div className="flex items-center justify-between gap-3 px-4 py-6 text-sm text-destructive"><span>{t("projectIdeas.workspaceLoadFailed")}</span><Button type="button" size="sm" variant="outline" onClick={() => void load()}>{t("common.retry")}</Button></div>
								) : ideas.length === 0 ? (
									<button type="button" className="flex w-full items-center justify-center gap-2 px-4 py-8 text-sm text-muted-foreground hover:bg-muted/40 hover:text-foreground" onClick={() => openWorkspaceIdeas(workspace.id)}><Lightbulb className="size-4" />{t("projectIdeas.workspaceEmpty")}</button>
								) : (
									<div className="p-3"><ProjectIdeaTree roots={hierarchy} selectedId={null} kindLabel={(kind) => t(kind === "brainstorm" ? "projectIdeas.kind.brainstorm" : "projectIdeas.kind.implementation")} onSelect={(idea) => openWorkspaceIdeas(workspace.id, idea.id)} /></div>
								)}
							</section>
						);
					})}
					{overviewReady && !overviewError && workspaces.length === 0 && <p className="py-8 text-center text-sm text-muted-foreground">{t("projectIdeas.noWorkspaces")}</p>}
				</div>
			</DialogContent>
		</Dialog>
	);
}
